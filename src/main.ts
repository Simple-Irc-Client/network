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

// Initialize encryption
initEncryption(encryptionKey).then(() => {
  console.log(`\x1b[32m${new Date().toISOString()} Encryption enabled\x1b[0m`);
});

// HTTP server for handling WebSocket upgrades
const httpServer = createServer((_request, response) => {
  response.end('Simple IRC Client Backend');
});

const wss = new WebSocketServer({ noServer: true });

let connectedClient: WebSocket | null = null;
let ircClient: Client | null = null;

/**
 * Send a raw IRC line to the WebSocket client (encrypted)
 */
const sendRawToClient = async (line: string): Promise<void> => {
  if (connectedClient?.readyState === WebSocket.OPEN) {
    const encrypted = await encryptString(line);
    connectedClient.send(encrypted);
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
  const encoding = (requestUrl.searchParams.get('encoding') ?? 'utf8') as BufferEncoding;

  // Validate required parameters
  if (!host || !port || isNaN(port)) {
    socket.write('HTTP/1.1 400 Bad Request - Missing host or port\r\n\r\n');
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
  console.log(`\x1b[36m${new Date().toISOString()} Client connected, target: ${serverConfig.host}:${serverConfig.port}\x1b[0m`);

  // Create IRC client and connect
  ircClient = new Client();
  setupIrcEventHandlers(ircClient);

  ircClient.connectRaw({
    host: serverConfig.host,
    port: serverConfig.port,
    tls: serverConfig.tls,
    encoding: serverConfig.encoding,
  });

  // Handle incoming WebSocket messages (encrypted raw IRC commands)
  ws.on('message', async (data: Buffer) => {
    try {
      const decrypted = await decryptString(data.toString());
      // Handle multiple lines (some clients might batch)
      const lines = decrypted.split(/\r?\n/).filter((line) => line.length > 0);
      for (const line of lines) {
        if (ircClient) {
          ircClient.raw(line);
        }
      }
    } catch (error) {
      console.error(`\x1b[31m${new Date().toISOString()} Error decrypting message: ${error}\x1b[0m`);
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
    console.error(`\x1b[31m${new Date().toISOString()} WebSocket error: ${error.message}\x1b[0m`);
  });
}

/**
 * Set up event handlers for IRC client
 */
function setupIrcEventHandlers(client: Client): void {
  // Raw IRC message from server - forward to WebSocket client (encrypted)
  client.on('raw', (event: { line: string; from_server: boolean }) => {
    if (event.from_server) {
      console.log(`${new Date().toISOString()} >> ${event.line.trim()}`);
      sendRawToClient(event.line);
    } else {
      console.log(`\x1b[32m${new Date().toISOString()} << ${event.line.trim()}\x1b[0m`);
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
    console.error(`\x1b[31m${new Date().toISOString()} IRC error: ${error.message}\x1b[0m`);
    sendRawToClient(`ERROR :${error.message}`);
  });
}

// Start server
httpServer.listen(defaultWebsocketPort, () => {
  console.log(`\x1b[32m${new Date().toISOString()} Server started on ws://localhost:${defaultWebsocketPort}${WEBSOCKET_PATH}\x1b[0m`);
});
