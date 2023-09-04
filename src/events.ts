import { defaultIrcGecosMessage, defaultIrcVersionMessage, defaultQuitMessage } from './config';
import { type ConnectCommandPayload, type DisconnectCommandPayload, IrcCommand, type RawCommandPayload, type SICWebSocketPayload } from './types';

/**
 * Events from Client
 *
 * @param event
 * @returns
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handleEvents = (ircClient: any, event: SICWebSocketPayload): void => {
  switch (event.type) {
    case IrcCommand.connect: {
      const connectMessage = event as ConnectCommandPayload;
      const connectParameters = {
        auto_reconnect: false,
        auto_reconnect_max_retries: 3,
        auto_reconnect_wait: 4000,
        enable_chghost: false,
        enable_echomessage: false,
        enable_setname: false,
        encoding: connectMessage.event.server.encoding ?? 'utf8',
        gecos: defaultIrcGecosMessage,
        host: connectMessage.event.server.host,
        message_max_length: 350,
        nick: connectMessage.event.nick,
        ping_interval: 30,
        ping_timeout: 120,
        port: connectMessage.event.server.port,
        username: connectMessage.event.nick,
        version: defaultIrcVersionMessage,
      };

      ircClient.connect(connectParameters);
      break;
    }
    case IrcCommand.disconnect: {
      const disconnectMessage = event as DisconnectCommandPayload;
      let quitReason = defaultQuitMessage;
      if (disconnectMessage?.event?.quitReason !== undefined) {
        quitReason = disconnectMessage.event.quitReason;
      }
      ircClient.quit(quitReason);
      break;
    }
    case IrcCommand.raw: {
      const rawMessage = event as RawCommandPayload;
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      if (rawMessage?.event?.rawData) {
        ircClient.raw(rawMessage.event.rawData);
      }
      break;
    }
  }
};
