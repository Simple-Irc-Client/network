import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Create mock socket instance
const createMockSocket = () => {
  const socket = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    setEncoding: ReturnType<typeof vi.fn>;
    destroyed: boolean;
  };
  socket.write = vi.fn();
  socket.end = vi.fn();
  socket.destroy = vi.fn();
  socket.setEncoding = vi.fn();
  socket.destroyed = false;
  return socket;
};

let mockSocket: ReturnType<typeof createMockSocket>;
let connectCallback: (() => void) | null = null;

// Mock net module
vi.mock('net', () => ({
  connect: vi.fn((options: unknown, callback: () => void) => {
    connectCallback = callback;
    return mockSocket;
  }),
}));

// Mock tls module
vi.mock('tls', () => ({
  connect: vi.fn((options: unknown, callback: () => void) => {
    connectCallback = callback;
    return mockSocket;
  }),
}));

// Mock console to avoid noise
vi.spyOn(console, 'error').mockImplementation(() => undefined);

import { Client } from '../irc-client.js';
import type { IrcClientOptions } from '../irc-client.js';
import * as net from 'net';
import * as tls from 'tls';

describe('Client', () => {
  const defaultOptions: IrcClientOptions = {
    host: 'irc.example.com',
    port: 6667,
    nick: 'testuser',
    username: 'testuser',
    gecos: 'Test User',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSocket = createMockSocket();
    connectCallback = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('connect', () => {
    it('should connect using net.connect for non-TLS connections', () => {
      const client = new Client();
      client.connect(defaultOptions);

      expect(net.connect).toHaveBeenCalledWith(
        { host: 'irc.example.com', port: 6667 },
        expect.any(Function)
      );
      expect(tls.connect).not.toHaveBeenCalled();
    });

    it('should connect using tls.connect for TLS connections', () => {
      const client = new Client();
      client.connect({ ...defaultOptions, tls: true });

      expect(tls.connect).toHaveBeenCalledWith(
        { host: 'irc.example.com', port: 6667 },
        expect.any(Function)
      );
    });

    it('should set encoding to utf8 by default', () => {
      const client = new Client();
      client.connect(defaultOptions);

      expect(mockSocket.setEncoding).toHaveBeenCalledWith('utf8');
    });

    it('should use custom encoding when specified', () => {
      const client = new Client();
      client.connect({ ...defaultOptions, encoding: 'latin1' });

      expect(mockSocket.setEncoding).toHaveBeenCalledWith('latin1');
    });

    it('should emit socket connected event on connect', () => {
      const client = new Client();
      const socketConnectedHandler = vi.fn();
      client.on('socket connected', socketConnectedHandler);

      client.connect(defaultOptions);
      connectCallback?.();

      expect(socketConnectedHandler).toHaveBeenCalledWith({});
    });

    it('should send CAP LS 302, NICK and USER commands on connect', () => {
      const client = new Client();
      client.connect(defaultOptions);
      connectCallback?.();

      expect(mockSocket.write).toHaveBeenCalledWith('CAP LS 302\r\n');
      expect(mockSocket.write).toHaveBeenCalledWith('NICK testuser\r\n');
      expect(mockSocket.write).toHaveBeenCalledWith('USER testuser 0 * :Test User\r\n');
    });

    it('should emit raw events for sent commands', () => {
      const client = new Client();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      client.connect(defaultOptions);
      connectCallback?.();

      expect(rawHandler).toHaveBeenCalledWith({ line: 'CAP LS 302', from_server: false });
      expect(rawHandler).toHaveBeenCalledWith({ line: 'NICK testuser', from_server: false });
      expect(rawHandler).toHaveBeenCalledWith({
        line: 'USER testuser 0 * :Test User',
        from_server: false,
      });
    });
  });

  describe('data handling', () => {
    it('should emit raw events for received data', () => {
      const client = new Client();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      client.connect(defaultOptions);
      connectCallback?.();
      rawHandler.mockClear();

      mockSocket.emit('data', ':server.test NOTICE * :Welcome\r\n');

      expect(rawHandler).toHaveBeenCalledWith({
        line: ':server.test NOTICE * :Welcome',
        from_server: true,
      });
    });

    it('should handle multiple lines in one data chunk', () => {
      const client = new Client();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      client.connect(defaultOptions);
      connectCallback?.();
      rawHandler.mockClear();

      mockSocket.emit('data', ':server NOTICE * :Line1\r\n:server NOTICE * :Line2\r\n');

      expect(rawHandler).toHaveBeenCalledTimes(2);
      expect(rawHandler).toHaveBeenCalledWith({
        line: ':server NOTICE * :Line1',
        from_server: true,
      });
      expect(rawHandler).toHaveBeenCalledWith({
        line: ':server NOTICE * :Line2',
        from_server: true,
      });
    });

    it('should buffer incomplete lines', () => {
      const client = new Client();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      client.connect(defaultOptions);
      connectCallback?.();
      rawHandler.mockClear();

      // Send partial data
      mockSocket.emit('data', ':server NOTICE * :Part');
      expect(rawHandler).not.toHaveBeenCalled();

      // Complete the line
      mockSocket.emit('data', 'ial message\r\n');
      expect(rawHandler).toHaveBeenCalledWith({
        line: ':server NOTICE * :Partial message',
        from_server: true,
      });
    });

    it('should respond to PING with PONG', () => {
      const client = new Client();
      client.connect(defaultOptions);
      connectCallback?.();
      mockSocket.write.mockClear();

      mockSocket.emit('data', 'PING :server.test\r\n');

      expect(mockSocket.write).toHaveBeenCalledWith('PONG :server.test\r\n');
    });

    it('should emit connected event on RPL_WELCOME (001)', () => {
      const client = new Client();
      const connectedHandler = vi.fn();
      client.on('connected', connectedHandler);

      client.connect(defaultOptions);
      connectCallback?.();

      mockSocket.emit('data', ':server 001 testuser :Welcome to the IRC Network\r\n');

      expect(connectedHandler).toHaveBeenCalledWith({});
    });

    it('should ignore empty lines', () => {
      const client = new Client();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      client.connect(defaultOptions);
      connectCallback?.();
      rawHandler.mockClear();

      mockSocket.emit('data', '\r\n\r\n:server NOTICE * :Hello\r\n\r\n');

      expect(rawHandler).toHaveBeenCalledTimes(1);
      expect(rawHandler).toHaveBeenCalledWith({
        line: ':server NOTICE * :Hello',
        from_server: true,
      });
    });
  });

  describe('ping/pong mechanism', () => {
    it('should send PING at configured interval', () => {
      const client = new Client();
      client.connect({ ...defaultOptions, ping_interval: 60 });
      connectCallback?.();
      mockSocket.write.mockClear();

      vi.advanceTimersByTime(60000);

      expect(mockSocket.write).toHaveBeenCalledWith(expect.stringMatching(/^PING :\d+\r\n$/));
    });

    it('should use default 30 second ping interval', () => {
      const client = new Client();
      client.connect(defaultOptions);
      connectCallback?.();
      mockSocket.write.mockClear();

      vi.advanceTimersByTime(30000);

      expect(mockSocket.write).toHaveBeenCalledWith(expect.stringMatching(/^PING :\d+\r\n$/));
    });

    it('should destroy socket on ping timeout', () => {
      const client = new Client();
      client.connect({ ...defaultOptions, ping_timeout: 60 });
      connectCallback?.();

      // Ping timeout starts on first data received
      mockSocket.emit('data', ':server NOTICE * :test\r\n');

      vi.advanceTimersByTime(60000);

      expect(mockSocket.destroy).toHaveBeenCalled();
    });

    it('should use default 120 second ping timeout', () => {
      const client = new Client();
      client.connect(defaultOptions);
      connectCallback?.();

      // Ping timeout starts on first data received
      mockSocket.emit('data', ':server NOTICE * :test\r\n');

      vi.advanceTimersByTime(119000);
      expect(mockSocket.destroy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(mockSocket.destroy).toHaveBeenCalled();
    });

    it('should reset ping timeout on receiving data', () => {
      const client = new Client();
      client.connect({ ...defaultOptions, ping_timeout: 60 });
      connectCallback?.();

      // Wait 50 seconds
      vi.advanceTimersByTime(50000);
      expect(mockSocket.destroy).not.toHaveBeenCalled();

      // Receive data - should reset timeout
      mockSocket.emit('data', ':server NOTICE * :test\r\n');

      // Wait another 50 seconds
      vi.advanceTimersByTime(50000);
      expect(mockSocket.destroy).not.toHaveBeenCalled();

      // Wait 10 more seconds (total 60 from last data)
      vi.advanceTimersByTime(10000);
      expect(mockSocket.destroy).toHaveBeenCalled();
    });
  });

  describe('socket events', () => {
    it('should emit close event on socket close', () => {
      const client = new Client();
      const closeHandler = vi.fn();
      const socketCloseHandler = vi.fn();
      client.on('close', closeHandler);
      client.on('socket close', socketCloseHandler);

      client.connect(defaultOptions);
      connectCallback?.();

      mockSocket.emit('close');

      expect(closeHandler).toHaveBeenCalledWith({});
      expect(socketCloseHandler).toHaveBeenCalledWith({});
    });

    it('should cleanup timers on socket close', () => {
      const client = new Client();
      client.connect(defaultOptions);
      connectCallback?.();

      mockSocket.emit('close');

      // After cleanup, advancing timers should not cause any socket operations
      mockSocket.write.mockClear();
      vi.advanceTimersByTime(200000);

      // Only the calls before close should be present
      expect(mockSocket.write).not.toHaveBeenCalled();
    });

    it('should log error on socket error', () => {
      const client = new Client();
      client.connect(defaultOptions);
      connectCallback?.();

      const error = new Error('Connection reset');
      mockSocket.emit('error', error);

      expect(console.error).toHaveBeenCalledWith('IRC socket error: Connection reset');
    });
  });

  describe('quit', () => {
    it('should send QUIT with message and end socket', () => {
      const client = new Client();
      client.connect(defaultOptions);
      connectCallback?.();
      mockSocket.write.mockClear();

      client.quit('Goodbye!');

      expect(mockSocket.write).toHaveBeenCalledWith('QUIT :Goodbye!\r\n');
      expect(mockSocket.end).toHaveBeenCalled();
    });

    it('should send QUIT without message when not provided', () => {
      const client = new Client();
      client.connect(defaultOptions);
      connectCallback?.();
      mockSocket.write.mockClear();

      client.quit();

      expect(mockSocket.write).toHaveBeenCalledWith('QUIT\r\n');
      expect(mockSocket.end).toHaveBeenCalled();
    });

    it('should not send QUIT if socket is destroyed', () => {
      const client = new Client();
      client.connect(defaultOptions);
      connectCallback?.();
      mockSocket.destroyed = true;
      mockSocket.write.mockClear();

      client.quit('Goodbye');

      expect(mockSocket.write).not.toHaveBeenCalled();
      expect(mockSocket.end).not.toHaveBeenCalled();
    });

    it('should cleanup timers on quit', () => {
      const client = new Client();
      client.connect(defaultOptions);
      connectCallback?.();

      client.quit();

      // After cleanup, advancing timers should not cause any socket operations
      mockSocket.write.mockClear();
      vi.advanceTimersByTime(200000);

      expect(mockSocket.write).not.toHaveBeenCalled();
    });

    it('should be safe to call quit before connect', () => {
      const client = new Client();

      expect(() => client.quit()).not.toThrow();
    });
  });

  describe('raw', () => {
    it('should send string data as-is', () => {
      const client = new Client();
      client.connect(defaultOptions);
      connectCallback?.();
      mockSocket.write.mockClear();

      client.raw('PRIVMSG #channel :Hello world');

      expect(mockSocket.write).toHaveBeenCalledWith('PRIVMSG #channel :Hello world\r\n');
    });

    it('should join array data with spaces', () => {
      const client = new Client();
      client.connect(defaultOptions);
      connectCallback?.();
      mockSocket.write.mockClear();

      client.raw(['PRIVMSG', '#channel', ':Hello world']);

      expect(mockSocket.write).toHaveBeenCalledWith('PRIVMSG #channel :Hello world\r\n');
    });

    it('should emit raw event for sent data', () => {
      const client = new Client();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      client.connect(defaultOptions);
      connectCallback?.();
      rawHandler.mockClear();

      client.raw('JOIN #test');

      expect(rawHandler).toHaveBeenCalledWith({ line: 'JOIN #test', from_server: false });
    });

    it('should not send if socket is destroyed', () => {
      const client = new Client();
      client.connect(defaultOptions);
      connectCallback?.();
      mockSocket.destroyed = true;
      mockSocket.write.mockClear();

      client.raw('TEST');

      expect(mockSocket.write).not.toHaveBeenCalled();
    });

    it('should not send if not connected', () => {
      const client = new Client();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      client.raw('TEST');

      expect(rawHandler).not.toHaveBeenCalled();
    });
  });

  describe('buffer clearing on reconnect', () => {
    it('should clear buffer when connecting', () => {
      const client = new Client();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      // First connection with incomplete data
      client.connect(defaultOptions);
      connectCallback?.();
      rawHandler.mockClear();
      mockSocket.emit('data', ':server NOTICE * :Incomplete');

      // Reconnect - buffer should be cleared
      mockSocket = createMockSocket();
      client.connect(defaultOptions);
      connectCallback?.();
      rawHandler.mockClear();

      // New complete message should work
      mockSocket.emit('data', ':server NOTICE * :New message\r\n');

      expect(rawHandler).toHaveBeenCalledWith({
        line: ':server NOTICE * :New message',
        from_server: true,
      });
      // Should NOT contain the old incomplete data
      expect(rawHandler).not.toHaveBeenCalledWith(
        expect.objectContaining({ line: expect.stringContaining('Incomplete') })
      );
    });
  });
});
