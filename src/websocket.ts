import { Server } from "socket.io";
import { port } from "./config";
import { handleEvents } from "./events";

console.log(`websocket port: ${port}`);
export const sicServerSocket = new Server(port, { cors: { origin: "*" } });

sicServerSocket.on("connection", (socket) => {
  console.log(`connection - ${new Date().toISOString()}`);

  socket.on("sic-client-event", (data) => {
    handleEvents(data);
  });
});
