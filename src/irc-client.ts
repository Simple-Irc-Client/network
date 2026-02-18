import { EventEmitter } from 'events';
import * as net from 'net';
import * as tls from 'tls';

/**
 * Pattern to match RPL_WELCOME (001) from a server
 *
 * - Optional IRCv3 message tags (@key=value;... ) at the start
 * - Server prefix starting with :
 * - Source must not contain ! or @ (those indicate a user hostmask)
 * - Command must be exactly 001
 */
const RPL_WELCOME_PATTERN = /^(@\S+ )?:[^\s!@]+ 001 /;

/** IRC line terminator */
const IRC_LINE_ENDING = '\r\n';

/** Maximum receive buffer size before dropping the connection (2MB) */
const MAX_RECEIVE_BUFFER_SIZE = 2 * 1024 * 1024;

/** Interval for sending PING keepalive messages (30 seconds) */
const PING_INTERVAL_MS = 30000;

/** Timeout for TCP/TLS connection establishment (30 seconds) */
const CONNECTION_TIMEOUT_MS = 30000;

/** Default timeout for receiving server response after sending PING (120 seconds) */
const DEFAULT_PONG_TIMEOUT_MS = 120000;

/** Strip CR/LF to prevent IRC line injection */
const stripCRLF = (input: string): string => input.replace(/[\r\n]/g, '');

/**
 * Base socket connection options
 */
interface SocketConnectionOptions {
  host: string;
  port: number;
  encoding?: BufferEncoding;
  tls?: boolean;
  /** Timeout in seconds for server to respond after PING (default: 120) */
  pongTimeout?: number;
}

/**
 * Options for full IRC connection with auto-registration
 */
export interface IrcClientOptions extends SocketConnectionOptions {
  nick: string;
  username: string;
  gecos: string;
}

/**
 * Options for raw connection (client handles registration)
 */
export type IrcRawConnectionOptions = SocketConnectionOptions;

export class IrcClient extends EventEmitter {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private receiveBuffer = Buffer.alloc(0);
  private characterEncoding: BufferEncoding = 'utf8';
  private pingIntervalTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimeoutMs = DEFAULT_PONG_TIMEOUT_MS;

  /**
   * Check if the connection is currently active and writable
   */
  get connected(): boolean {
    return this.socket?.writable ?? false;
  }

  /**
   * Connect to IRC server with auto-registration (sends CAP/NICK/USER)
   */
  connect(options: IrcClientOptions): void {
    // Clean up any existing connection
    this.destroy();

    this.characterEncoding = options.encoding ?? 'utf8';
    this.receiveBuffer = Buffer.alloc(0);
    this.pongTimeoutMs = (options.pongTimeout ?? 120) * 1000;

    const socket = this.createSocket(options);
    this.socket = socket;

    socket.once('connect', () => {
      this.handleSocketConnected(options);
    });

    socket.on('data', (data: Buffer) => this.handleIncomingData(data));
    socket.on('close', () => this.handleSocketClosed());
    socket.on('error', (error: Error) => this.emit('error', error));
  }

  /**
   * Connect to IRC server in raw mode (client handles registration)
   */
  connectRaw(options: IrcRawConnectionOptions): void {
    // Clean up any existing connection
    this.destroy();

    this.characterEncoding = options.encoding ?? 'utf8';
    this.receiveBuffer = Buffer.alloc(0);
    this.pongTimeoutMs = (options.pongTimeout ?? 120) * 1000;

    const socket = this.createSocket(options);
    this.socket = socket;

    socket.once('connect', () => {
      this.handleRawSocketConnected(options);
    });

    socket.on('data', (data: Buffer) => this.handleIncomingData(data));
    socket.on('close', () => this.handleSocketClosed());
    socket.on('error', (error: Error) => this.emit('error', error));
  }

  private createSocket(options: SocketConnectionOptions): net.Socket | tls.TLSSocket {
    const connectionConfig = {
      host: options.host,
      port: options.port,
    };

    let socket: net.Socket | tls.TLSSocket;

    if (options.tls) {
      socket = tls.connect({
        ...connectionConfig,
        rejectUnauthorized: true,
      });
    } else {
      socket = net.connect(connectionConfig);
    }

    // Connection establishment timeout — destroy socket if handshake
    // doesn't complete within the allowed time
    socket.setTimeout(CONNECTION_TIMEOUT_MS);
    socket.once('timeout', () => {
      socket.destroy(new Error('Connection timed out'));
    });

    return socket;
  }

  private handleSocketConnected(options: IrcClientOptions): void {
    // Handshake succeeded — disable the connection establishment timeout
    this.socket?.setTimeout(0);

    this.emit('socket connected');

    this.send('CAP LS 302');
    this.send(`NICK ${stripCRLF(options.nick)}`);
    this.send(`USER ${stripCRLF(options.username)} 0 * :${stripCRLF(options.gecos)}`);

    this.startPingTimer();
  }

  private handleRawSocketConnected(options: IrcRawConnectionOptions): void {
    // Handshake succeeded — disable the connection establishment timeout
    this.socket?.setTimeout(0);

    this.emit('socket connected');

    this.startPingTimer();
  }

  private handleIncomingData(data: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

    let lineEndIndex: number;
    while ((lineEndIndex = this.receiveBuffer.indexOf(IRC_LINE_ENDING)) !== -1) {
      const line = this.receiveBuffer.subarray(0, lineEndIndex).toString(this.characterEncoding);
      this.receiveBuffer = this.receiveBuffer.subarray(lineEndIndex + 2);

      if (line.length > 0) {
        this.handleIrcLine(line);
      }
    }

    if (this.receiveBuffer.length > MAX_RECEIVE_BUFFER_SIZE) {
      this.socket?.destroy(new Error('Receive buffer overflow'));
    }
  }

  private handleIrcLine(line: string): void {
    // Any data from server proves it's alive — clear the PONG timeout
    this.clearPongTimeout();

    this.emit('raw', line, true);

    // Handle PING automatically
    if (line.startsWith('PING ')) {
      const pingData = line.slice(5);
      this.send(`PONG ${pingData}`);
    } else if (RPL_WELCOME_PATTERN.test(line)) {
      this.emit('connected');
    }
  }

  send(line: string): void {
    if (this.socket?.writable) {
      this.socket.write(`${stripCRLF(line)}${IRC_LINE_ENDING}`);
      this.emit('raw', line, false);
    }
  }

  private handleSocketClosed(): void {
    this.stopPingTimer();
    this.emit('close');
  }

  private startPingTimer(): void {
    this.pingIntervalTimer = setInterval(() => {
      this.send(`PING :${Date.now()}`);

      // Start a PONG timeout — if the server doesn't send anything
      // before this fires, consider the connection dead
      this.clearPongTimeout();
      this.pongTimeoutTimer = setTimeout(() => {
        this.socket?.destroy(new Error('PONG timeout: server unresponsive'));
      }, this.pongTimeoutMs);
    }, PING_INTERVAL_MS);
  }

  private clearPongTimeout(): void {
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
  }

  private stopPingTimer(): void {
    if (this.pingIntervalTimer) {
      clearInterval(this.pingIntervalTimer);
      this.pingIntervalTimer = null;
    }
    this.clearPongTimeout();
  }

  quit(message?: string): void {
    if (this.socket?.writable) {
      const quitMsg = message ? `QUIT :${message}` : 'QUIT';
      this.send(quitMsg);
      this.socket.end();
    }
    this.stopPingTimer();
  }

  destroy(): void {
    this.stopPingTimer();

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}
