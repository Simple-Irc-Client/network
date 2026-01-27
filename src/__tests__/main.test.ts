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

// Factory functions for mock classes to avoid no-extraneous-class lint error
function createMockWebSocketServer() {
  return Object.assign({}, mockWsServerInstance);
}

function createMockClient() {
  return Object.assign({}, mockIrcClientInstance);
}

// Mock ws module before importing main
vi.mock('ws', () => {
  return {
    WebSocketServer: function MockWebSocketServer() {
      return createMockWebSocketServer();
    },
    WebSocket: {
      OPEN: 1,
      CLOSED: 3,
    },
  };
});

// Mock irc-client module
vi.mock('../irc-client.js', () => {
  return {
    Client: function MockClient() {
      return createMockClient();
    },
  };
});

// Mock encryption module to pass through unencrypted for testing
vi.mock('../encryption.js', () => ({
  initEncryption: vi.fn().mockResolvedValue(undefined),
  encryptMessage: vi.fn().mockImplementation((data) => Promise.resolve(JSON.stringify(data))),
  decryptMessage: vi.fn().mockImplementation((data) => Promise.resolve(JSON.parse(data))),
}));

// Mock console to avoid noise in tests
vi.spyOn(console, 'log').mockImplementation(() => undefined);
vi.spyOn(console, 'error').mockImplementation(() => undefined);

// Helper to get handler from mock calls - throws if not found for safer usage
function getHandler(mockCalls: unknown[][], eventName: string): (...args: unknown[]) => void {
  const call = mockCalls.find((c) => c[0] === eventName);
  if (!call || typeof call[1] !== 'function') {
    throw new Error(`Handler for event "${eventName}" not found`);
  }
  return call[1] as (...args: unknown[]) => void;
}

// Helper to flush pending promises
const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Create a mock request with headers for origin validation
function createMockRequest(origin = 'http://localhost:5173') {
  return {
    headers: { origin },
  };
}

describe('main.ts', () => {
  let connectionHandler: (ws: unknown, request: unknown) => void;

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
    await import('../main.js');

    // Capture the connection handler
    connectionHandler = getHandler(mockWsServerInstance.on.mock.calls, 'connection') as (
      ws: unknown,
      request: unknown
    ) => void;
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

      connectionHandler(mockWs, createMockRequest());

      expect(mockWs.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockWs.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockWs.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should parse and handle sic-client-event messages', async () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs, createMockRequest());

      const messageHandler = getHandler(mockWs.on.mock.calls, 'message');

      // Send a valid sic-client-event
      const message = JSON.stringify({
        event: 'sic-client-event',
        data: { type: 'raw', event: { rawData: 'PING :test' } },
      });

      messageHandler(Buffer.from(message));
      await flushPromises();

      // Should have called ircClient.raw with the data
      expect(mockIrcClientInstance.raw).toHaveBeenCalledWith('PING :test');
    });

    it('should handle connect command', async () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs, createMockRequest());

      const messageHandler = getHandler(mockWs.on.mock.calls, 'message');

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

      messageHandler(Buffer.from(message));
      await flushPromises();

      expect(mockIrcClientInstance.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'irc.example.com',
          port: 6667,
          nick: 'testuser',
        })
      );
    });

    it('should handle invalid JSON messages gracefully', async () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs, createMockRequest());

      const messageHandler = getHandler(mockWs.on.mock.calls, 'message');

      // Send invalid JSON - should not throw
      messageHandler(Buffer.from('invalid json'));
      await flushPromises();
    });

    it('should ignore non sic-client-event messages', async () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs, createMockRequest());

      const messageHandler = getHandler(mockWs.on.mock.calls, 'message');

      const message = JSON.stringify({
        event: 'some-other-event',
        data: { type: 'raw', event: { rawData: 'PING :test' } },
      });

      messageHandler(Buffer.from(message));
      await flushPromises();

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

      connectionHandler(mockWs, createMockRequest());

      const closeHandler = getHandler(mockWs.on.mock.calls, 'close');

      // Trigger close
      closeHandler();

      // Should have called ircClient.quit
      expect(mockIrcClientInstance.quit).toHaveBeenCalledWith('Simple Irc Client ( https://simpleircclient.com )');
    });

    it('should handle WebSocket error event', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs, createMockRequest());

      const errorHandler = getHandler(mockWs.on.mock.calls, 'error');

      // Should not throw on error
      expect(() => {
        errorHandler(new Error('Test error'));
      }).not.toThrow();
    });
  });

  describe('IRC Event Handlers', () => {
    it('should send sic-irc-event on connected', async () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      // First connect a client
      connectionHandler(mockWs, createMockRequest());

      // Get the connected handler from ircClient
      const connectedHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'connected');

      // Trigger the connected event
      connectedHandler({});
      await flushPromises();

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'sic-irc-event', data: { type: 'connected' } })
      );
    });

    it('should send sic-irc-event on close', async () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs, createMockRequest());

      const closeHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'close');

      closeHandler({});
      await flushPromises();

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'sic-irc-event', data: { type: 'close' } })
      );
    });

    it('should send sic-irc-event on socket close', async () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs, createMockRequest());

      const socketCloseHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'socket close');

      socketCloseHandler({});
      await flushPromises();

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'sic-irc-event', data: { type: 'socket close' } })
      );
    });

    it('should send sic-irc-event on socket connected', async () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs, createMockRequest());

      const socketConnectedHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'socket connected');

      socketConnectedHandler({});
      await flushPromises();

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'sic-irc-event', data: { type: 'socket connected' } })
      );
    });

    it('should send sic-irc-event with raw line from server', async () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs, createMockRequest());

      const rawHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'raw');

      rawHandler({ from_server: true, line: ':server.test PING :test' });
      await flushPromises();

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({
          event: 'sic-irc-event',
          data: { type: 'raw', line: ':server.test PING :test' },
        })
      );
    });

    it('should send sic-server-event with raw line to server', async () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs, createMockRequest());

      const rawHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'raw');

      rawHandler({ from_server: false, line: 'PONG :test' });
      await flushPromises();

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'sic-server-event', data: { type: 'raw', line: 'PONG :test' } })
      );
    });

    it('should not send raw event when line is missing', async () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      connectionHandler(mockWs, createMockRequest());

      const rawHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'raw');

      // Call with missing line
      rawHandler({ from_server: true });
      await flushPromises();

      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should not send when client connection is not open', async () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        readyState: 3, // CLOSED
      };

      connectionHandler(mockWs, createMockRequest());

      const connectedHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'connected');

      connectedHandler({});
      await flushPromises();

      // send should not be called when readyState is not OPEN
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should not send when no client is connected', async () => {
      // Get the connected handler before any client connects
      const connectedHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'connected');

      // This should not throw even without a connected client
      // (connectedClient is null at this point since connectionHandler wasn't called)
      expect(() => {
        connectedHandler({});
      }).not.toThrow();
    });
  });

  describe('Multiple connection handling', () => {
    it('should only accept first connection as client', async () => {
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
      connectionHandler(mockWs1, createMockRequest());
      // Connect second client
      connectionHandler(mockWs2, createMockRequest());

      // Get the connected handler
      const connectedHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'connected');

      // Trigger event
      connectedHandler({});
      await flushPromises();

      // Only first client should receive the message
      expect(mockWs1.send).toHaveBeenCalled();
      expect(mockWs2.send).not.toHaveBeenCalled();
    });
  });
});
