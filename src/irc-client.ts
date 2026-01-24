import { EventEmitter } from 'events';
import * as net from 'net';
import * as tls from 'tls';

export interface IrcClientOptions {
  host: string;
  port: number;
  nick: string;
  username: string;
  gecos: string;
  encoding?: BufferEncoding;
  tls?: boolean;
  ping_interval?: number;
  ping_timeout?: number;
}

export class Client extends EventEmitter {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private options: IrcClientOptions | null = null;
  private buffer = '';
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pingTimeout: ReturnType<typeof setTimeout> | null = null;

  connect(options: IrcClientOptions): void {
    this.options = options;
    this.buffer = '';

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

    this.socket.on('data', (data: string) => this.onData(data));
    this.socket.on('close', () => this.onSocketClose());
    this.socket.on('error', (error: Error) => this.onSocketError(error));
  }

  private onSocketConnect(): void {
    this.emit('socket connected', {});

    if (this.options) {
      this.sendRaw(`NICK ${this.options.nick}`);
      this.sendRaw(`USER ${this.options.username} 0 * :${this.options.gecos}`);
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
          this.emit('connected', { nick: this.options?.nick });
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
