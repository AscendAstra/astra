/**
 * Simple structured logger
 */

export function log(level, message) {
  const ts = new Date().toISOString();
  const levels = { info: '✦', warn: '⚠', error: '✖', success: '✅' };
  const icon = levels[level] || '·';
  console.log(`[${ts}] ${icon} [${level.toUpperCase().padEnd(5)}] ${message}`);
}
