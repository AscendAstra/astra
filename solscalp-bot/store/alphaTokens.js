/**
 * Alpha Token Registry — Tracks tokens from known alpha groups
 *
 * Persists to data/alpha_tokens.json. Hot-reloads alpha_sources.json (60s cache).
 * Prunes entries older than 7 days on load.
 *
 * Usage:
 *   import { tagAlphaToken, isAlphaToken, getAlphaToken, recordAlphaStage, matchAlphaSource, loadAlphaSources } from '../store/alphaTokens.js';
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = join(__dirname, '../data/alpha_tokens.json');
const SOURCES_PATH = join(__dirname, '../data/alpha_sources.json');

const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── SOURCES CACHE (hot-reloadable, 60s TTL) ─────────────────────────────────
let _sourcesCache = null;
let _sourcesCacheAt = 0;
const SOURCES_CACHE_TTL = 60_000;

/**
 * Load alpha sources from disk with 60s cache (hot-reloadable).
 * Returns array of { id, patterns, label }.
 */
export function loadAlphaSources() {
  const now = Date.now();
  if (_sourcesCache && now - _sourcesCacheAt < SOURCES_CACHE_TTL) {
    return _sourcesCache;
  }

  try {
    if (!existsSync(SOURCES_PATH)) {
      _sourcesCache = [];
      _sourcesCacheAt = now;
      return _sourcesCache;
    }
    const raw = readFileSync(SOURCES_PATH, 'utf8');
    const data = JSON.parse(raw);
    _sourcesCache = data.sources || [];
    _sourcesCacheAt = now;
  } catch (err) {
    log('warn', `[ALPHA] Failed to load alpha_sources.json: ${err.message}`);
    if (!_sourcesCache) _sourcesCache = [];
    _sourcesCacheAt = now;
  }

  return _sourcesCache;
}

/**
 * Check description against all alpha source patterns.
 * Returns source id if match found, null otherwise.
 */
export function matchAlphaSource(description) {
  if (!description) return null;
  const lower = description.toLowerCase();
  const sources = loadAlphaSources();

  for (const source of sources) {
    for (const pattern of source.patterns) {
      if (lower.includes(pattern.toLowerCase())) {
        return source.id;
      }
    }
  }

  return null;
}

// ── TOKEN PERSISTENCE ─────────────────────────────────────────────────────────

function loadTokens() {
  try {
    if (!existsSync(TOKENS_PATH)) return {};
    const raw = readFileSync(TOKENS_PATH, 'utf8');
    const data = JSON.parse(raw);

    // Prune entries older than 7 days
    const now = Date.now();
    let pruned = 0;
    for (const [mint, entry] of Object.entries(data)) {
      if (now - entry.first_seen_at > PRUNE_AGE_MS) {
        delete data[mint];
        pruned++;
      }
    }
    if (pruned > 0) {
      saveTokens(data);
      log('info', `[ALPHA] Pruned ${pruned} alpha token(s) older than 7 days`);
    }

    return data;
  } catch (err) {
    log('warn', `[ALPHA] Failed to load alpha_tokens.json: ${err.message}`);
    return {};
  }
}

function saveTokens(data) {
  try {
    writeFileSync(TOKENS_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    log('error', `[ALPHA] Failed to save alpha_tokens.json: ${err.message}`);
  }
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────────

/**
 * Tag a token as originating from an alpha group.
 */
export function tagAlphaToken(mint, symbol, source) {
  const tokens = loadTokens();
  if (tokens[mint]) return; // already tagged

  tokens[mint] = {
    mint,
    symbol,
    source,
    first_seen_at: Date.now(),
    stages: [],
  };
  saveTokens(tokens);
}

/**
 * Check if a token is tagged as alpha.
 */
export function isAlphaToken(mint) {
  const tokens = loadTokens();
  return !!tokens[mint];
}

/**
 * Get alpha token data. Returns entry or null.
 */
export function getAlphaToken(mint) {
  const tokens = loadTokens();
  return tokens[mint] || null;
}

/**
 * Record a strategy stage entry for an alpha token.
 */
export function recordAlphaStage(mint, strategy, mc) {
  const tokens = loadTokens();
  const entry = tokens[mint];
  if (!entry) return;

  entry.stages.push({
    strategy,
    mc,
    entered_at: Date.now(),
  });
  saveTokens(tokens);
}

/**
 * Get all tracked alpha tokens (for future dashboard/analysis).
 */
export function getAlphaTokens() {
  return loadTokens();
}
