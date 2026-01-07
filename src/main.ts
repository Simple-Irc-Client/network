/* eslint-disable @typescript-eslint/no-unused-vars */
import { WebSocketServer, WebSocket } from 'ws';
import { defaultWebsocketPort } from './config';
import { handleEvents } from './events';
// @ts-expect-error missing ts declaration file
import * as IRC from 'irc-framework';

console.log(`websocket port: ${defaultWebsocketPort}`);
export const sicServerSocket = new WebSocketServer({ port: defaultWebsocketPort, path: '/SimpleIrcClient' });

const connectedClients = new Set<WebSocket>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const broadcastToClients = (event: string, data: any): void => {
  const message = JSON.stringify({ event, data });
  connectedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const onClientEvent = (data: any): void => {
  handleEvents(ircClient, data);
};

sicServerSocket.on('connection', (ws: WebSocket) => {
  console.log(`connection ${new Date().toISOString()}`);
  connectedClients.add(ws);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ws.on('message', (message: any) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`${new Date().toISOString()} message: ${JSON.stringify(data)}`); // TODO debug

      if (data.event === 'sic-client-event') {
        onClientEvent(data.payload);
      }
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    connectedClients.delete(ws);
    handleEvents(ircClient, { type: 'disconnect' });
  });

  ws.on('error', (error: Error) => {
    console.error('WebSocket error:', error);
  });
});

export const ircClient = new IRC.Client();

// Once the client has connected and successfully registered on the IRC network.
// This is a good place to start joining channels.
//
// {
//     nick: nick
// }
ircClient.on('connected', (_event: unknown) => {
  broadcastToClients('sic-irc-event', { type: 'connected' });
});

// The client has disconnected from the network and failed to auto reconnect (if enabled).
//
// { }
ircClient.on('close', (_event: unknown) => {
  broadcastToClients('sic-irc-event', { type: 'close' });
});

// The client has disconnected from the network.
//
// { }
ircClient.on('socket close', (_event: unknown) => {
  broadcastToClients('sic-irc-event', { type: 'socket close' });
});

// The client has a connected socket to the network. Network registration will automatically start at this point.
//
// { }
ircClient.on('socket connected', (_event: unknown) => {
  broadcastToClients('sic-irc-event', { type: 'socket connected' });
});

// A valid raw line sent or received from the IRC server.
//
// {
//     line: ':server.ircd.net 265 prawnsalad :Current Local Users: 214  Max: 411',
//     from_server: true
// }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
ircClient.on('raw', (event: any) => {
  if (event?.from_server && event?.line) {
    broadcastToClients('sic-irc-event', { type: 'raw', line: event.line });
  }
  if (!event?.from_server && event?.line) {
    console.log(`<< ${event.line}`);
    broadcastToClients('sic-server-event', { type: 'raw', line: event.line });
  }
});
