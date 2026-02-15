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
import { createServer, IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { defaultWebsocketPort, defaultIrcQuitMessage, encryptionKey } from './config.js';
import { Client } from './irc-client.js';
import { initEncryption, encryptString, decryptString } from './encryption.js';

const WEBSOCKET_PATH = '/webirc';

/** Strip control/escape characters from untrusted strings before logging */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x1b]/g;
const sanitizeLog = (s: string): string => s.replace(CONTROL_RE, '');

/** Strip CR/LF to prevent IRC line injection in constructed messages */
const stripCRLF = (s: string): string => s.replace(/[\r\n]/g, '');

// Initialize encryption
initEncryption(encryptionKey).then(() => {
  if (encryptionKey) {
    console.log(`\x1b[32m${new Date().toISOString()} Encryption enabled\x1b[0m`);
  } else {
    console.log(`\x1b[33m${new Date().toISOString()} Encryption disabled (no ENCRYPTION_KEY set)\x1b[0m`);
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
let ircClient: Client | null = null;

// Rate limiting: max 50 messages per 5-second window
const RATE_LIMIT_MAX_MESSAGES = 50;
const RATE_LIMIT_WINDOW_MS = 5000;
let messageCount = 0;
let rateLimitWindowStart = 0;

/**
 * Send a raw IRC line to the WebSocket client (encrypted)
 */
const sendRawToClient = async (line: string): Promise<void> => {
  if (connectedClient?.readyState === WebSocket.OPEN) {
    try {
      const encrypted = await encryptString(line);
      connectedClient.send(encrypted);
    } catch {
      // Fail closed — drop the message rather than sending unencrypted
    }
  }
};

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
  const port = portStr ? parseInt(portStr, 10) : null;
  const tls = requestUrl.searchParams.get('tls') === 'true';
  const VALID_ENCODINGS: ReadonlySet<BufferEncoding> = new Set([
    'utf8', 'utf-8', 'ascii', 'latin1', 'binary', 'utf16le', 'utf-16le', 'ucs2', 'ucs-2', 'base64', 'hex',
  ]);
  const rawEncoding = requestUrl.searchParams.get('encoding') ?? 'utf8';
  const encoding: BufferEncoding = VALID_ENCODINGS.has(rawEncoding as BufferEncoding) ? (rawEncoding as BufferEncoding) : 'utf8';

  // Validate required parameters
  if (!host || !port || isNaN(port) || port < 1 || port > 65535) {
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

  // Create IRC client and connect
  ircClient = new Client();
  setupIrcEventHandlers(ircClient);

  ircClient.connectRaw({
    host: serverConfig.host,
    port: serverConfig.port,
    tls: serverConfig.tls,
    encoding: serverConfig.encoding,
  });

  // Reset rate limit state for new connection
  messageCount = 0;
  rateLimitWindowStart = Date.now();

  // Handle incoming WebSocket messages (encrypted raw IRC commands)
  ws.on('message', async (data: Buffer) => {
    // Rate limiting
    const now = Date.now();
    if (now - rateLimitWindowStart > RATE_LIMIT_WINDOW_MS) {
      messageCount = 0;
      rateLimitWindowStart = now;
    }
    messageCount++;
    if (messageCount > RATE_LIMIT_MAX_MESSAGES) {
      return;
    }

    try {
      const decrypted = await decryptString(data.toString());
      // Handle multiple lines (some clients might batch)
      const lines = decrypted.split(/[\r\n]+/).filter((line) => line.length > 0);
      for (const line of lines) {
        if (ircClient) {
          ircClient.raw(line);
        }
      }
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(`\x1b[31m${new Date().toISOString()} Error decrypting message: ${sanitizeLog(String(error))}\x1b[0m`);
      }
    }
  });

  // Handle WebSocket close
  ws.on('close', () => {
    console.log(`\x1b[36m${new Date().toISOString()} Client disconnected\x1b[0m`);
    if (ircClient) {
      ircClient.quit(defaultIrcQuitMessage);
      ircClient = null;
    }
    connectedClient = null;
  });

  // Handle WebSocket error
  ws.on('error', (error: Error) => {
    console.error(`\x1b[31m${new Date().toISOString()} WebSocket error: ${sanitizeLog(error.message)}\x1b[0m`);
  });
}

/**
 * Set up event handlers for IRC client
 */
function setupIrcEventHandlers(client: Client): void {
  // Raw IRC message from server - forward to WebSocket client (encrypted)
  client.on('raw', (event: { line: string; from_server: boolean }) => {
    if (event.from_server) {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`${new Date().toISOString()} >> ${sanitizeLog(event.line.trim())}`);
      }
      sendRawToClient(event.line).catch((err) => {
        console.error(`\x1b[31m${new Date().toISOString()} Failed to send to client: ${sanitizeLog(String(err))}\x1b[0m`);
      });
    } else {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`\x1b[32m${new Date().toISOString()} << ${sanitizeLog(event.line.trim())}\x1b[0m`);
      }
    }
  });

  // IRC connection closed - close WebSocket
  client.on('close', () => {
    if (connectedClient?.readyState === WebSocket.OPEN) {
      connectedClient.close();
    }
  });

  // Socket error
  client.on('error', (error: Error) => {
    console.error(`\x1b[31m${new Date().toISOString()} IRC error: ${sanitizeLog(error.message)}\x1b[0m`);
    sendRawToClient(`ERROR :${stripCRLF(error.message)}`).catch((err) => {
      console.error(`\x1b[31m${new Date().toISOString()} Failed to send error to client: ${sanitizeLog(String(err))}\x1b[0m`);
    });
  });
}

// Start server
httpServer.listen(defaultWebsocketPort, '127.0.0.1', () => {
  console.log(`\x1b[32m${new Date().toISOString()} Server started on ws://127.0.0.1:${defaultWebsocketPort}${WEBSOCKET_PATH}\x1b[0m`);
});

// Graceful shutdown
const shutdown = () => {
  console.log(`\x1b[33m${new Date().toISOString()} Shutting down...\x1b[0m`);
  if (ircClient) {
    ircClient.quit(defaultIrcQuitMessage);
    ircClient = null;
  }
  if (connectedClient) {
    connectedClient.close();
    connectedClient = null;
  }
  wss.close();
  httpServer.close(() => {
    console.log(`\x1b[33m${new Date().toISOString()} Server stopped\x1b[0m`);
    process.exit(0);
  });
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
