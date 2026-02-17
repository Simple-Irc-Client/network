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

/** Maximum receive buffer size before dropping the connection (2MB) */
const MAX_RECEIVE_BUFFER_SIZE = 2 * 1024 * 1024;

/**
 * Base socket connection options
 */
interface SocketConnectionOptions {
  host: string;
  port: number;
  encoding?: BufferEncoding;
  tls?: boolean;
  ping_interval?: number;
  ping_timeout?: number;
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

export class Client extends EventEmitter {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private options: SocketConnectionOptions | null = null;
  private receiveBuffer = Buffer.alloc(0);
  private encoding: BufferEncoding = 'utf8';
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pingTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Connect to IRC server with auto-registration (sends CAP/NICK/USER)
   */
  connect(options: IrcClientOptions): void {
    this.options = options;
    this.encoding = options.encoding ?? 'utf8';
    this.receiveBuffer = Buffer.alloc(0);

    this.createSocket(options);

    if (this.socket) {
      this.socket.on('data', (data: Buffer) => this.onData(data));
      this.socket.on('close', () => this.onSocketClose());
      this.socket.on('error', (error: Error) => this.onSocketError(error));
    }
  }

  /**
   * Connect to IRC server in raw mode (client handles registration)
   */
  connectRaw(options: IrcRawConnectionOptions): void {
    this.options = options;
    this.encoding = options.encoding ?? 'utf8';
    this.receiveBuffer = Buffer.alloc(0);

    this.createSocket(options);

    if (this.socket) {
      this.socket.on('data', (data: Buffer) => this.onData(data));
      this.socket.on('close', () => this.onSocketClose());
      this.socket.on('error', (error: Error) => this.onSocketError(error));
    }
  }

  private createSocket(options: SocketConnectionOptions): void {
    const connectOptions = {
      host: options.host,
      port: options.port,
    };

    if (options.tls) {
      this.socket = tls.connect(connectOptions, () => this.onSocketConnect());
    } else {
      this.socket = net.connect(connectOptions, () => this.onSocketConnect());
    }
  }

  private onSocketConnect(): void {
    // Only send registration if this is a full connection (has nick)
    const fullOptions = this.options as IrcClientOptions;
    if (fullOptions?.nick) {
      // Send CAP LS 302 to initiate capability negotiation (IRCv3)
      // This must be sent before NICK/USER for proper cap negotiation
      this.sendRaw('CAP LS 302');
      this.sendRaw(`NICK ${fullOptions.nick}`);
      this.sendRaw(`USER ${fullOptions.username} 0 * :${fullOptions.gecos}`);
    }

    this.startPingInterval();
  }

  private onData(data: Buffer): void {
    this.resetPingTimeout();
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

    let lineEndIndex: number;
    while ((lineEndIndex = this.receiveBuffer.indexOf('\r\n')) !== -1) {
      const line = this.receiveBuffer.subarray(0, lineEndIndex).toString(this.encoding);
      this.receiveBuffer = this.receiveBuffer.subarray(lineEndIndex + 2);

      if (line.length > 0) {
        this.emit('raw', { line, from_server: true });

        // Handle PING automatically
        if (line.startsWith('PING ')) {
          const pingArg = line.substring(5);
          this.sendRaw(`PONG ${pingArg}`);
        }

        // Emit connected on RPL_WELCOME (001)
        if (RPL_WELCOME_PATTERN.test(line)) {
          this.emit('connected', {});
        }
      }
    }

    if (this.receiveBuffer.length > MAX_RECEIVE_BUFFER_SIZE) {
      this.socket?.destroy(new Error('Receive buffer overflow'));
    }
  }

  private sendRaw(line: string): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${line.replace(/[\r\n]/g, '')}\r\n`);
      this.emit('raw', { line, from_server: false });
    }
  }

  private onSocketClose(): void {
    this.cleanup();
    this.emit('socket close', {});
    this.emit('close', {});
  }

  private onSocketError(error: Error): void {
    if (process.env.NODE_ENV !== 'production') {
      console.error(`IRC socket error: ${error.message}`);
    }
    this.emit('error', error);
  }

  private startPingInterval(): void {
    const interval = (this.options?.ping_interval ?? 30) * 1000;
    this.pingInterval = setInterval(() => {
      if (this.socket && !this.socket.destroyed) {
        this.sendRaw(`PING :${Date.now()}`);
      }
    }, interval);
  }

  private resetPingTimeout(): void {
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
    }

    const timeout = (this.options?.ping_timeout ?? 120) * 1000;
    this.pingTimeout = setTimeout(() => {
      if (process.env.NODE_ENV !== 'production') {
        console.error('IRC ping timeout - disconnecting');
      }
      this.socket?.destroy();
    }, timeout);
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
    this.socket = null;
  }

  quit(message?: string): void {
    if (this.socket && !this.socket.destroyed) {
      const quitMsg = message ? `QUIT :${message}` : 'QUIT';
      this.sendRaw(quitMsg);
      this.socket.end();
    }
    this.cleanup();
  }

  raw(data: string | string[]): void {
    let line: string;
    if (Array.isArray(data)) {
      line = data.join(' ');
    } else {
      line = data;
    }
    this.sendRaw(line);
  }
}
