import * as ws from "ws";
import { defaultQuitMessage, port } from "./config";
import { ircClient } from "./irc";
import { handleEvents } from "./events";

// Extended websocket class - added isAlive variable for timeout checking
export interface ExtWebSocket extends ws {
  isAlive: boolean;
}

console.log("ws port:" + port);
const SICWebSocketServer = new ws.Server({ port });

SICWebSocketServer.on("connection", function onConnection(webSocket: ws) {
  console.log("websocket event connection");

  const extWs: ExtWebSocket = webSocket as ExtWebSocket;
  extWs.isAlive = true;

  extWs.on("pong", () => {
    extWs.isAlive = true;
  });

  extWs.on("error", () => {
    console.log("websocket event error");
  });

  extWs.on("close", () => {
    console.log("websocket event close");

    ircClient.quit(defaultQuitMessage);
  });

  extWs.on("open", () => {
    console.log("websocket event open");
  });

  extWs.on("message", (message: string) => {
    console.log(`websocket event message: ${JSON.stringify(message)}`);

    handleEvents(message);
  });
});

setInterval(function ping() {
  SICWebSocketServer.clients.forEach((webSocket: ws.WebSocket) => {
    const extWs: ExtWebSocket = webSocket as ExtWebSocket;
    if (!extWs.isAlive) {
      webSocket.terminate();

      return;
    }

    extWs.isAlive = false;
    extWs.ping();
  });
}, 30_000); // 30 sec

export { SICWebSocketServer };
