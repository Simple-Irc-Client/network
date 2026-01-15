import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Create mock instances that we can access in tests
const mockWsServerInstance = {
  on: vi.fn(),
};

const mockIrcClientInstance = {
  on: vi.fn(),
  connect: vi.fn(),
  quit: vi.fn(),
  raw: vi.fn(),
};

// Mock ws module before importing main
vi.mock('ws', () => {
  return {
    WebSocketServer: class MockWebSocketServer {
      constructor() {
        Object.assign(this, mockWsServerInstance);
      }
    },
    WebSocket: {
      OPEN: 1,
      CLOSED: 3,
    },
  };
});

// Mock irc-framework - it's imported as `* as IRC` so we need to export Client directly
vi.mock('irc-framework', () => {
  return {
    Client: class MockClient {
      constructor() {
        Object.assign(this, mockIrcClientInstance);
      }
    },
  };
});

// Mock console to avoid noise in tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

// Helper to get handler from mock calls
function getHandler(mockCalls: any[][], eventName: string): ((...args: any[]) => void) | undefined {
  const call = mockCalls.find((c) => c[0] === eventName);
  return call?.[1];
}

describe('main.ts', () => {
  let connectionHandler: (ws: any) => void;

  beforeEach(async () => {
    // Clear all mock calls
    vi.clearAllMocks();
    vi.resetModules();

    // Re-initialize mock instances
    mockWsServerInstance.on = vi.fn();
    mockIrcClientInstance.on = vi.fn();
    mockIrcClientInstance.connect = vi.fn();
    mockIrcClientInstance.quit = vi.fn();
    mockIrcClientInstance.raw = vi.fn();

    // Import main module - this triggers side effects
    await import('./main');

    // Capture the connection handler
    const handler = getHandler(mockWsServerInstance.on.mock.calls, 'connection');
    if (handler) {
      connectionHandler = handler;
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('WebSocket Server Setup', () => {
    it('should register connection handler', () => {
      expect(mockWsServerInstance.on).toHaveBeenCalledWith('connection', expect.any(Function));
    });
  });

  describe('IRC Client Setup', () => {
    it('should register connected event handler', () => {
      expect(mockIrcClientInstance.on).toHaveBeenCalledWith('connected', expect.any(Function));
    });

    it('should register close event handler', () => {
      expect(mockIrcClientInstance.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should register socket close event handler', () => {
      expect(mockIrcClientInstance.on).toHaveBeenCalledWith('socket close', expect.any(Function));
    });

    it('should register socket connected event handler', () => {
      expect(mockIrcClientInstance.on).toHaveBeenCalledWith('socket connected', expect.any(Function));
    });

    it('should register raw event handler', () => {
      expect(mockIrcClientInstance.on).toHaveBeenCalledWith('raw', expect.any(Function));
    });
  });

  describe('WebSocket Connection Handler', () => {
    it('should handle new WebSocket connection', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1, // WebSocket.OPEN
      };

      connectionHandler(mockWs);

      expect(mockWs.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockWs.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockWs.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should parse and handle sic-client-event messages', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs);

      const messageHandler = getHandler(mockWs.on.mock.calls, 'message');
      expect(messageHandler).toBeDefined();

      // Send a valid sic-client-event
      const message = JSON.stringify({
        event: 'sic-client-event',
        data: { type: 'raw', event: { rawData: 'PING :test' } },
      });

      messageHandler!(Buffer.from(message));

      // Should have called ircClient.raw with the data
      expect(mockIrcClientInstance.raw).toHaveBeenCalledWith('PING :test');
    });

    it('should handle connect command', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs);

      const messageHandler = getHandler(mockWs.on.mock.calls, 'message');
      expect(messageHandler).toBeDefined();

      const message = JSON.stringify({
        event: 'sic-client-event',
        data: {
          type: 'connect',
          event: {
            server: { host: 'irc.example.com', port: 6667 },
            nick: 'testuser',
          },
        },
      });

      messageHandler!(Buffer.from(message));

      expect(mockIrcClientInstance.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'irc.example.com',
          port: 6667,
          nick: 'testuser',
        })
      );
    });

    it('should handle invalid JSON messages gracefully', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs);

      const messageHandler = getHandler(mockWs.on.mock.calls, 'message');
      expect(messageHandler).toBeDefined();

      // Send invalid JSON - should not throw
      expect(() => {
        messageHandler!(Buffer.from('invalid json'));
      }).not.toThrow();
    });

    it('should ignore non sic-client-event messages', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs);

      const messageHandler = getHandler(mockWs.on.mock.calls, 'message');
      expect(messageHandler).toBeDefined();

      const message = JSON.stringify({
        event: 'some-other-event',
        data: { type: 'raw', event: { rawData: 'PING :test' } },
      });

      messageHandler!(Buffer.from(message));

      // Should not call any IRC client methods
      expect(mockIrcClientInstance.raw).not.toHaveBeenCalled();
      expect(mockIrcClientInstance.connect).not.toHaveBeenCalled();
      expect(mockIrcClientInstance.quit).not.toHaveBeenCalled();
    });

    it('should handle WebSocket close event', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs);

      const closeHandler = getHandler(mockWs.on.mock.calls, 'close');
      expect(closeHandler).toBeDefined();

      // Trigger close
      closeHandler!();

      // Should have called ircClient.quit
      expect(mockIrcClientInstance.quit).toHaveBeenCalledWith('Leaving');
    });

    it('should handle WebSocket error event', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs);

      const errorHandler = getHandler(mockWs.on.mock.calls, 'error');
      expect(errorHandler).toBeDefined();

      // Should not throw on error
      expect(() => {
        errorHandler!(new Error('Test error'));
      }).not.toThrow();
    });
  });

  describe('IRC Event Handlers', () => {
    it('should send sic-irc-event on connected', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      // First connect a client
      connectionHandler(mockWs);

      // Get the connected handler from ircClient
      const connectedHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'connected');
      expect(connectedHandler).toBeDefined();

      // Trigger the connected event
      connectedHandler!({});

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'sic-irc-event', data: { type: 'connected' } })
      );
    });

    it('should send sic-irc-event on close', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs);

      const closeHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'close');
      expect(closeHandler).toBeDefined();

      closeHandler!({});

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'sic-irc-event', data: { type: 'close' } })
      );
    });

    it('should send sic-irc-event on socket close', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs);

      const socketCloseHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'socket close');
      expect(socketCloseHandler).toBeDefined();

      socketCloseHandler!({});

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'sic-irc-event', data: { type: 'socket close' } })
      );
    });

    it('should send sic-irc-event on socket connected', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs);

      const socketConnectedHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'socket connected');
      expect(socketConnectedHandler).toBeDefined();

      socketConnectedHandler!({});

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'sic-irc-event', data: { type: 'socket connected' } })
      );
    });

    it('should send sic-irc-event with raw line from server', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs);

      const rawHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'raw');
      expect(rawHandler).toBeDefined();

      rawHandler!({ from_server: true, line: ':server.test PING :test' });

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({
          event: 'sic-irc-event',
          data: { type: 'raw', line: ':server.test PING :test' },
        })
      );
    });

    it('should send sic-server-event with raw line to server', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs);

      const rawHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'raw');
      expect(rawHandler).toBeDefined();

      rawHandler!({ from_server: false, line: 'PONG :test' });

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'sic-server-event', data: { type: 'raw', line: 'PONG :test' } })
      );
    });

    it('should not send raw event when line is missing', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs);

      const rawHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'raw');
      expect(rawHandler).toBeDefined();

      // Call with missing line
      rawHandler!({ from_server: true });

      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should not send when client connection is not open', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 3, // CLOSED
      };

      connectionHandler(mockWs);

      const connectedHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'connected');
      expect(connectedHandler).toBeDefined();

      connectedHandler!({});

      // send should not be called when readyState is not OPEN
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should not send when no client is connected', async () => {
      // Get the connected handler before any client connects
      const connectedHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'connected');
      expect(connectedHandler).toBeDefined();

      // This should not throw even without a connected client
      // (connectedClient is null at this point since connectionHandler wasn't called)
      expect(() => {
        connectedHandler!({});
      }).not.toThrow();
    });
  });

  describe('Multiple connection handling', () => {
    it('should only accept first connection as client', () => {
      const mockWs1 = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      const mockWs2 = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      // Connect first client
      connectionHandler(mockWs1);
      // Connect second client
      connectionHandler(mockWs2);

      // Get the connected handler
      const connectedHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'connected');
      expect(connectedHandler).toBeDefined();

      // Trigger event
      connectedHandler!({});

      // Only first client should receive the message
      expect(mockWs1.send).toHaveBeenCalled();
      expect(mockWs2.send).not.toHaveBeenCalled();
    });
  });
});
