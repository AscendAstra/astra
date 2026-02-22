/**
 * HTTP API Server
 * Exposes bot status and trade data for the dashboard
 * Railway will auto-expose the PORT env variable
 */

import http from 'http';
import { getActiveTrades, getAllTrades, getState } from '../store/trades.js';
import { getWalletAddress, getWalletBalance } from '../wallet/custodial.js';
import { loadSettings } from '../config/settings.js';
import { log } from '../utils/logger.js';

const PORT = process.env.PORT || 3000;

// In-memory log buffer (last 200 entries)
const logBuffer = [];
export function addToLogBuffer(entry) {
  logBuffer.push(entry);
  if (logBuffer.length > 200) logBuffer.shift();
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

function send(res, data, status = 200) {
  res.writeHead(status, corsHeaders());
  res.end(JSON.stringify(data));
}

export async function startApiServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    const url = req.url.split('?')[0];

    try {
      if (url === '/') {
        send(res, { status: 'ok', service: 'SolScalp Bot API' });

      } else if (url === '/status') {
        const settings = loadSettings();
        const balance  = await getWalletBalance();
        const state    = getState();
        send(res, {
          is_bot_active:      settings.is_bot_active,
          paper_trading:      settings.paper_trading,
          wallet_address:     getWalletAddress(),
          wallet_balance_sol: balance,
          daily_pnl_sol:      state.daily_pnl_sol,
          total_pnl_sol:      state.total_pnl_sol,
          trade_count:        state.trade_count,
          strategies: {
            scalp:    settings.scalp_enabled,
            momentum: settings.momentum_enabled,
            breakout: settings.breakout_enabled,
          },
        });

      } else if (url === '/trades') {
        send(res, { trades: getAllTrades() });

      } else if (url === '/trades/active') {
        send(res, { trades: getActiveTrades() });

      } else if (url === '/logs') {
        send(res, { logs: logBuffer.slice().reverse() });

      } else {
        send(res, { error: 'Not found' }, 404);
      }
    } catch (err) {
      log('error', `API error: ${err.message}`);
      send(res, { error: err.message }, 500);
    }
  });

  server.listen(PORT, () => {
    log('info', `API server running on port ${PORT}`);
  });

  return server;
}
