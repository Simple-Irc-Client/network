// @ts-ignore
import * as IRC from "irc-framework";
import { IrcEvents } from "./types";
import { sicServerSocket } from "./main";

export const ircClient = new IRC.Client();

// Once the client has connected and successfully registered on the IRC network.
// This is a good place to start joining channels.
//
// {
//     nick: nick
// }
ircClient.on(IrcEvents.connected, (_event: unknown) => {
  sicServerSocket.emit("sic-irc-event", { type: IrcEvents.connected });
});

// The client has disconnected from the network and failed to auto reconnect (if enabled).
//
// { }
ircClient.on(IrcEvents.close, (_event: unknown) => {
  sicServerSocket.emit("sic-irc-event", { type: IrcEvents.close });
});

// The client has disconnected from the network.
//
// { }
ircClient.on(IrcEvents.socketClose, (_event: unknown) => {
  sicServerSocket.emit("sic-irc-event", { type: IrcEvents.socketClose });
});

// The client has a connected socket to the network. Network registration will automatically start at this point.
//
// { }
ircClient.on(IrcEvents.socketConnected, (_event: unknown) => {
  sicServerSocket.emit("sic-irc-event", { type: IrcEvents.socketConnected });
});

// A valid raw line sent or received from the IRC server.
//
// {
//     line: ':server.ircd.net 265 prawnsalad :Current Local Users: 214  Max: 411',
//     from_server: true
// }
ircClient.on(IrcEvents.raw, (event: any) => {
  if (event?.from_server && event?.line) {
    sicServerSocket.emit("sic-irc-event", { type: IrcEvents.raw, line: event.line });
  }
  if (!event?.from_server && event?.line) {
    console.log(`-> ${event.line}`);
  }
});
