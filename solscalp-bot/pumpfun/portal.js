/**
 * PumpPortal WebSocket Client
 * Real-time Pump.fun token data via wss://pumpportal.fun/api/data
 *
 * Events:
 *   - subscribeNewToken  → new token creation on Pump.fun
 *   - subscribeTokenTrade → trade events for tracked tokens
 *
 * Auto-reconnects with exponential backoff (1s → 30s max).
 */

import WebSocket from 'ws';
import { log } from '../utils/logger.js';

const WS_URL = 'wss://pumpportal.fun/api/data';
const HEARTBEAT_MS = 30_000;
const MAX_RECONNECT_DELAY = 30_000;

export class PumpPortalWS {
  constructor() {
    this._ws = null;
    this._callbacks = {};
    this._reconnectDelay = 1000;
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this._isConnected = false;
    this._subscribedMints = new Set();
    this._intentionalClose = false;
  }

  /**
   * Connect to PumpPortal WebSocket and start receiving events.
   * @param {{ onNewToken?: Function, onTrade?: Function }} callbacks
   */
  connect(callbacks = {}) {
    this._callbacks = callbacks;
    this._intentionalClose = false;
    this._openConnection();
  }

  _openConnection() {
    try {
      this._ws = new WebSocket(WS_URL);
    } catch (err) {
      log('error', `[PUMPPORTAL] WebSocket constructor failed: ${err.message}`);
      this._scheduleReconnect();
      return;
    }

    this._ws.on('open', () => {
      this._isConnected = true;
      this._reconnectDelay = 1000;
      log('info', '[PUMPPORTAL] WebSocket connected to PumpPortal');

      // Subscribe to new token events
      this._send({ method: 'subscribeNewToken' });

      // Re-subscribe to any previously tracked mints
      if (this._subscribedMints.size > 0) {
        this._send({ method: 'subscribeTokenTrade', keys: [...this._subscribedMints] });
        log('info', `[PUMPPORTAL] Re-subscribed to ${this._subscribedMints.size} token trade feeds`);
      }

      // Start heartbeat
      this._startHeartbeat();
    });

    this._ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        this._routeMessage(data);
      } catch {
        // Ignore non-JSON messages (pings, etc.)
      }
    });

    this._ws.on('close', (code, reason) => {
      this._isConnected = false;
      this._stopHeartbeat();
      if (!this._intentionalClose) {
        log('warn', `[PUMPPORTAL] WebSocket closed (code: ${code}). Reconnecting...`);
        this._scheduleReconnect();
      }
    });

    this._ws.on('error', (err) => {
      log('error', `[PUMPPORTAL] WebSocket error: ${err.message}`);
      // 'close' event will fire after this and handle reconnection
    });
  }

  /**
   * Subscribe to trade events for specific token mints.
   * Can be called multiple times — accumulates subscriptions.
   */
  subscribeTokenTrade(mints) {
    if (!Array.isArray(mints) || mints.length === 0) return;

    // Only subscribe to new mints we haven't seen
    const newMints = mints.filter(m => !this._subscribedMints.has(m));
    if (newMints.length === 0) return;

    for (const m of newMints) this._subscribedMints.add(m);

    if (this._isConnected) {
      this._send({ method: 'subscribeTokenTrade', keys: newMints });
    }
  }

  /**
   * Unsubscribe from trade events for specific mints.
   */
  unsubscribeTokenTrade(mints) {
    for (const m of mints) this._subscribedMints.delete(m);
    // PumpPortal may not support unsubscribe — just stop tracking locally
  }

  /** Check if connected */
  get isConnected() {
    return this._isConnected;
  }

  /** Clean shutdown */
  close() {
    this._intentionalClose = true;
    this._stopHeartbeat();
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._ws) {
      try { this._ws.close(); } catch {}
    }
    this._isConnected = false;
    log('info', '[PUMPPORTAL] WebSocket closed (intentional)');
  }

  // ── INTERNAL ────────────────────────────────────────────────────────────────

  _send(payload) {
    if (this._ws && this._isConnected) {
      try {
        this._ws.send(JSON.stringify(payload));
      } catch (err) {
        log('error', `[PUMPPORTAL] Send failed: ${err.message}`);
      }
    }
  }

  _routeMessage(data) {
    // New token creation event
    if (data.txType === 'create' || data.type === 'newToken') {
      if (this._callbacks.onNewToken) {
        try {
          this._callbacks.onNewToken(data);
        } catch (err) {
          log('error', `[PUMPPORTAL] onNewToken callback error: ${err.message}`);
        }
      }
      return;
    }

    // Trade event (buy or sell on a tracked token)
    if (data.txType === 'buy' || data.txType === 'sell' || data.type === 'trade') {
      if (this._callbacks.onTrade) {
        try {
          this._callbacks.onTrade(data);
        } catch (err) {
          log('error', `[PUMPPORTAL] onTrade callback error: ${err.message}`);
        }
      }
      return;
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this._ws && this._isConnected) {
        try { this._ws.ping(); } catch {}
      }
    }, HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this._intentionalClose) return;
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, MAX_RECONNECT_DELAY);
    log('info', `[PUMPPORTAL] Reconnecting in ${delay / 1000}s...`);
    this._reconnectTimer = setTimeout(() => this._openConnection(), delay);
  }
}
