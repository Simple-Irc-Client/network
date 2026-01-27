import { defaultIrcGecosMessage, defaultIrcQuitMessage } from './config.js';
import { type ConnectCommandPayload, type DisconnectCommandPayload, type RawCommandPayload, type SICWebSocketPayload } from './types.js';

/**
 * Events from Client
 *
 * @param event
 * @returns
 */
export const handleEvents = (ircClient: any, event: SICWebSocketPayload): void => {
  switch (event?.type) {
    case 'connect': {
      const connectMessage = event as ConnectCommandPayload;
      const connectParameters = {
        encoding: connectMessage.event.server.encoding ?? 'utf8',
        gecos: defaultIrcGecosMessage,
        host: connectMessage.event.server.host,
        nick: connectMessage.event.nick,
        ping_interval: 30,
        ping_timeout: 120,
        port: connectMessage.event.server.port,
        username: connectMessage.event.nick,
      };

      ircClient.connect(connectParameters);
      break;
    }
    case 'disconnect': {
      const disconnectMessage = event as DisconnectCommandPayload;
      let quitReason = defaultIrcQuitMessage;
      if (disconnectMessage?.event?.quitReason !== undefined) {
        quitReason = disconnectMessage.event.quitReason;
      }
      ircClient.quit(quitReason);
      break;
    }
    case 'raw': {
      const rawMessage = event as RawCommandPayload;
      if (rawMessage?.event?.rawData) {
        ircClient.raw(rawMessage.event.rawData);
      }
      break;
    }
  }
};
