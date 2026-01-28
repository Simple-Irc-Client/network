// https://github.com/kiwiirc/irc-framework/blob/master/docs/clientapi.md

export type IrcEvents = 'connected' | 'close' | 'socket close' | 'socket connected' | 'raw';

export type IrcCommand = 'connect' | 'disconnect' | 'raw';

export interface SICWebSocketPayload {
  type: IrcEvents | IrcCommand;
  event?: unknown;
}

export interface ConnectCommandPayload {
  type: string;
  event: {
    nick: string;
    server: {
      host: string;
      port: number;
      encoding?: string;
      tls?: boolean;
    };
  };
}

export interface DisconnectCommandPayload {
  type: string;
  event?: {
    quitReason?: string;
  };
}

export interface RawCommandPayload {
  type: string;
  event: {
    rawData: string[];
  };
}
