/**
 * Trade Store
 * In-memory trade state with JSON file persistence
 * On Railway, persists within a session; use a DB for permanent storage
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADES_FILE = path.join(__dirname, '../data/trades.json');
const STATE_FILE  = path.join(__dirname, '../data/state.json');

// Ensure data dir exists
fs.mkdirSync(path.dirname(TRADES_FILE), { recursive: true });

let trades = loadFromDisk(TRADES_FILE, []);
let state  = loadFromDisk(STATE_FILE, {
  daily_pnl_sol: 0,
  daily_reset_date: new Date().toDateString(),
  total_pnl_sol: 0,
  trade_count: 0,
});

function loadFromDisk(file, defaultVal) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return defaultVal;
}

function saveTrades() {
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function resetDailyIfNeeded() {
  const today = new Date().toDateString();
  if (state.daily_reset_date !== today) {
    state.daily_pnl_sol   = 0;
    state.daily_reset_date = today;
    saveState();
    log('info', 'Daily P&L reset for new day');
  }
}

// ── TRADE CRUD ────────────────────────────────────────────────────────────────

export function createTrade(data) {
  const trade = {
    id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    status: 'active',
    entry_time: new Date().toISOString(),
    exit_time: null,
    highest_price: data.entry_price,
    partial_exit_executed: false,
    pnl_percent: 0,
    pnl_sol: 0,
    ...data,
  };
  trades.push(trade);
  saveTrades();
  log('info', `[Trade] Created: ${trade.id} — ${trade.token_symbol} @ $${trade.entry_price}`);
  return trade;
}

export function updateTrade(id, updates) {
  const idx = trades.findIndex(t => t.id === id);
  if (idx === -1) throw new Error(`Trade not found: ${id}`);
  trades[idx] = { ...trades[idx], ...updates };
  saveTrades();
  return trades[idx];
}

export function closeTrade(id, exitPrice, exitTxSig, reason = 'target') {
  const trade = trades.find(t => t.id === id);
  if (!trade) throw new Error(`Trade not found: ${id}`);

  const pnlPercent = ((exitPrice - trade.entry_price) / trade.entry_price) * 100;
  const pnlSol     = trade.amount_sol * (pnlPercent / 100);

  const updated = updateTrade(id, {
    status: reason === 'stop_loss' ? 'stopped' : 'completed',
    exit_price: exitPrice,
    exit_time: new Date().toISOString(),
    tx_signature_exit: exitTxSig,
    pnl_percent: pnlPercent,
    pnl_sol: pnlSol,
  });

  // Update daily + total P&L
  resetDailyIfNeeded();
  state.daily_pnl_sol += pnlSol;
  state.total_pnl_sol += pnlSol;
  state.trade_count   += 1;
  saveState();

  log('info', `[Trade] Closed: ${trade.token_symbol} — ${pnlPercent.toFixed(2)}% / ${pnlSol.toFixed(4)} SOL (${reason})`);
  return updated;
}

// ── QUERIES ───────────────────────────────────────────────────────────────────

export function getActiveTrades() {
  return trades.filter(t => t.status === 'active');
}

export function getActiveTradeByToken(tokenAddress) {
  return trades.find(t => t.token_address === tokenAddress && t.status === 'active') || null;
}

export function hasActiveTradeForToken(tokenAddress, strategy) {
  return trades.some(t =>
    t.token_address === tokenAddress &&
    t.status === 'active' &&
    t.strategy === strategy
  );
}

export function getAllTrades() { return [...trades]; }

export function getState() {
  resetDailyIfNeeded();
  return { ...state };
}

export function isDailyLossLimitReached(limitSol) {
  resetDailyIfNeeded();
  return state.daily_pnl_sol <= -Math.abs(limitSol);
}
