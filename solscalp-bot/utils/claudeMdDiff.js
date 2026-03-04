/**
 * ASTRA CLAUDE.md Differ
 * Compares CLAUDE.md against a saved snapshot on each restart.
 * Posts a sanitized summary to Discord showing what changed.
 *
 * Privacy: lines matching sensitive patterns (api keys, secrets, .env refs) are stripped.
 * Snapshot: data/claude_md_snapshot.txt
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_MD_PATH = join(__dirname, '../CLAUDE.md');
const SNAPSHOT_PATH  = join(__dirname, '../data/claude_md_snapshot.txt');

// ── SENSITIVE LINE FILTER ────────────────────────────────────────────────────
const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /private[_-]?key/i,
  /webhook.*url/i,
  /DISCORD_WEBHOOK/i,
  /HELIUS_API/i,
  /JUPITER_API/i,
  /WALLET_PRIVATE/i,
  /RPC_URL/i,
];

function isSensitiveLine(line) {
  return SENSITIVE_PATTERNS.some(p => p.test(line));
}

function sanitizeLines(lines) {
  return lines.filter(l => !isSensitiveLine(l));
}

// ── EXTRACT SESSION RECAP ────────────────────────────────────────────────────
function extractSessionRecap(content) {
  const match = content.match(/## (?:🚨 )?SESSION RECAP[^\n]*\n([\s\S]*?)(?=\n---)/);
  if (!match) return null;
  return match[1].trim();
}

// ── MAIN EXPORTS ─────────────────────────────────────────────────────────────

/**
 * Diff CLAUDE.md against snapshot.
 * Returns { recap, addedCount, removedCount } or null if no changes / first run.
 */
export function diffClaudeMd() {
  if (!existsSync(CLAUDE_MD_PATH)) return null;

  const current = readFileSync(CLAUDE_MD_PATH, 'utf8');

  // First run — no snapshot to diff against
  if (!existsSync(SNAPSHOT_PATH)) return null;

  const snapshot = readFileSync(SNAPSHOT_PATH, 'utf8');
  if (current === snapshot) return null;

  // Line-level change counts
  const currentLines  = current.split('\n');
  const snapshotSet   = new Set(snapshot.split('\n'));
  const currentSet    = new Set(currentLines);

  const addedCount   = currentLines.filter(l => !snapshotSet.has(l)).length;
  const removedCount = [...snapshotSet].filter(l => !currentSet.has(l)).length;

  // Extract and sanitize session recap
  const recap          = extractSessionRecap(current);
  const sanitizedRecap = recap
    ? sanitizeLines(recap.split('\n')).join('\n')
    : null;

  return { recap: sanitizedRecap, addedCount, removedCount };
}

/**
 * Save current CLAUDE.md as the new snapshot.
 * Call after posting the diff so next restart has a clean baseline.
 */
export function saveClaudeMdSnapshot() {
  if (!existsSync(CLAUDE_MD_PATH)) return;
  const content = readFileSync(CLAUDE_MD_PATH, 'utf8');
  writeFileSync(SNAPSHOT_PATH, content, 'utf8');
}
