/**
 * WebSocket Server for Simple IRC Client (Local Backend)
 *
 * Uses direct IRC protocol (raw IRC lines over WebSocket) with AES-256-GCM encryption.
 * Server configuration is passed via query parameters.
 *
 * Connection URL format:
 * ws://localhost:8667/webirc?host=irc.example.com&port=6697&tls=true&encoding=utf8
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import { defaultWebsocketPort, defaultIrcQuitMessage, encryptionKey } from './config.js';
import { IrcClient } from './irc-client.js';
import { initEncryption, encryptString, decryptString } from './encryption.js';

const WEBSOCKET_PATH = '/webirc';

/** Strip control/escape characters from untrusted strings before logging */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x1b]/g;
const sanitizeLog = (s: string): string => s.replace(CONTROL_RE, '');

// Process-level safety net — any stray rejection or exception would otherwise
// terminate the process silently. Log with enough context to diagnose.
// Use `once` so re-imports in tests don't stack duplicate handlers.
process.once('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);
  console.error(`\x1b[31m${new Date().toISOString()} Unhandled rejection: ${sanitizeLog(msg)}\x1b[0m`);
});

process.once('uncaughtException', (error) => {
  console.error(`\x1b[31m${new Date().toISOString()} Uncaught exception: ${sanitizeLog(error.message)}\n${error.stack ?? ''}\x1b[0m`);
  // Exceptions leave the process in an undefined state — exit so the supervisor restarts us.
  process.exit(1);
});

/** Strip CR/LF to prevent IRC line injection in constructed messages */
const stripCRLF = (s: string): string => s.replace(/[\r\n]/g, '');

// Initialize encryption
initEncryption(encryptionKey).then(() => {
  if (encryptionKey) {
    console.log(`\x1b[32m${new Date().toISOString()} Encryption enabled\x1b[0m`);
  } else {
    console.log(`\x1b[33m${new Date().toISOString()} Encryption disabled (no ENCRYPTION_KEY set)\x1b[0m`);
  }
  
  // Log if file logging is enabled
  if (process.env.NODE_ENV === 'local') {
    console.log(`\x1b[32m${new Date().toISOString()} Logging enabled (NODE_ENV=local)\x1b[0m`);
  }
}).catch((err: Error) => {
  console.error(`\x1b[31m${new Date().toISOString()} Encryption init failed: ${err.message}\x1b[0m`);
  process.exit(1);
});

// HTTP server for handling WebSocket upgrades
const httpServer = createServer((_request, response) => {
  response.end('Simple IRC Client Backend');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

let connectedClient: WebSocket | null = null;
let ircClient: IrcClient | null = null;

// Rate limiting: max 50 messages per 5-second window
const RATE_LIMIT_MAX_MESSAGES = 50;
const RATE_LIMIT_WINDOW_MS = 5000;

/**
 * Per-connection state bag. Previously all of these lived at module scope,
 * which meant a rapid disconnect+reconnect could race: the new connection
 * would reset the shared sendQueue while the old connection's encryption
 * chain was still resolving, causing messages to fire out of order. Keeping
 * the state alongside the connection that owns it eliminates the window.
 */
interface ConnectionState {
  ws: WebSocket;
  client: IrcClient;
  sendQueue: Promise<void>;
  messageCount: number;
  rateLimitWindowStart: number;
  /** True while the IRC socket is paused for WebSocket backpressure. */
  paused: boolean;
}

/**
 * Send a raw IRC line through a specific connection's serialized queue.
 * Always logs failures — even in production — because encryption errors
 * are a security boundary and silent drops hide real attacks or bugs.
 */
const sendRawToClient = (state: ConnectionState, line: string): Promise<void> => {
  state.sendQueue = state.sendQueue.then(async () => {
    const { ws } = state;
    if (ws.readyState !== WebSocket.OPEN) return;
    let encrypted: string;
    try {
      encrypted = await encryptString(line);
    } catch (error) {
      // Fail closed — drop the message rather than sending unencrypted.
      // Logging is unconditional: encryption failures must be visible in prod.
      console.error(
        `\x1b[31m${new Date().toISOString()} Encryption failed, dropping message: ${sanitizeLog(String(error))}\x1b[0m`
      );
      return;
    }
    try {
      ws.send(encrypted);
      // The `ws` library's send() doesn't return a drain status — we have to
      // consult bufferedAmount instead. When > 1 MiB is queued we pause the
      // upstream IRC socket so memory doesn't grow unboundedly for a slow
      // client, and resume once the buffer drains.
      if (ws.bufferedAmount > 1_048_576 && !state.paused) {
        state.paused = true;
        state.client.pause();
        waitForWsDrain(ws, () => {
          state.paused = false;
          state.client.resume();
        });
      }
    } catch (error) {
      console.error(
        `\x1b[31m${new Date().toISOString()} ws.send failed: ${sanitizeLog(String(error))}\x1b[0m`
      );
    }
  });
  return state.sendQueue;
};

/**
 * Poll WebSocket bufferedAmount until it drops below the low-water mark,
 * then invoke onDrain. Cheap and dependency-free — the downside is a small
 * latency delta vs a true drain event, which is acceptable for IRC throughput.
 */
function waitForWsDrain(ws: WebSocket, onDrain: () => void): void {
  const LOW_WATER_MARK = 524_288;
  const CHECK_INTERVAL_MS = 50;
  const tick = (): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount < LOW_WATER_MARK) {
      onDrain();
      return;
    }
    setTimeout(tick, CHECK_INTERVAL_MS);
  };
  setTimeout(tick, CHECK_INTERVAL_MS);
}

/** Track the active connection's send queue so shutdown can drain it. */
let activeState: ConnectionState | null = null;

/**
 * Handle WebSocket upgrade requests
 */
httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
  const requestUrl = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? 'localhost'}`
  );
  const requestPath = requestUrl.pathname;

  // Validate path
  if (requestPath !== WEBSOCKET_PATH) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // Parse server configuration from query parameters
  const host = requestUrl.searchParams.get('host');
  const portStr = requestUrl.searchParams.get('port');
  const port = portStr ? Number.parseInt(portStr, 10) : null;
  const tls = requestUrl.searchParams.get('tls') === 'true';
  const VALID_ENCODINGS: ReadonlySet<BufferEncoding> = new Set([
    'utf8', 'utf-8', 'ascii', 'latin1', 'binary', 'utf16le', 'utf-16le', 'ucs2', 'ucs-2', 'base64', 'hex',
  ]);
  const rawEncoding = requestUrl.searchParams.get('encoding') ?? 'utf8';
  const encoding: BufferEncoding = VALID_ENCODINGS.has(rawEncoding as BufferEncoding) ? (rawEncoding as BufferEncoding) : 'utf8';

  // Validate required parameters
  if (!host || !port || Number.isNaN(port) || port < 1 || port > 65535) {
    socket.write('HTTP/1.1 400 Bad Request - Missing or invalid host/port\r\n\r\n');
    socket.destroy();
    return;
  }

  // Only allow one connection at a time (local backend)
  if (connectedClient !== null) {
    socket.write('HTTP/1.1 409 Conflict - Already connected\r\n\r\n');
    socket.destroy();
    return;
  }

  // Accept WebSocket connection
  wss.handleUpgrade(request, socket, head, (ws) => {
    handleNewClient(ws, { host, port, tls, encoding });
  });
});

/**
 * Handle a new WebSocket client connection
 */
function handleNewClient(
  ws: WebSocket,
  serverConfig: { host: string; port: number; tls: boolean; encoding: BufferEncoding }
): void {
  connectedClient = ws;
  console.log(`\x1b[36m${new Date().toISOString()} Client connected, target: ${sanitizeLog(serverConfig.host)}:${serverConfig.port}\x1b[0m`);

  // Create IRC client and connect — capture local references so closures
  // never touch a different connection's state on rapid reconnect.
  const client = new IrcClient();
  ircClient = client;

  // Per-connection state. Keeping this outside module scope means a rapid
  // disconnect+reconnect can't race the shared sendQueue — each connection
  // owns its own queue for its entire lifetime.
  const state: ConnectionState = {
    ws,
    client,
    sendQueue: Promise.resolve(),
    messageCount: 0,
    rateLimitWindowStart: Date.now(),
    paused: false,
  };
  activeState = state;

  setupIrcEventHandlers(state);

  client.connectRaw({
    host: serverConfig.host,
    port: serverConfig.port,
    tls: serverConfig.tls,
    encoding: serverConfig.encoding,
  });

  // Handle incoming WebSocket messages (encrypted raw IRC commands)
  ws.on('message', async (data: Buffer) => {
    // Rate limiting (sliding window, per-connection)
    const now = Date.now();
    if (now - state.rateLimitWindowStart > RATE_LIMIT_WINDOW_MS) {
      state.messageCount = 0;
      state.rateLimitWindowStart = now;
    }
    state.messageCount++;
    if (state.messageCount > RATE_LIMIT_MAX_MESSAGES) {
      return;
    }

    try {
      const decrypted = await decryptString(data.toString());
      // Handle multiple lines (some clients might batch)
      const lines = decrypted.split(/[\r\n]+/).filter((line) => line.length > 0);
      for (const line of lines) {
        client.send(line);
      }
    } catch (error) {
      // Decryption failures are always logged (key mismatch, corruption, or
      // attacker-sent garbage). Silent drops in production mean no way to
      // diagnose broken clients or probe attempts.
      console.error(`\x1b[31m${new Date().toISOString()} Error decrypting message: ${sanitizeLog(String(error))}\x1b[0m`);
    }
  });

  // Handle WebSocket close
  ws.on('close', () => {
    console.log(`\x1b[36m${new Date().toISOString()} Client disconnected\x1b[0m`);
    client.quit(defaultIrcQuitMessage);
    // Only clear globals if they still belong to this connection
    if (ircClient === client) ircClient = null;
    if (connectedClient === ws) connectedClient = null;
    if (activeState === state) activeState = null;
  });

  // Handle WebSocket error
  ws.on('error', (error: Error) => {
    console.error(`\x1b[31m${new Date().toISOString()} WebSocket error: ${sanitizeLog(error.message)}\x1b[0m`);
  });
}

/**
 * Set up event handlers for IRC client.
 * Uses the state reference so stale events from a previous connection
 * never interfere with a newer one.
 */
function setupIrcEventHandlers(state: ConnectionState): void {
  const { client, ws } = state;

  // Raw IRC message from server - forward to WebSocket client (encrypted)
  client.on('raw', (line: string, inbound: boolean) => {
    if (inbound) {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`${new Date().toISOString()} >> ${sanitizeLog(line.trim())}`);
      }
      sendRawToClient(state, line).catch((err) => {
        console.error(`\x1b[31m${new Date().toISOString()} Failed to send to client: ${sanitizeLog(String(err))}\x1b[0m`);
      });
    } else if (process.env.NODE_ENV !== 'production') {
      console.log(`\x1b[32m${new Date().toISOString()} << ${sanitizeLog(line.trim())}\x1b[0m`);
    }
  });

  // IRC connection closed - wait for pending messages (e.g. 465, ERROR) to be
  // delivered before sending the WebSocket close frame.
  client.on('close', () => {
    void state.sendQueue.then(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });
  });

  // Socket error — always log, even in production
  client.on('error', (error: Error) => {
    console.error(`\x1b[31m${new Date().toISOString()} IRC error: ${sanitizeLog(error.message)}\x1b[0m`);
    sendRawToClient(state, `ERROR :${stripCRLF(error.message)}`).catch((err) => {
      console.error(`\x1b[31m${new Date().toISOString()} Failed to send error to client: ${sanitizeLog(String(err))}\x1b[0m`);
    });
  });
}

// Surface listen errors (EADDRINUSE, EACCES, etc.) so a failed bind doesn't
// leave the process running in a silent half-dead state.
httpServer.on('error', (error: NodeJS.ErrnoException) => {
  console.error(
    `\x1b[31m${new Date().toISOString()} HTTP server error${error.code ? ` (${error.code})` : ''}: ${sanitizeLog(error.message)}\x1b[0m`
  );
});

// Start server
httpServer.listen(defaultWebsocketPort, '127.0.0.1', () => {
  console.log(`\x1b[32m${new Date().toISOString()} Server started on ws://127.0.0.1:${defaultWebsocketPort}${WEBSOCKET_PATH}\x1b[0m`);
});

// Maximum time to wait for the active connection's send queue to drain
// during shutdown — bounded so a stuck write can't block SIGTERM forever.
const SHUTDOWN_DRAIN_TIMEOUT_MS = 3000;

// Graceful shutdown
let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\x1b[33m${new Date().toISOString()} Shutting down...\x1b[0m`);

  const pendingQueue = activeState?.sendQueue ?? Promise.resolve();

  if (ircClient) {
    ircClient.quit(defaultIrcQuitMessage);
    ircClient = null;
  }

  // Wait for any in-flight encrypted writes (ERROR, 465, final QUIT ack) to
  // be delivered before closing the WebSocket. Without this the last few
  // IRC messages routinely get lost on shutdown.
  const drainDeadline = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS));
  Promise.race([pendingQueue, drainDeadline])
    .catch(() => {
      // ignore — we just want the drain attempt
    })
    .finally(() => {
      if (connectedClient) {
        connectedClient.close();
        connectedClient = null;
      }
      wss.close();
      httpServer.close(() => {
        console.log(`\x1b[33m${new Date().toISOString()} Server stopped\x1b[0m`);
        process.exit(0);
      });
      // Hard timeout — if httpServer.close never calls back (e.g. a stuck
      // client), don't leave the process hanging forever.
      setTimeout(() => process.exit(0), SHUTDOWN_DRAIN_TIMEOUT_MS).unref();
    });
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
