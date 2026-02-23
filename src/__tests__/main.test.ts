import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Create mock instances that we can access in tests
const mockIrcClientInstance = {
  on: vi.fn(),
  connectRaw: vi.fn(),
  quit: vi.fn(),
  send: vi.fn(),
};

// Track all created clients for connection isolation tests
const allCreatedClients: { on: ReturnType<typeof vi.fn>; connectRaw: ReturnType<typeof vi.fn>; quit: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }[] = [];

function createMockClient() {
  const client = {
    on: vi.fn(),
    connectRaw: vi.fn(),
    quit: vi.fn(),
    send: vi.fn(),
  };
  // Also update the shared instance so existing single-connection tests work
  mockIrcClientInstance.on = client.on;
  mockIrcClientInstance.connectRaw = client.connectRaw;
  mockIrcClientInstance.quit = client.quit;
  mockIrcClientInstance.send = client.send;
  allCreatedClients.push(client);
  return client;
}

// Track WebSocketServer constructor options
let lastWssOptions: Record<string, unknown> = {};

// Mock ws that captures the handleUpgrade callback so we can invoke it
let handleUpgradeCallback: ((ws: unknown) => void) | null = null;

const mockWsServerInstance = {
  handleUpgrade: vi.fn((_req: unknown, _socket: unknown, _head: unknown, cb: (ws: unknown) => void) => {
    handleUpgradeCallback = cb;
  }),
};

vi.mock('ws', () => ({
  WebSocketServer: function MockWebSocketServer(options: Record<string, unknown>) {
    lastWssOptions = options || {};
    return Object.assign({}, mockWsServerInstance);
  },
  WebSocket: { OPEN: 1, CLOSED: 3 },
}));

vi.mock('../irc-client.js', () => ({
  IrcClient: function MockIrcClient() {
    return createMockClient();
  },
}));

vi.mock('../encryption.js', () => ({
  initEncryption: vi.fn().mockResolvedValue(undefined),
  encryptString: vi.fn().mockImplementation((s: string) => Promise.resolve(s)),
  decryptString: vi.fn().mockImplementation((s: string) => Promise.resolve(s)),
}));

// Mock http to prevent real server from binding to port 8667
let capturedUpgradeHandler: ((...args: unknown[]) => void) | null = null;
const mockHttpServerInstance = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'upgrade') {
      capturedUpgradeHandler = handler;
    }
  }),
  listen: vi.fn((_port: number, _host: string, cb?: () => void) => {
    if (cb) cb();
  }),
};
vi.mock('http', () => ({
  createServer: vi.fn(() => mockHttpServerInstance),
}));

vi.spyOn(console, 'log').mockImplementation(() => undefined);
vi.spyOn(console, 'error').mockImplementation(() => undefined);

// Helper to flush pending promises
const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Helper to get handler from mock calls
function getHandler(mockCalls: unknown[][], eventName: string): (...args: unknown[]) => void {
  const call = mockCalls.find((c) => c[0] === eventName);
  if (!call || typeof call[1] !== 'function') {
    throw new Error(`Handler for event "${eventName}" not found`);
  }
  return call[1] as (...args: unknown[]) => void;
}

/**
 * Simulate a WebSocket upgrade request through the httpServer.on('upgrade') handler.
 * Returns the mock ws object that handleNewClient receives.
 */
function simulateUpgrade(
  host = 'irc.example.com',
  port = 6667,
  tls = false,
): { mockWs: { on: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; readyState: number; close: ReturnType<typeof vi.fn> }; mockSocket: { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> } } {
  if (!capturedUpgradeHandler) throw new Error('upgrade handler not captured');

  const params = new URLSearchParams({ host, port: String(port), tls: String(tls) });
  const mockRequest = {
    url: `/webirc?${params.toString()}`,
    headers: { host: 'localhost:8667' },
  };
  const mockSocket = { write: vi.fn(), destroy: vi.fn() };
  const mockHead = Buffer.alloc(0);

  handleUpgradeCallback = null;
  capturedUpgradeHandler(mockRequest, mockSocket, mockHead);

  const mockWs = {
    on: vi.fn(),
    send: vi.fn(),
    readyState: 1, // WebSocket.OPEN
    close: vi.fn(),
  };

  // If handleUpgrade was called, invoke its callback with our mock ws
  const upgradeCb = handleUpgradeCallback as ((ws: unknown) => void) | null;
  if (upgradeCb) {
    upgradeCb(mockWs);
  }

  return { mockWs, mockSocket };
}

describe('main.ts', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Re-initialize mock instances
    mockIrcClientInstance.on = vi.fn();
    mockIrcClientInstance.connectRaw = vi.fn();
    mockIrcClientInstance.quit = vi.fn();
    mockIrcClientInstance.send = vi.fn();
    mockWsServerInstance.handleUpgrade = vi.fn((_req: unknown, _socket: unknown, _head: unknown, cb: (ws: unknown) => void) => {
      handleUpgradeCallback = cb;
    });
    mockHttpServerInstance.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'upgrade') {
        capturedUpgradeHandler = handler;
      }
    });
    mockHttpServerInstance.listen = vi.fn((_port: number, _host: string, cb?: () => void) => {
      if (cb) cb();
    });
    capturedUpgradeHandler = null;
    handleUpgradeCallback = null;
    allCreatedClients.length = 0;

    await import('../main.js');
    await flushPromises();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('WebSocket Server Setup', () => {
    it('should set maxPayload on WebSocket server', () => {
      expect(lastWssOptions.maxPayload).toBe(64 * 1024);
    });

    it('should register upgrade handler on http server', () => {
      expect(mockHttpServerInstance.on).toHaveBeenCalledWith('upgrade', expect.any(Function));
    });

    it('should start listening on 127.0.0.1:8667', () => {
      expect(mockHttpServerInstance.listen).toHaveBeenCalledWith(8667, '127.0.0.1', expect.any(Function));
    });
  });

  describe('Upgrade handler validation', () => {
    it('should reject wrong path', () => {
      if (!capturedUpgradeHandler) throw new Error('no handler');
      const mockSocket = { write: vi.fn(), destroy: vi.fn() };
      capturedUpgradeHandler(
        { url: '/wrong?host=irc.test.com&port=6667', headers: { host: 'localhost' } },
        mockSocket,
        Buffer.alloc(0),
      );
      expect(mockSocket.write).toHaveBeenCalledWith('HTTP/1.1 404 Not Found\r\n\r\n');
      expect(mockSocket.destroy).toHaveBeenCalled();
    });

    it('should reject missing host', () => {
      if (!capturedUpgradeHandler) throw new Error('no handler');
      const mockSocket = { write: vi.fn(), destroy: vi.fn() };
      capturedUpgradeHandler(
        { url: '/webirc?port=6667', headers: { host: 'localhost' } },
        mockSocket,
        Buffer.alloc(0),
      );
      expect(mockSocket.write).toHaveBeenCalledWith('HTTP/1.1 400 Bad Request - Missing or invalid host/port\r\n\r\n');
      expect(mockSocket.destroy).toHaveBeenCalled();
    });

    it('should reject missing port', () => {
      if (!capturedUpgradeHandler) throw new Error('no handler');
      const mockSocket = { write: vi.fn(), destroy: vi.fn() };
      capturedUpgradeHandler(
        { url: '/webirc?host=irc.test.com', headers: { host: 'localhost' } },
        mockSocket,
        Buffer.alloc(0),
      );
      expect(mockSocket.write).toHaveBeenCalledWith('HTTP/1.1 400 Bad Request - Missing or invalid host/port\r\n\r\n');
    });
  });

  describe('Client connection', () => {
    it('should connect to IRC server with parsed config', () => {
      simulateUpgrade('irc.libera.chat', 6697, true);

      expect(mockIrcClientInstance.connectRaw).toHaveBeenCalledWith({
        host: 'irc.libera.chat',
        port: 6697,
        tls: true,
        encoding: 'utf8',
      });
    });

    it('should forward decrypted messages to IRC client', async () => {
      const { mockWs } = simulateUpgrade();
      const messageHandler = getHandler(mockWs.on.mock.calls, 'message');

      messageHandler(Buffer.from('PING :test'));
      await flushPromises();

      expect(mockIrcClientInstance.send).toHaveBeenCalledWith('PING :test');
    });

    it('should disconnect IRC client on WebSocket close', () => {
      const { mockWs } = simulateUpgrade();
      const closeHandler = getHandler(mockWs.on.mock.calls, 'close');

      closeHandler();

      expect(mockIrcClientInstance.quit).toHaveBeenCalledWith('Simple Irc Client ( https://simpleircclient.com )');
    });

    it('should forward raw IRC events to WebSocket client', async () => {
      const { mockWs } = simulateUpgrade();
      const rawHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'raw');

      rawHandler(':server PING :test', true);
      await flushPromises();

      expect(mockWs.send).toHaveBeenCalledWith(':server PING :test');
    });

    it('should not forward client-originated raw events', async () => {
      const { mockWs } = simulateUpgrade();
      const rawHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'raw');

      rawHandler('PONG :test', false);
      await flushPromises();

      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should not send when WebSocket is not open', async () => {
      const { mockWs } = simulateUpgrade();
      mockWs.readyState = 3; // CLOSED

      const rawHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'raw');
      rawHandler(':server PING :test', true);
      await flushPromises();

      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });

  describe('Error message sanitization', () => {
    it('should strip CRLF from error messages forwarded to client', async () => {
      const { mockWs } = simulateUpgrade();
      const errorHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'error');

      errorHandler(new Error('Connection refused\r\nPRIVMSG #channel :injected'));
      await flushPromises();

      expect(mockWs.send).toHaveBeenCalledWith('ERROR :Connection refusedPRIVMSG #channel :injected');
    });
  });

  describe('Rate limiting', () => {
    it('should forward messages within the rate limit', async () => {
      const { mockWs } = simulateUpgrade();
      const messageHandler = getHandler(mockWs.on.mock.calls, 'message');

      for (let i = 0; i < 50; i++) {
        messageHandler(Buffer.from(`PING :test${i}`));
      }
      await flushPromises();

      expect(mockIrcClientInstance.send).toHaveBeenCalledTimes(50);
    });

    it('should drop messages exceeding rate limit of 50 per window', async () => {
      const { mockWs } = simulateUpgrade();
      const messageHandler = getHandler(mockWs.on.mock.calls, 'message');

      for (let i = 0; i < 60; i++) {
        messageHandler(Buffer.from(`PING :test${i}`));
      }
      await flushPromises();

      expect(mockIrcClientInstance.send).toHaveBeenCalledTimes(50);
    });
  });

  describe('Connection isolation', () => {
    it('should not send stale IRC events to a new WebSocket after reconnect', async () => {
      // First connection
      const { mockWs: ws1 } = simulateUpgrade('irc.first.com', 6667);
      const client1 = allCreatedClients[allCreatedClients.length - 1];
      if (!client1) throw new Error('No client created');
      const client1RawHandler = getHandler(client1.on.mock.calls, 'raw');

      // Close first connection (simulate WS close)
      const ws1CloseHandler = getHandler(ws1.on.mock.calls, 'close');
      ws1CloseHandler();
      ws1.readyState = 3; // CLOSED

      // Second connection
      const { mockWs: ws2 } = simulateUpgrade('irc.second.com', 6667);

      // Fire a stale 'raw' event from the FIRST IRC client
      client1RawHandler(':old PRIVMSG #leak :should not arrive', true);
      await flushPromises();

      // The stale event should NOT appear on the new WebSocket
      expect(ws2.send).not.toHaveBeenCalled();
      // It tried to send on ws1 which is CLOSED, so send is not called there either
      expect(ws1.send).not.toHaveBeenCalled();
    });

    it('should not quit new IRC client when old WebSocket close fires late', () => {
      // First connection
      const { mockWs: ws1 } = simulateUpgrade('irc.first.com', 6667);
      const client1 = allCreatedClients[allCreatedClients.length - 1];
      if (!client1) throw new Error('No client created');

      // Simulate the first WS closing and immediately reconnecting
      const ws1CloseHandler = getHandler(ws1.on.mock.calls, 'close');
      ws1CloseHandler();
      ws1.readyState = 3;

      // Second connection
      simulateUpgrade('irc.second.com', 6667);
      const client2 = allCreatedClients[allCreatedClients.length - 1];
      if (!client2) throw new Error('No client created');

      // client1 should have been quit by ws1's close handler
      expect(client1.quit).toHaveBeenCalled();
      // client2 should NOT have been quit
      expect(client2.quit).not.toHaveBeenCalled();
    });
  });

  describe('Message ordering (send queue serialization)', () => {
    it('should hold second message until first encryption completes', async () => {
      const { encryptString: mockEncrypt } = await import('../encryption.js');
      const encryptFn = vi.mocked(mockEncrypt);

      let resolveFirst!: (value: string) => void;

      // First call: slow encryption (pending promise)
      // Second call: instant encryption
      encryptFn
        .mockImplementationOnce(
          () => new Promise<string>((r) => { resolveFirst = r; }),
        )
        .mockImplementation(
          (s: string) => Promise.resolve(`enc:${s}`),
        );

      const { mockWs } = simulateUpgrade();
      const rawHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'raw');

      // IRC server sends two lines rapidly (e.g. multiline CAP LS)
      rawHandler('CAP * LS * :message-tags server-time batch', true);
      rawHandler('CAP * LS :standard-replies', true);
      await flushPromises();

      // First encryption is pending — nothing sent yet, even though
      // the second message's encryption would be instant
      expect(mockWs.send).not.toHaveBeenCalled();

      // Resolve the slow first encryption
      resolveFirst('enc:first-line');
      await flushPromises();

      // Both should now be sent, in the correct order
      expect(mockWs.send).toHaveBeenCalledTimes(2);
      expect(mockWs.send.mock.calls[0]?.[0]).toBe('enc:first-line');
      expect(mockWs.send.mock.calls[1]?.[0]).toBe('enc:CAP * LS :standard-replies');
    });

    it('should deliver many messages in strict order', async () => {
      const { encryptString: mockEncrypt } = await import('../encryption.js');
      vi.mocked(mockEncrypt).mockImplementation(
        (s: string) => Promise.resolve(`enc:${s}`),
      );

      const { mockWs } = simulateUpgrade();
      const rawHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'raw');

      for (let i = 0; i < 20; i++) {
        rawHandler(`LINE ${i}`, true);
      }

      // Drain the serialized promise chain
      for (let i = 0; i < 50; i++) await flushPromises();

      expect(mockWs.send).toHaveBeenCalledTimes(20);
      for (let i = 0; i < 20; i++) {
        expect(mockWs.send.mock.calls[i]?.[0]).toBe(`enc:LINE ${i}`);
      }
    });

    it('should skip closed socket without blocking subsequent messages', async () => {
      const { encryptString: mockEncrypt } = await import('../encryption.js');
      vi.mocked(mockEncrypt).mockImplementation(
        (s: string) => Promise.resolve(`enc:${s}`),
      );

      const { mockWs } = simulateUpgrade();
      const rawHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'raw');

      // Send first message while open
      rawHandler('LINE 0', true);
      await flushPromises();
      expect(mockWs.send).toHaveBeenCalledTimes(1);

      // Socket closes
      mockWs.readyState = 3; // CLOSED

      // Send a message to the closed socket
      rawHandler('LINE 1', true);
      await flushPromises();

      // Reopen
      mockWs.readyState = 1; // OPEN

      // Next message should still be delivered
      rawHandler('LINE 2', true);
      await flushPromises();

      expect(mockWs.send).toHaveBeenCalledTimes(2);
      expect(mockWs.send.mock.calls[1]?.[0]).toBe('enc:LINE 2');
    });

    it('should skip failed encryption without blocking subsequent messages', async () => {
      const { encryptString: mockEncrypt } = await import('../encryption.js');
      vi.mocked(mockEncrypt)
        .mockImplementationOnce(() => Promise.reject(new Error('encrypt failed')))
        .mockImplementation((s: string) => Promise.resolve(`enc:${s}`));

      const { mockWs } = simulateUpgrade();
      const rawHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'raw');

      rawHandler('LINE 0', true);
      rawHandler('LINE 1', true);
      await flushPromises();
      await flushPromises();

      // First message failed encryption, second should still arrive
      expect(mockWs.send).toHaveBeenCalledTimes(1);
      expect(mockWs.send.mock.calls[0]?.[0]).toBe('enc:LINE 1');
    });

    it('should reset send queue on new connection', async () => {
      const { encryptString: mockEncrypt } = await import('../encryption.js');
      const encryptFn = vi.mocked(mockEncrypt);

      // Stall encryption for the first connection indefinitely
      encryptFn.mockImplementation(
        () => new Promise<string>(() => { /* never resolves */ }),
      );

      const { mockWs: ws1 } = simulateUpgrade('irc.first.com', 6667);
      const lastClient1 = allCreatedClients[allCreatedClients.length - 1];
      if (!lastClient1) throw new Error('No client created');
      const client1RawHandler = getHandler(lastClient1.on.mock.calls, 'raw');

      // Queue a send that will never complete
      client1RawHandler('STALLED', true);
      await flushPromises();

      // First connection's message is stuck
      expect(ws1.send).not.toHaveBeenCalled();

      // Close first connection
      const ws1CloseHandler = getHandler(ws1.on.mock.calls, 'close');
      ws1CloseHandler();
      ws1.readyState = 3;

      // Switch to instant encryption for the second connection
      encryptFn.mockImplementation(
        (s: string) => Promise.resolve(`enc:${s}`),
      );

      // New connection — handleNewClient resets sendQueue
      const { mockWs: ws2 } = simulateUpgrade('irc.second.com', 6667);
      const lastClient2 = allCreatedClients[allCreatedClients.length - 1];
      if (!lastClient2) throw new Error('No client created');
      const client2RawHandler = getHandler(lastClient2.on.mock.calls, 'raw');

      client2RawHandler('FRESH', true);
      await flushPromises();

      // New connection's message should arrive, not blocked by old stalled queue
      expect(ws2.send).toHaveBeenCalledWith('enc:FRESH');
    });
  });
});
