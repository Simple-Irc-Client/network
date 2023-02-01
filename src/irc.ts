import * as ws from "ws";
// @ts-ignore
import * as IRC from "irc-framework";
import { IrcEvents, WebSocketPayload } from "./types";
import { SICWebSocketServer } from "./websocket";

function sendIRCEventToWSClient(type: IrcEvents, event?: unknown): void {
  console.log(`<- ${type} ${event}`);

  const payload = new WebSocketPayload(type, event);
  const payloadJSON = JSON.stringify(payload);

  SICWebSocketServer.clients.forEach((webSocket: ws.WebSocket) => {
    if (webSocket.readyState === ws.WebSocket.OPEN) {
      webSocket.send(payloadJSON);
    }
  });
}

const ircClient = new IRC.Client();

// Once the client has connected and successfully registered on the IRC network.
// This is a good place to start joining channels.
//
// {
//     nick: nick
// }
ircClient.on(IrcEvents.connected, (_event: unknown) => {
  sendIRCEventToWSClient(IrcEvents.connected);
});

// The client has disconnected from the network and failed to auto reconnect (if enabled).
//
// { }
ircClient.on(IrcEvents.close, (_event: unknown) => {
  sendIRCEventToWSClient(IrcEvents.close);
});

// The client has disconnected from the network.
//
// { }
ircClient.on(IrcEvents.socketClose, (_event: unknown) => {
  sendIRCEventToWSClient(IrcEvents.socketClose);
});

// The client has a connected socket to the network. Network registration will automatically start at this point.
//
// { }
ircClient.on(IrcEvents.socketConnected, (_event: unknown) => {
  sendIRCEventToWSClient(IrcEvents.socketConnected);
});

// A valid raw line sent or received from the IRC server.
//
// {
//     line: ':server.ircd.net 265 prawnsalad :Current Local Users: 214  Max: 411',
//     from_server: true
// }
ircClient.on(IrcEvents.raw, (event: any) => {
  if (event?.line) {
    sendIRCEventToWSClient(IrcEvents.raw, event.line);
  }
});

export { ircClient };
