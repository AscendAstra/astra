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
import { executeSell } from '../monitor/activeTrades.js';
import { fetchJupiterPrices } from '../monitor/fastStopLoss.js';
import { notify } from '../utils/discord.js';

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

      } else if (url === '/kill' && req.method === 'POST') {
        // Kill switch — close all positions and halt trading
        const killToken = process.env.KILL_SWITCH_TOKEN;
        if (killToken) {
          const authHeader = req.headers['authorization'] || '';
          const token = authHeader.replace('Bearer ', '');
          if (token !== killToken) {
            send(res, { error: 'Unauthorized' }, 401);
            return;
          }
        }

        log('warn', '[KILL SWITCH] Activated via API — closing all positions and halting trading.');
        process.env.IS_BOT_ACTIVE = 'false';

        const active = getActiveTrades();
        let closed = 0;

        if (active.length > 0) {
          const settings = loadSettings();
          const mints = active.map(t => t.token_address);
          let prices = {};
          try {
            prices = await fetchJupiterPrices(mints);
          } catch (err) {
            log('warn', `[KILL SWITCH] Price fetch failed: ${err.message}`);
          }

          for (const trade of active) {
            const currentPrice = prices[trade.token_address] || trade.entry_price;
            const token = {
              price_usd: currentPrice,
              liquidity_usd: 50_000,
              market_cap: 0,
              price_change_5m: 0,
            };
            try {
              await executeSell(trade, token, settings, 'kill_switch', 100);
              closed++;
            } catch (err) {
              log('error', `[KILL SWITCH] Failed to sell ${trade.token_symbol}: ${err.message}`);
            }
          }
        }

        await notify.killSwitch(closed);
        send(res, { killed: true, trades_closed: closed });

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
