export const defaultWebsocketPort = 8667;
export const defaultIrcQuitMessage = 'Simple Irc Client ( https://simpleircclient.com )';

// AES-256-GCM encryption key (32 bytes, base64 encoded)
// Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Set via ENCRYPTION_KEY environment variable (must match the client's VITE_ENCRYPTION_KEY)
export const encryptionKey = process.env['ENCRYPTION_KEY'] || '';
