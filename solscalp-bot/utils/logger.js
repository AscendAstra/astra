/**
 * Simple structured logger
 */
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const LOG_DIR = './logs';
const LOG_FILE = join(LOG_DIR, `bot-${new Date().toISOString().split('T')[0]}.log`);

try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

export function log(level, message) {
  const ts = new Date().toISOString();
  const levels = { info: '✦', warn: '⚠', error: '✖', success: '✔' };
  const icon = levels[level] || '·';
  const line = `[${ts}] ${icon} [${level.toUpperCase().padEnd(5)}] ${message}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}