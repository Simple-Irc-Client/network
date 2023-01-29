import { defaultIrcGecosMessage, defaultIrcVersionMessage, defaultQuitMessage } from "./config";
import { ircClient } from "./irc";
import {
  ConnectCommandPayload,
  DisconnectCommandPayload,
  IrcCommand,
  RawCommandPayload,
  SICWebSocketPayload,
} from "./types";

/**
 * Events from Client
 *
 * @param message
 * @returns
 */
export const handleEvents = (message: string): void => {
  let webSocketMessage: SICWebSocketPayload;

  try {
    webSocketMessage = JSON.parse(message);
  } catch (e) {
    console.log("incorrect json message:" + message);
    return;
  }

  switch (webSocketMessage.type) {
    case IrcCommand.connect: {
      const connectMessage = webSocketMessage as ConnectCommandPayload;
      ircClient.connect({
        auto_reconnect: true,
        auto_reconnect_max_retries: 3,
        auto_reconnect_wait: 4000,
        enable_chghost: false,
        enable_echomessage: false,
        enable_setname: false,
        encoding: connectMessage.event.server.encoding || "utf8",
        gecos: defaultIrcGecosMessage,
        host: connectMessage.event.server.host,
        message_max_length: 350,
        nick: connectMessage.event.nick,
        ping_interval: 30,
        ping_timeout: 120,
        port: connectMessage.event.server.port,
        username: connectMessage.event.nick,
        version: defaultIrcVersionMessage,
      });
      break;
    }
    case IrcCommand.disconnect: {
      const disconnectMessage = webSocketMessage as DisconnectCommandPayload;
      let quitReason = defaultQuitMessage;
      if (disconnectMessage.event !== undefined && disconnectMessage.event.quitReason !== undefined) {
        quitReason = disconnectMessage.event.quitReason;
      }
      ircClient.quit(quitReason);
      break;
    }
    case IrcCommand.raw: {
      const rawMessage = webSocketMessage as RawCommandPayload;
      if (rawMessage.event.rawData) {
        ircClient.raw(rawMessage.event.rawData);
      }
      break;
    }
  }
};
