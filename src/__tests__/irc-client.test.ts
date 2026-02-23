import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Create mock socket instance
const createMockSocket = () => {
  const socket = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    setEncoding: ReturnType<typeof vi.fn>;
    setTimeout: ReturnType<typeof vi.fn>;
    destroyed: boolean;
    writable: boolean;
  };
  socket.write = vi.fn();
  socket.end = vi.fn();
  socket.destroy = vi.fn();
  socket.setEncoding = vi.fn();
  socket.setTimeout = vi.fn();
  socket.destroyed = false;
  socket.writable = true;
  return socket;
};

let mockSocket: ReturnType<typeof createMockSocket>;

// Mock net module
vi.mock('net', () => ({
  connect: vi.fn(() => {
    return mockSocket;
  }),
}));

// Mock tls module
vi.mock('tls', () => ({
  connect: vi.fn(() => {
    return mockSocket;
  }),
}));

// Mock console to avoid noise
vi.spyOn(console, 'error').mockImplementation(() => undefined);

import { IrcClient } from '../irc-client.js';
import type { IrcClientOptions } from '../irc-client.js';
import * as net from 'net';
import * as tls from 'tls';

describe('IrcClient', () => {
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('connect', () => {
    it('should connect using net.connect for non-TLS connections', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);

      expect(net.connect).toHaveBeenCalledWith(
        { host: 'irc.example.com', port: 6667 }
      );
      expect(tls.connect).not.toHaveBeenCalled();
    });

    it('should connect using tls.connect for TLS connections with rejectUnauthorized', () => {
      const client = new IrcClient();
      client.connect({ ...defaultOptions, tls: true });

      expect(tls.connect).toHaveBeenCalledWith(
        { host: 'irc.example.com', port: 6667, rejectUnauthorized: true }
      );
    });

    it('should emit socket connected event on connect', () => {
      const client = new IrcClient();
      const socketConnectedHandler = vi.fn();
      client.on('socket connected', socketConnectedHandler);

      client.connect(defaultOptions);
      mockSocket.emit('connect');

      expect(socketConnectedHandler).toHaveBeenCalledWith();
    });

    it('should send CAP LS 302, NICK and USER commands on connect', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');

      expect(mockSocket.write).toHaveBeenCalledWith('CAP LS 302\r\n');
      expect(mockSocket.write).toHaveBeenCalledWith('NICK testuser\r\n');
      expect(mockSocket.write).toHaveBeenCalledWith('USER testuser 0 * :Test User\r\n');
    });

    it('should emit raw events for sent commands', () => {
      const client = new IrcClient();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      client.connect(defaultOptions);
      mockSocket.emit('connect');

      expect(rawHandler).toHaveBeenCalledWith('CAP LS 302', false);
      expect(rawHandler).toHaveBeenCalledWith('NICK testuser', false);
      expect(rawHandler).toHaveBeenCalledWith(
        'USER testuser 0 * :Test User',
        false,
      );
    });

    it('should send CAP LS 302 after connect and receive server CAP response', () => {
      const client = new IrcClient();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      client.connect(defaultOptions);
      mockSocket.emit('connect');

      // Verify CAP LS 302 was sent as the first registration command
      expect(mockSocket.write).toHaveBeenCalledWith('CAP LS 302\r\n');
      expect(rawHandler).toHaveBeenCalledWith('CAP LS 302', false);

      rawHandler.mockClear();

      // Server responds with multiline CAP LS (302 style with * continuation)
      mockSocket.emit('data', Buffer.from(
        'CAP * LS * :message-tags server-time batch\r\n'
        + 'CAP * LS :standard-replies labeled-response\r\n'
      ));

      // Both CAP LS response lines should be emitted as raw server events
      expect(rawHandler).toHaveBeenCalledTimes(2);
      expect(rawHandler).toHaveBeenCalledWith(
        'CAP * LS * :message-tags server-time batch',
        true,
      );
      expect(rawHandler).toHaveBeenCalledWith(
        'CAP * LS :standard-replies labeled-response',
        true,
      );
    });

    it('should retry CAP LS 302 if no CAP response within timeout', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');

      // Initial CAP LS 302 sent on connect
      expect(mockSocket.write).toHaveBeenCalledWith('CAP LS 302\r\n');
      const initialCallCount = mockSocket.write.mock.calls.filter(
        (c: unknown[]) => c[0] === 'CAP LS 302\r\n'
      ).length;
      expect(initialCallCount).toBe(1);

      // No CAP response — advance past the 10s timeout
      vi.advanceTimersByTime(10000);

      // Should have retried CAP LS 302
      const retryCallCount = mockSocket.write.mock.calls.filter(
        (c: unknown[]) => c[0] === 'CAP LS 302\r\n'
      ).length;
      expect(retryCallCount).toBe(2);
    });

    it('should not retry CAP LS 302 after receiving CAP response', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');
      mockSocket.write.mockClear();

      // Server responds with CAP LS
      mockSocket.emit('data', Buffer.from('CAP * LS :multi-prefix\r\n'));

      // Advance past timeout — should NOT retry
      vi.advanceTimersByTime(10000);

      // Only PING should appear, no extra CAP LS 302
      const capCalls = mockSocket.write.mock.calls.filter(
        (c: unknown[]) => c[0] === 'CAP LS 302\r\n'
      );
      expect(capCalls.length).toBe(0);
    });

    it('should stop retrying CAP LS 302 after max retries', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');

      // Advance past 3 retry windows (initial + 2 retries max)
      vi.advanceTimersByTime(10000); // 1st retry
      vi.advanceTimersByTime(10000); // 2nd retry
      vi.advanceTimersByTime(10000); // should not retry again

      const capCalls = mockSocket.write.mock.calls.filter(
        (c: unknown[]) => c[0] === 'CAP LS 302\r\n'
      );
      // 1 initial + 2 retries = 3 total
      expect(capCalls.length).toBe(3);
    });

    it('should destroy previous connection on reconnect', () => {
      const client = new IrcClient();
      const oldSocket = mockSocket;

      client.connect(defaultOptions);
      mockSocket.emit('connect');

      // Reconnect with new socket
      mockSocket = createMockSocket();
      client.connect(defaultOptions);

      expect(oldSocket.destroy).toHaveBeenCalled();
    });
  });

  describe('connection timeout', () => {
    it('should set connection timeout on socket', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);

      expect(mockSocket.setTimeout).toHaveBeenCalledWith(30000);
    });

    it('should destroy socket on connection timeout', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);

      mockSocket.emit('timeout');

      expect(mockSocket.destroy).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should clear connection timeout after successful connect', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');

      expect(mockSocket.setTimeout).toHaveBeenCalledWith(0);
    });
  });

  describe('data handling', () => {
    it('should emit raw events for received data', () => {
      const client = new IrcClient();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      client.connect(defaultOptions);
      mockSocket.emit('connect');
      rawHandler.mockClear();

      mockSocket.emit('data', Buffer.from(':server.test NOTICE * :Welcome\r\n'));

      expect(rawHandler).toHaveBeenCalledWith(
        ':server.test NOTICE * :Welcome',
        true,
      );
    });

    it('should handle multiple lines in one data chunk', () => {
      const client = new IrcClient();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      client.connect(defaultOptions);
      mockSocket.emit('connect');
      rawHandler.mockClear();

      mockSocket.emit('data', Buffer.from(':server NOTICE * :Line1\r\n:server NOTICE * :Line2\r\n'));

      expect(rawHandler).toHaveBeenCalledTimes(2);
      expect(rawHandler).toHaveBeenCalledWith(
        ':server NOTICE * :Line1',
        true,
      );
      expect(rawHandler).toHaveBeenCalledWith(
        ':server NOTICE * :Line2',
        true,
      );
    });

    it('should buffer incomplete lines', () => {
      const client = new IrcClient();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      client.connect(defaultOptions);
      mockSocket.emit('connect');
      rawHandler.mockClear();

      // Send partial data
      mockSocket.emit('data', Buffer.from(':server NOTICE * :Part'));
      expect(rawHandler).not.toHaveBeenCalled();

      // Complete the line
      mockSocket.emit('data', Buffer.from('ial message\r\n'));
      expect(rawHandler).toHaveBeenCalledWith(
        ':server NOTICE * :Partial message',
        true,
      );
    });

    it('should respond to PING with PONG', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');
      mockSocket.write.mockClear();

      mockSocket.emit('data', Buffer.from('PING :server.test\r\n'));

      expect(mockSocket.write).toHaveBeenCalledWith('PONG :server.test\r\n');
    });

    it('should emit connected event on RPL_WELCOME (001)', () => {
      const client = new IrcClient();
      const connectedHandler = vi.fn();
      client.on('connected', connectedHandler);

      client.connect(defaultOptions);
      mockSocket.emit('connect');

      mockSocket.emit('data', Buffer.from(':server 001 testuser :Welcome to the IRC Network\r\n'));

      expect(connectedHandler).toHaveBeenCalledWith();
    });

    it('should emit connected event on IRCv3 tagged RPL_WELCOME (001)', () => {
      const client = new IrcClient();
      const connectedHandler = vi.fn();
      client.on('connected', connectedHandler);

      client.connect(defaultOptions);
      mockSocket.emit('connect');

      mockSocket.emit(
        'data',
        Buffer.from('@time=2024-01-01T00:00:00Z :server 001 nick :Welcome\r\n')
      );

      expect(connectedHandler).toHaveBeenCalledWith();
    });

    it('should not emit connected on user message containing 001', () => {
      const client = new IrcClient();
      const connectedHandler = vi.fn();
      client.on('connected', connectedHandler);

      client.connect(defaultOptions);
      mockSocket.emit('connect');

      mockSocket.emit(
        'data',
        Buffer.from(':nick!user@host PRIVMSG #ch :error 001 happened\r\n')
      );

      expect(connectedHandler).not.toHaveBeenCalled();
    });

    it('should destroy socket on buffer overflow', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');

      // Send >2MB without \r\n terminators
      const chunk = Buffer.alloc(1024 * 1024, 0x41); // 1MB of 'A'
      mockSocket.emit('data', chunk);
      expect(mockSocket.destroy).not.toHaveBeenCalled();

      mockSocket.emit('data', chunk);
      expect(mockSocket.destroy).not.toHaveBeenCalled();

      // One more byte pushes over 2MB
      mockSocket.emit('data', Buffer.from('A'));
      expect(mockSocket.destroy).toHaveBeenCalled();
    });

    it('should ignore empty lines', () => {
      const client = new IrcClient();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      client.connect(defaultOptions);
      mockSocket.emit('connect');
      rawHandler.mockClear();

      mockSocket.emit('data', Buffer.from('\r\n\r\n:server NOTICE * :Hello\r\n\r\n'));

      expect(rawHandler).toHaveBeenCalledTimes(1);
      expect(rawHandler).toHaveBeenCalledWith(
        ':server NOTICE * :Hello',
        true,
      );
    });
  });

  describe('ping/pong mechanism', () => {
    it('should send PING at 30 second intervals', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');
      mockSocket.write.mockClear();

      vi.advanceTimersByTime(30000);

      expect(mockSocket.write).toHaveBeenCalledWith(expect.stringMatching(/^PING :\d+\r\n$/));
    });

    it('should destroy socket on pong timeout', () => {
      const client = new IrcClient();
      client.connect({ ...defaultOptions, pongTimeout: 10 });
      mockSocket.emit('connect');

      // At 30s, PING sent + 10s pong timeout starts
      vi.advanceTimersByTime(30000);

      // At 40s, pong timeout fires
      vi.advanceTimersByTime(10000);

      expect(mockSocket.destroy).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should clear pong timeout on receiving data', () => {
      const client = new IrcClient();
      client.connect({ ...defaultOptions, pongTimeout: 10 });
      mockSocket.emit('connect');

      // At 30s, PING sent + 10s pong timeout starts
      vi.advanceTimersByTime(30000);

      // At 35s, receive data — clears pong timeout
      vi.advanceTimersByTime(5000);
      mockSocket.emit('data', Buffer.from(':server NOTICE * :test\r\n'));

      // At 40s (when timeout would have fired), no destroy
      vi.advanceTimersByTime(5000);
      expect(mockSocket.destroy).not.toHaveBeenCalled();
    });
  });

  describe('socket events', () => {
    it('should emit close event on socket close', () => {
      const client = new IrcClient();
      const closeHandler = vi.fn();
      client.on('close', closeHandler);

      client.connect(defaultOptions);
      mockSocket.emit('connect');

      mockSocket.emit('close');

      expect(closeHandler).toHaveBeenCalledWith();
    });

    it('should cleanup timers on socket close', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');

      mockSocket.emit('close');

      // After cleanup, advancing timers should not cause any socket operations
      mockSocket.write.mockClear();
      vi.advanceTimersByTime(200000);

      // Only the calls before close should be present
      expect(mockSocket.write).not.toHaveBeenCalled();
    });

    it('should emit error event on socket error', () => {
      const client = new IrcClient();
      const errorHandler = vi.fn();
      client.on('error', errorHandler);
      client.connect(defaultOptions);
      mockSocket.emit('connect');

      const error = new Error('Connection reset');
      mockSocket.emit('error', error);

      expect(errorHandler).toHaveBeenCalledWith(error);
    });
  });

  describe('quit', () => {
    it('should send QUIT with message and end socket', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');
      mockSocket.write.mockClear();

      client.quit('Goodbye!');

      expect(mockSocket.write).toHaveBeenCalledWith('QUIT :Goodbye!\r\n');
      expect(mockSocket.end).toHaveBeenCalled();
    });

    it('should send QUIT without message when not provided', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');
      mockSocket.write.mockClear();

      client.quit();

      expect(mockSocket.write).toHaveBeenCalledWith('QUIT\r\n');
      expect(mockSocket.end).toHaveBeenCalled();
    });

    it('should not send QUIT if socket is not writable', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');
      mockSocket.writable = false;
      mockSocket.write.mockClear();

      client.quit('Goodbye');

      expect(mockSocket.write).not.toHaveBeenCalled();
      expect(mockSocket.end).not.toHaveBeenCalled();
    });

    it('should cleanup timers on quit', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');

      client.quit();

      // After cleanup, advancing timers should not cause any socket operations
      mockSocket.write.mockClear();
      vi.advanceTimersByTime(200000);

      expect(mockSocket.write).not.toHaveBeenCalled();
    });

    it('should be safe to call quit before connect', () => {
      const client = new IrcClient();

      expect(() => client.quit()).not.toThrow();
    });
  });

  describe('send', () => {
    it('should send string data', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');
      mockSocket.write.mockClear();

      client.send('PRIVMSG #channel :Hello world');

      expect(mockSocket.write).toHaveBeenCalledWith('PRIVMSG #channel :Hello world\r\n');
    });

    it('should emit raw event for sent data', () => {
      const client = new IrcClient();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      client.connect(defaultOptions);
      mockSocket.emit('connect');
      rawHandler.mockClear();

      client.send('JOIN #test');

      expect(rawHandler).toHaveBeenCalledWith('JOIN #test', false);
    });

    it('should not send if socket is not writable', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');
      mockSocket.writable = false;
      mockSocket.write.mockClear();

      client.send('TEST');

      expect(mockSocket.write).not.toHaveBeenCalled();
    });

    it('should not send if not connected', () => {
      const client = new IrcClient();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      client.send('TEST');

      expect(rawHandler).not.toHaveBeenCalled();
    });
  });

  describe('connected getter', () => {
    it('should return false before connect', () => {
      const client = new IrcClient();
      expect(client.connected).toBe(false);
    });

    it('should return true when socket is writable', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');

      expect(client.connected).toBe(true);
    });

    it('should return false when socket is not writable', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');
      mockSocket.writable = false;

      expect(client.connected).toBe(false);
    });
  });

  describe('destroy', () => {
    it('should destroy the socket', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');

      client.destroy();

      expect(mockSocket.destroy).toHaveBeenCalled();
    });

    it('should cleanup timers', () => {
      const client = new IrcClient();
      client.connect(defaultOptions);
      mockSocket.emit('connect');

      client.destroy();

      mockSocket.write.mockClear();
      vi.advanceTimersByTime(200000);

      expect(mockSocket.write).not.toHaveBeenCalled();
    });

    it('should be safe to call before connect', () => {
      const client = new IrcClient();
      expect(() => client.destroy()).not.toThrow();
    });
  });

  describe('buffer clearing on reconnect', () => {
    it('should clear buffer when connecting', () => {
      const client = new IrcClient();
      const rawHandler = vi.fn();
      client.on('raw', rawHandler);

      // First connection with incomplete data
      client.connect(defaultOptions);
      mockSocket.emit('connect');
      rawHandler.mockClear();
      mockSocket.emit('data', Buffer.from(':server NOTICE * :Incomplete'));

      // Reconnect - buffer should be cleared
      mockSocket = createMockSocket();
      client.connect(defaultOptions);
      mockSocket.emit('connect');
      rawHandler.mockClear();

      // New complete message should work
      mockSocket.emit('data', Buffer.from(':server NOTICE * :New message\r\n'));

      expect(rawHandler).toHaveBeenCalledWith(
        ':server NOTICE * :New message',
        true,
      );
      // Should NOT contain the old incomplete data
      expect(rawHandler).not.toHaveBeenCalledWith(
        expect.stringContaining('Incomplete'),
        expect.anything(),
      );
    });
  });
});
