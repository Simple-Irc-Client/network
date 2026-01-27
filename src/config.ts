export const defaultWebsocketPort = 8667;
export const defaultIrcQuitMessage = 'Simple Irc Client ( https://simpleircclient.com )';
export const defaultIrcGecosMessage = 'Simple Irc Client user';

export const allowedOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];

// AES-256-GCM encryption key (32 bytes, base64 encoded)
// Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
export const encryptionKey = 'K7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols=';
