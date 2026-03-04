/**
 * Content Filter — Brand Safety for Token Names
 *
 * Blocks tokens with offensive/hateful names before any trade decision.
 * Hot-reloadable blocklist (60s TTL cache), l33t speak normalization,
 * two match modes (substring for unambiguous terms, word boundary for short/ambiguous).
 *
 * Usage:
 *   import { isTokenBlocked } from '../utils/contentFilter.js';
 *   if (isTokenBlocked(token.symbol, token.name, settings)) return;
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLOCKLIST_PATH = join(__dirname, '../data/content_blocklist.json');

// ── CACHE ───────────────────────────────────────────────────────────────────
let _cache = null;       // { categories: string[], wordBoundary: string[] }
let _cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000; // 60 seconds

// ── THROTTLED LOG ───────────────────────────────────────────────────────────
const _logThrottle = new Map(); // symbol → timestamp
const LOG_THROTTLE_MS = 5 * 60_000; // 5 minutes per symbol

// ── L33T NORMALIZATION MAP ──────────────────────────────────────────────────
const LEET_MAP = {
  '1': 'i', '3': 'e', '0': 'o', '4': 'a', '5': 's',
  '7': 't', '@': 'a', '$': 's', '!': 'i', '8': 'b',
};

/**
 * Normalize text: lowercase → l33t decode → strip non-alpha.
 */
function normalize(text) {
  if (!text) return '';
  let out = text.toLowerCase();
  out = out.replace(/[1304@$!875]/g, ch => LEET_MAP[ch] || ch);
  return out.replace(/[^a-z]/g, '');
}

/**
 * Normalize but keep spaces (for word boundary matching).
 */
function normalizeKeepSpaces(text) {
  if (!text) return '';
  let out = text.toLowerCase();
  out = out.replace(/[1304@$!875]/g, ch => LEET_MAP[ch] || ch);
  return out.replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Load and flatten the blocklist from disk. Re-reads if cache is stale.
 */
function loadBlocklist() {
  const now = Date.now();
  if (_cache && now - _cacheLoadedAt < CACHE_TTL_MS) return _cache;

  try {
    const raw = JSON.parse(readFileSync(BLOCKLIST_PATH, 'utf8'));

    // Flatten all category arrays into one list (substring match)
    const categories = [];
    if (raw.categories) {
      for (const arr of Object.values(raw.categories)) {
        if (Array.isArray(arr)) {
          for (const term of arr) categories.push(normalize(term));
        }
      }
    }

    // Word boundary terms (standalone match only)
    const wordBoundary = [];
    if (Array.isArray(raw.word_boundary)) {
      for (const term of raw.word_boundary) wordBoundary.push(normalize(term));
    }

    _cache = { categories, wordBoundary };
    _cacheLoadedAt = now;
  } catch (err) {
    // If file missing or corrupt, use last known cache or empty
    if (!_cache) _cache = { categories: [], wordBoundary: [] };
    log('error', `[CONTENT] Failed to load blocklist: ${err.message}`);
  }

  return _cache;
}

/**
 * Check if a token should be blocked based on its symbol and name.
 *
 * @param {string} symbol  Token ticker symbol
 * @param {string} name    Token full name
 * @param {object} settings  Bot settings (needs content_filter_enabled)
 * @returns {boolean} true if token should be blocked
 */
export function isTokenBlocked(symbol, name, settings) {
  if (!settings.content_filter_enabled) return false;

  const blocklist = loadBlocklist();
  if (blocklist.categories.length === 0 && blocklist.wordBoundary.length === 0) return false;

  const combined = normalize((symbol || '') + ' ' + (name || ''));
  if (!combined) return false;

  // Substring match — unambiguous terms
  for (const term of blocklist.categories) {
    if (combined.includes(term)) {
      throttledLog(symbol);
      return true;
    }
  }

  // Word boundary match — short/ambiguous terms
  // Check against: (a) normalized symbol exactly, (b) word boundary in spaced name
  const normSymbol = normalize(symbol || '');
  const spaced = normalizeKeepSpaces((symbol || '') + ' ' + (name || ''));
  for (const term of blocklist.wordBoundary) {
    if (normSymbol === term) {
      throttledLog(symbol);
      return true;
    }
    const re = new RegExp(`\\b${term}\\b`);
    if (re.test(spaced)) {
      throttledLog(symbol);
      return true;
    }
  }

  return false;
}

/**
 * Sanitize a token symbol/name for display (Discord, logs visible to users).
 * If the text matches the blocklist, returns "[FILTERED]" instead.
 * Works even if content_filter_enabled is false — display safety is unconditional.
 */
export function sanitizeForDisplay(text) {
  if (!text) return text;

  const blocklist = loadBlocklist();
  const normalized = normalize(text);
  const spaced = normalizeKeepSpaces(text);

  for (const term of blocklist.categories) {
    if (normalized.includes(term)) return '[FILTERED]';
  }
  for (const term of blocklist.wordBoundary) {
    if (normalize(text) === term) return '[FILTERED]';
    const re = new RegExp(`\\b${term}\\b`);
    if (re.test(spaced)) return '[FILTERED]';
  }
  return text;
}

function throttledLog(symbol) {
  const now = Date.now();
  const last = _logThrottle.get(symbol);
  if (last && now - last < LOG_THROTTLE_MS) return;
  _logThrottle.set(symbol, now);
  log('info', `[CONTENT] BLOCKED ${symbol}`);
}
