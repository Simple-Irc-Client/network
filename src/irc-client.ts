import { EventEmitter } from 'events';
import * as net from 'net';
import * as tls from 'tls';

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
  private buffer = '';
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pingTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Connect to IRC server with auto-registration (sends CAP/NICK/USER)
   */
  connect(options: IrcClientOptions): void {
    this.options = options;
    this.buffer = '';

    this.createSocket(options);

    if (this.socket) {
      this.socket.on('data', (data: string) => this.onData(data));
      this.socket.on('close', () => this.onSocketClose());
      this.socket.on('error', (error: Error) => this.onSocketError(error));
    }
  }

  /**
   * Connect to IRC server in raw mode (client handles registration)
   */
  connectRaw(options: IrcRawConnectionOptions): void {
    this.options = options;
    this.buffer = '';

    this.createSocket(options);

    if (this.socket) {
      this.socket.on('data', (data: string) => this.onData(data));
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

    this.socket.setEncoding(options.encoding ?? 'utf8');
  }

  private onSocketConnect(): void {
    this.emit('socket connected', {});

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

  private onData(data: string): void {
    this.resetPingTimeout();
    this.buffer += data;

    const lines = this.buffer.split('\r\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.length > 0) {
        this.emit('raw', { line, from_server: true });

        // Handle PING automatically
        if (line.startsWith('PING ')) {
          const pingArg = line.substring(5);
          this.sendRaw(`PONG ${pingArg}`);
        }

        // Emit connected on RPL_WELCOME (001)
        if (line.includes(' 001 ')) {
          this.emit('connected', {});
        }
      }
    }
  }

  private sendRaw(line: string): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${line}\r\n`);
      this.emit('raw', { line, from_server: false });
    }
  }

  private onSocketClose(): void {
    this.cleanup();
    this.emit('socket close', {});
    this.emit('close', {});
  }

  private onSocketError(error: Error): void {
    console.error(`IRC socket error: ${error.message}`);
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
      console.error('IRC ping timeout - disconnecting');
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
