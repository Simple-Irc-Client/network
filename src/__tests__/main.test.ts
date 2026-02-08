import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Create mock instances that we can access in tests
const mockIrcClientInstance = {
  on: vi.fn(),
  connectRaw: vi.fn(),
  quit: vi.fn(),
  raw: vi.fn(),
};

function createMockClient() {
  return Object.assign({}, mockIrcClientInstance);
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
  Client: function MockClient() {
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
    mockIrcClientInstance.raw = vi.fn();
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

      expect(mockIrcClientInstance.raw).toHaveBeenCalledWith('PING :test');
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

      rawHandler({ from_server: true, line: ':server PING :test' });
      await flushPromises();

      expect(mockWs.send).toHaveBeenCalledWith(':server PING :test');
    });

    it('should not forward client-originated raw events', async () => {
      const { mockWs } = simulateUpgrade();
      const rawHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'raw');

      rawHandler({ from_server: false, line: 'PONG :test' });
      await flushPromises();

      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should not send when WebSocket is not open', async () => {
      const { mockWs } = simulateUpgrade();
      mockWs.readyState = 3; // CLOSED

      const rawHandler = getHandler(mockIrcClientInstance.on.mock.calls, 'raw');
      rawHandler({ from_server: true, line: ':server PING :test' });
      await flushPromises();

      expect(mockWs.send).not.toHaveBeenCalled();
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

      expect(mockIrcClientInstance.raw).toHaveBeenCalledTimes(50);
    });

    it('should drop messages exceeding rate limit of 50 per window', async () => {
      const { mockWs } = simulateUpgrade();
      const messageHandler = getHandler(mockWs.on.mock.calls, 'message');

      for (let i = 0; i < 60; i++) {
        messageHandler(Buffer.from(`PING :test${i}`));
      }
      await flushPromises();

      expect(mockIrcClientInstance.raw).toHaveBeenCalledTimes(50);
    });
  });
});
