import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { allowedOrigins, defaultWebsocketPort, encryptionKey } from './config.js';
import { handleEvents } from './events.js';
import { Client } from './irc-client.js';
import { initEncryption, encryptMessage, decryptMessage } from './encryption.js';

// Initialize encryption
initEncryption(encryptionKey).then(() => {
  console.log(`\x1b[32m${new Date().toISOString()} Encryption enabled\x1b[0m`);
});

console.log(`\x1b[31m${new Date().toISOString()} websocket port: ${defaultWebsocketPort}\x1b[0m`);
export const sicServerSocket = new WebSocketServer({ port: defaultWebsocketPort, path: '/SimpleIrcClient' });

let connectedClient: WebSocket | null = null;

const sendToClient = async (event: string, data: any): Promise<void> => {
  if (connectedClient?.readyState === WebSocket.OPEN) {
    const encrypted = await encryptMessage({ event, data });
    connectedClient.send(encrypted);
  }
};

const onClientEvent = (data: any): void => {
  handleEvents(ircClient, data);
};

sicServerSocket.on('connection', (ws: WebSocket, request: IncomingMessage) => {
  console.log(`\x1b[33m${new Date().toISOString()} new connection\x1b[0m`);

  const origin = request.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    console.log(`\x1b[31m${new Date().toISOString()} rejected connection from origin: ${origin}\x1b[0m`);
    ws.close(1008, 'Origin not allowed');
    return;
  }

  if (connectedClient === null) {
    connectedClient = ws;
    console.log(`\x1b[33m${new Date().toISOString()} client connected\x1b[0m`);
  }

  ws.on('message', async (message: any) => {
    try {
      console.log(`\x1b[34m${new Date().toISOString()} ${message}\x1b[0m`);

      const parsedData = (await decryptMessage(message.toString())) as { event?: string; data?: unknown };

      if (parsedData.event === 'sic-client-event') {
        onClientEvent(parsedData.data);
      }
    } catch (error) {
      console.error(`\x1b[31m${new Date().toISOString()} Error parsing message: ${JSON.stringify(error)}\x1b[0m`);
    }
  });

  ws.on('close', () => {
    console.log(`\x1b[33m${new Date().toISOString()} client disconnected\x1b[0m`);
    if (connectedClient !== null) {
      handleEvents(ircClient, { type: 'disconnect' });
      connectedClient = null;
    }
  });

  ws.on('error', (error: Error) => {
    console.error(`\x1b[31mWebSocket error: ${JSON.stringify(error)}\x1b[0m`);
  });
});

export const ircClient = new Client();

// Once the client has connected and successfully registered on the IRC network.
// This is a good place to start joining channels.
//
// {
//     nick: nick
// }
ircClient.on('connected', (_event: unknown) => {
  sendToClient('sic-irc-event', { type: 'connected' });
});

// The client has disconnected from the network and failed to auto reconnect (if enabled).
//
// { }
ircClient.on('close', (_event: unknown) => {
  sendToClient('sic-irc-event', { type: 'close' });
});

// The client has disconnected from the network.
//
// { }
ircClient.on('socket close', (_event: unknown) => {
  sendToClient('sic-irc-event', { type: 'socket close' });
});

// The client has a connected socket to the network. Network registration will automatically start at this point.
//
// { }
ircClient.on('socket connected', (_event: unknown) => {
  sendToClient('sic-irc-event', { type: 'socket connected' });
});

// A valid raw line sent or received from the IRC server.
//
// {
//     line: ':server.ircd.net 265 prawnsalad :Current Local Users: 214  Max: 411',
//     from_server: true
// }
ircClient.on('raw', (event: any) => {
  if (event?.from_server && event?.line) {
    console.log(`${new Date().toISOString()} >> ${event.line?.trim()}`);
    sendToClient('sic-irc-event', { type: 'raw', line: event.line });
  }
  if (!event?.from_server && event?.line) {
    console.log(`\x1b[32m${new Date().toISOString()} << ${event.line?.trim()}\x1b[0m`);
    sendToClient('sic-server-event', { type: 'raw', line: event.line });
  }
});
