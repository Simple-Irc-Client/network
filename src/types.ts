// https://github.com/kiwiirc/irc-framework/blob/master/docs/clientapi.md

export enum IrcEvents {
  connected = 'connected',
  close = 'close',
  socketClose = 'socket close',
  socketConnected = 'socket connected',
  raw = 'raw',
}

export enum IrcCommand {
  connect = 'connect',
  disconnect = 'disconnect',
  raw = 'raw',
}

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
