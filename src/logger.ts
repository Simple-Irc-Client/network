import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Logger for IRC messages when NODE_ENV is 'local'
 * Writes incoming and outgoing messages to ./logs-{date}.txt
 */

// Ensure logs directory exists
const LOG_DIR = './logs';
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

// Generate log filename with current date
const getLogFilename = (): string => {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD format
  return join(LOG_DIR, `logs-${dateStr}.txt`);
};

// Create or append to log file
let logStream: ReturnType<typeof createWriteStream> | null = null;

const getLogStream = (): ReturnType<typeof createWriteStream> => {
  if (!logStream) {
    const filename = getLogFilename();
    logStream = createWriteStream(filename, { flags: 'a' }); // append mode
    
    // Log initialization
    const initMessage = `=== Logging started at ${new Date().toISOString()} ===\n`;
    logStream.write(initMessage);
  }
  return logStream;
};

/**
 * Log IRC message to file
 * @param message The IRC message line
 * @param direction '>>' for incoming, '<<' for outgoing
 */
export const logIrcMessage = (message: string, direction: '>>' | '<<'): void => {
  if (process.env.NODE_ENV !== 'local') {
    return;
  }
  
  try {
    const logStream = getLogStream();
    const timestamp = new Date().toISOString();
    const sanitizedMessage = message.replace(/[\r\n]/g, '').trim();
    const logLine = `${timestamp} ${direction} ${sanitizedMessage}\n`;
    logStream.write(logLine);
  } catch (error) {
    console.error(`Failed to write to log file: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * Close the log stream (call on shutdown)
 */
export const closeLogger = (): void => {
  if (logStream) {
    const closeMessage = `=== Logging ended at ${new Date().toISOString()} ===\n`;
    logStream.write(closeMessage);
    logStream.end();
    logStream = null;
  }
};