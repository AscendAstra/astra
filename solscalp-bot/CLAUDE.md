# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Update this at the end of every session via `/finalize` (runs validation first).

---

## Commands

```bash
# Run the bot
node index.js

# Run with watchdog (recommended for real money — auto-restart on crash)
node scripts/watchdog.js

# Validate all 29 files (syntax + boot test), ~3 seconds
node scripts/validate.js

# Syntax-check a single file
node --check <file.js>

# Kill switch (emergency close-all)
curl -X POST http://localhost:3000/kill -H "Authorization: Bearer <KILL_SWITCH_TOKEN>"
```

No tests, no linter, no build step. ES modules (`"type": "module"` in package.json). Node.js 18+.

---

## SESSION RECAP (Mar 4)

**Real Money Readiness (Items 1-5):**
1. **Transaction confirmation** — All 5 strategy buy flows verify tokens received after swap. All sell flows verify tokens left wallet. (`wallet/custodial.js`: `getTokenBalance()`, `getTokenAccounts()`)
2. **Wallet reconciliation** — `utils/walletReconcile.js` runs on startup. Detects orphaned tokens + phantom trades. Force-closes phantoms.
3. **Process watchdog** — `scripts/watchdog.js` spawns bot, auto-restarts on crash (10s delay), crash loop detection (5 in 2min → halt). Discord alerts.
4. **Kill switch** — `POST /kill` on `api/server.js` with Bearer auth. Closes all positions + disables bot.
5. **Actual PnL tracking** — `sol_spent`, `sol_received`, `actual_pnl_sol` fields in trades.json. Wallet balance diff before/after swaps.

**Momentum tuning:** `momentum_volume_multiplier` 5→9, added `momentum_min_5m_pump` (0), `momentum_max_1h_pump` (30).

**Breakout + Midcap entry tightening:** `breakout_min_5m_pump` 2→3%, `breakout_min_1h_pump` 5→10%, `midcap_min_5m_pump` 1→3%.

**Deferred to Friday Mar 6:** sell_pressure floor minimum (+5% PnL before sell_pressure exit triggers). Collecting 48h of data with tightened entries first.

---

## What This Project Is

**ASTRA** is an automated Solana trading bot running locally on a Windows machine.
- **Stack:** Node.js (ES modules), Jupiter API (api.jup.ag, key required), DexScreener API, PumpPortal WebSocket, Helius RPC
- **Mode:** Paper trading (transitioning to real money)
- **Dashboard:** Marathon cyberpunk aesthetic on port 3000

---

## Architecture Overview

```
index.js                          ← entry point, runs all loops + WebSocket concurrently
├── strategies/
│   ├── pumpfun.js                ← pump.fun bonding curve scalp ($6K–$25K MC, WebSocket-driven)
│   ├── momentum.js               ← pump.fun graduation sniper ($75K–$100K MC)
│   ├── scalp.js                  ← tight range scalper ($280K–$320K MC) — PAUSED
│   ├── midcap.js                 ← midcap gap filler ($320K–$2M MC, +30% target)
│   └── breakout.js               ← mid-cap compounder ($2M–$20M MC)
├── pumpfun/
│   └── portal.js                 ← PumpPortal WebSocket client (real-time Pump.fun data)
├── monitor/
│   ├── activeTrades.js           ← monitors open positions, fires exits (60s DexScreener)
│   └── fastStopLoss.js           ← fast stop loss via Jupiter Price API (10s interval)
├── analysis/
│   ├── scoring.js                ← token quality + health scoring
│   ├── holderCheck.js            ← Helius holder concentration check
│   └── trendCheck.js             ← CoinGecko 14-day downtrend detection (breakout DT bounce)
├── dexscreener/
│   └── index.js                  ← token fetching (fetchTopSolanaTokens + fetchMidCapSolanaTokens, 60s cache)
├── utils/
│   ├── discord.js                ← webhook notifier (12 notification types)
│   ├── settingsDiff.js           ← diffs settings on restart → Discord
│   ├── claudeMdDiff.js           ← diffs CLAUDE.md on restart → Discord
│   ├── walletReconcile.js        ← startup reconciliation (orphans + phantoms)
│   ├── marketGuard.js            ← BTC cascade protection (btc_guard.json)
│   ├── regimeDetector.js         ← BEAR/FLAT/BULL detection (regime.json)
│   ├── cooldownStore.js          ← persistent per-token cooldowns + entry history
│   ├── contentFilter.js          ← brand safety filter (l33t normalization, hot-reload)
│   └── logger.js
├── config/
│   ├── settings.js               ← all settings via env vars + regime overlay
│   └── regimes.js                ← BEAR/FLAT/BULL parameter presets
├── store/
│   ├── trades.js                 ← in-memory trade state + JSON persistence
│   └── alphaTokens.js            ← alpha token registry (hot-reload sources)
├── wallet/
│   └── custodial.js              ← keypair, tx signing, balance checks
├── jupiter/
│   └── index.js                  ← Jupiter swap API (api.jup.ag + x-api-key)
├── api/
│   └── server.js                 ← dashboard + kill switch endpoint
├── scripts/
│   ├── validate.js               ← session validator (syntax + boot test)
│   └── watchdog.js               ← process manager (auto-restart + crash loop detection)
├── data/
│   ├── trades.json               ← full trade history
│   ├── cooldowns.json            ← persistent cooldowns + entry history
│   ├── btc_guard.json            ← BTC market guard state
│   ├── regime.json               ← regime state (BEAR/FLAT/BULL + score)
│   ├── settings_snapshot.json    ← baseline for settings diff
│   ├── content_blocklist.json    ← offensive name blocklist (hot-reload, 60s)
│   ├── alpha_sources.json        ← alpha group patterns (hot-reload, 60s)
│   ├── alpha_tokens.json         ← tracked alpha tokens (auto-pruned 7d)
│   └── quiet_checkpoint.json     ← quiet hours cooldown state
└── .env                          ← HELIUS_API_KEY, WALLET_PRIVATE_KEY, JUPITER_API_KEY,
                                     DISCORD_WEBHOOK_URL, KILL_SWITCH_TOKEN, etc.
```

**Key architectural patterns:**
- Trades cached in-memory (`store/trades.js`) — editing trades.json requires bot restart
- Settings load from env vars → regime overlay applied (`config/settings.js` → `config/regimes.js`)
- Cooldown/failsafe state persisted to `data/cooldowns.json` — survives restarts
- Discord notifications via `notify.*` functions in `utils/discord.js`
- Hot-reloadable configs: `content_blocklist.json`, `alpha_sources.json` (60s TTL cache)
- Two exit monitors run in parallel: activeTrades (60s, DexScreener) + fastStopLoss (10s, Jupiter Price API)
- `pendingSells` Set prevents both monitors from double-selling the same trade

---

## Protection System (25+ Layers)

| Layer | What It Does | Persistence |
|-------|-------------|-------------|
| SOL price failsafe | Pauses entries if SOL drops 7%+ in 1h | In-memory |
| Consecutive stop pause | 2 stops in 30min → 90min pause (momentum + scalp + midcap) | Disk (cooldowns.json) |
| Per-token cooldown | 45min cooldown after stop loss | Disk (cooldowns.json) |
| Re-entry cap | Max 1/token/24h (mom/scalp/midcap/pumpfun), max 2 (breakout) | Disk (cooldowns.json) |
| BTC market guard | Yellow (3% 1h) → Orange (4% 4h) → Red (5% 30m, close positions) | Disk (btc_guard.json) |
| Regime detection | BEAR/FLAT/BULL auto-adjusts parameters | Disk (regime.json) |
| Fast stop loss | Jupiter Price API every 10s → immediate sell | In-memory |
| Hard kill circuit breaker | -35% → max slippage sell | Settings |
| Stale trade exit | >90min with P&L between stop loss and +5% → auto-close | Settings |
| Unsellable auto-close | 3 failed sell cycles → force close + Discord alert | In-memory |
| Sell pressure exit | All 5 strategies: exit when buy_pressure drops below threshold while in profit | Settings |
| Sell race guard | `pendingSells` Set prevents double-sell from activeTrades + fastStopLoss | In-memory |
| Content filter | Blocks offensive token names (l33t normalization, hot-reload blocklist) | Disk |
| Alpha tracking | Tags tokens from alpha groups, tracks across strategy stages | Disk |
| Wallet reconciliation | Startup: detects orphaned tokens + phantom trades | On startup |
| Transaction verification | Verifies token balance changed after every buy/sell | Per-trade |
| Momentum UTC block | No entries 12-15 & 18-21 UTC | Settings |
| Pumpfun curve acceleration | ≥2 consecutive rising vSol ticks before entry | In-memory |
| Downtrend bounce | 2-stage detection (DexScreener + CoinGecko 14d), stricter entry params | In-memory (30min cache) |

---

## Strategy Parameters (Current Defaults)

### Pumpfun (bonding curve scalp)
```
Entry MC:     $6K–$25K  |  Alpha: $4K–$25K
Max age:      10 min    |  Min volume: 40 SOL (alpha: 10 SOL)
Buy pressure: 65%+      |  Alpha: 55%+
Curve accel:  ≥2 rising vSol ticks
Target: +25%  |  Stop: -20%  |  MC ceiling: $25K
Sell pressure: <30%  |  Stale: 10min  |  Size: 0.1 SOL
Max concurrent: 3  |  Cooldown: 30min  |  Re-entry: 1/24h
Discovery: PumpPortal WebSocket  |  Execution: Jupiter
```

### Momentum (graduation sniper)
```
Entry MC:     $75K–$100K  |  Exit MC: $135K–$180K
Vol:          9x–12x (hourly/avg ratio)
5m pump:      ≥0% (positive required)  |  1h pump: ≤30% cap
Buy pressure: 55%+  |  Q threshold: 55
Target: +25%  |  Stop: -20%  |  Hard kill: -35%
Sell pressure: <35%  |  Stale: 90min  |  Size: 0.1 SOL
Interval: 45s  |  Re-entry: 1/24h  |  UTC block: 12-15 & 18-21
```

### Scalp (PAUSED — SCALP_ENABLED=false)
```
Entry MC: $280K–$320K  |  Exit MC: $500K
Vol: 3x–15x  |  Target: +30%  |  Stop: -20%
Sell pressure: <35%  |  Size: 0.1 SOL  |  UTC block: 00-06
```

### Midcap (gap filler — $320K–$2M)
```
Entry MC:     $320K–$2M
5m pump:      ≥3%  |  1h pump: ≥5%  |  24h cap: 300%
Buy pressure: 55%+  |  Vol: 2x–10x  |  Liquidity: $25K+
Target: +30%  |  Stop: -15%  |  Hard kill: -35%
Sell pressure: <35%  |  Stale: 90min  |  Size: 0.1 SOL
Interval: 60s  |  Re-entry: 1/24h
Discovery: DexScreener keywords + Jupiter toptraded/1h
```

### Breakout (mid-cap compounder — $2M–$20M)
```
Entry MC:     $2M–$20M
5m pump:      ≥3%  |  1h pump: ≥10%  |  24h cap: 200%
Buy pressure: 55%+  |  Vol: ≥1.5x  |  Liquidity: $50K+
Target: +20%  |  Stop: -12%  |  Hard kill: -35%
Sell pressure: <40%  |  Size: 0.2 SOL
Re-entry: 10min cooldown + max 2/24h
Discovery: DexScreener keywords (21) + Jupiter toptraded/1h
```

### Breakout Downtrend Bounce (separate `_dt_` settings)
```
Detection:    24h < -10% AND 6h < -3% (stage 1) + CoinGecko 14d decline >20% (stage 2)
5m pump: ≥1.5%  |  1h pump: ≥5%  |  Buy pressure: 62%+
Vol: ≥3x  |  Liquidity: $250K+  |  Stop: -8%
Toggle: BREAKOUT_DT_ENABLED
```

**Note:** Normal breakout filters (5m≥3%, 1h≥10%) do NOT apply to downtrend bounce trades. The DT path uses its own `breakout_dt_*` settings — this is intentional. Neither path is overridden by the regime system.

---

## DexScreener Fetching

**`fetchTopSolanaTokens()`** — momentum + scalp. Keywords: pump, sol, meme, cat, dog, pepe, moon, ai, based. Sorted by 24h volume, top 250. Cached 60s.

**`fetchMidCapSolanaTokens(mcMin, mcMax)`** — midcap + breakout. Two parallel sources:
1. DexScreener keywords (21 searches)
2. Jupiter `toptraded/1h` (catches novel names keywords miss)
Merged + deduped. Sorted by 1h volume. Cached 60s per MC range key. Toggle: `BREAKOUT_JUPITER_DISCOVERY`.

---

## Discord Integration

**Webhook env var:** `DISCORD_WEBHOOK_URL` — `#astra-live-feed`

12 notification types: `botStarted` (+ settings diff), `tradeOpen`, `tradeClose` (+ actual PnL), `stopLoss` (+ actual PnL), `partialExit`, `marketAlert`, `allClear`, `configUpdate`, `regimeChange`, `claudeUpdate`, `alphaStageEntry`, `quietCheckpoint`, `walletReconciliation`, `killSwitch`.

Settings diff: on restart, `settingsDiff.js` compares against `data/settings_snapshot.json`. Only safe keys diffed.

---

## Real Money Readiness

### Completed (Mar 4)
- [x] Transaction confirmation (token balance verification after buy/sell)
- [x] Wallet reconciliation on startup (orphans + phantoms)
- [x] Process manager (watchdog.js — auto-restart + crash loop detection)
- [x] Kill switch (POST /kill with Bearer auth)
- [x] Actual PnL tracking (sol_spent / sol_received / actual_pnl_sol)

### Should-have (before beta)
- [ ] Dedicated hot wallet — 1-2 SOL trading wallet, main balance separate
- [ ] Gradual rollout — real money on breakout + midcap first
- [ ] Priority fee management — dynamic fees during congestion
- [ ] Max drawdown circuit breaker — 15% from peak → halt

### Nice-to-have
- [ ] Backtesting framework
- [ ] Position sizing by signal confidence
- [ ] Redundant price feeds (Birdeye fallback)

---

## Known Issues

- **Stop loss slippage** — avg loss -26% vs -20% target. Mitigated by fast stop loss (10s) + hard kill at -35%. Structural to meme token liquidity.
- **Breakout 10min re-entry cooldown in-memory** — resets on restart. The 2/24h cap IS persisted.
- **Pumpfun SOL price** — uses rough $140 fallback for MC conversion. Needs CoinGecko/Jupiter price source.
- **DexScreener delisting** — tokens returning no data cause `[MONITOR] No data` spam. No auto-close for this case yet.
- **Overall negative EV** — paper trading data is net negative. Breakout + midcap are the only consistently profitable strategies. All filters are data-driven and improving.

---

## Roadmap

- [ ] Evaluate pumpfun tuning — compare win rate vs 20% baseline after 48h
- [ ] Evaluate breakout/midcap entry tightening — 48h data collection (5m≥3%, 1h≥10%)
- [ ] **Sell pressure floor** — revisit Friday Mar 6 (require +5% PnL before sell_pressure exit triggers)
- [ ] Breakout vol ramp analysis — after 100+ trades with volume_6h/volume_mc_ratio/pair_age_hours
- [ ] Tailscale + Termius for iPhone monitoring
- [ ] Integrate MCP servers into bot — indicators for breakout confirmation
- [ ] Birdeye Token List V3 API — broader discovery coverage
- [ ] Electron app packaging
- [ ] Multi-user deployment (3-week horizon)

---

## Session Validation (`/finalize`)

Type `/finalize` to: run `scripts/validate.js` → cascade analysis → update CLAUDE.md → re-validate.

Files: `scripts/validate.js` (deterministic, exit 0/1), `.claude/commands/finalize.md` (skill definition).

---

## Technical Notes

- `node --check file.js` for syntax verification (exit 0 = clean)
- Stale artifact trades have `stale_artifact: true` — exclude from all PnL analysis
- Paper mode: `PAPER_TRADING=true`. Balance always 100 SOL. Token verification skipped.
- `punycode` deprecation warning on startup is harmless (Node.js issue)
- Jupiter API key (free, 60 req/min) from portal.jup.ag. `api.jup.ag` + `x-api-key` header.
- Helius free tier does NOT support JSON-RPC batch requests (403) — use `Promise.all` with parallel singles
- `getTokenLargestAccounts` returns top 20 holders. Need `getTokenSupply` for concentration %.
- Jupiter error `0x1789` (6025) = SlippageToleranceExceeded — common on drained meme tokens
- Historical session recaps archived at `data/session_history.md`

---

## MCP Servers

Config: `~/.claude/settings.json` → `mcpServers`. All via `npx -y`.

| Server | Package | Purpose |
|--------|---------|---------|
| jupiter | `@mcp-dockmaster/mcp-server-jupiter` | Swap quotes & execution |
| dexscreener | `@opensvm/dexscreener-mcp-server` | DEX pair data |
| coingecko | `coingecko-mcp-server` | Market data |
| crypto-feargreed | `@kukapay/crypto-feargreed-mcp` | Fear & Greed index |
| crypto-indicators | `@kukapay/crypto-indicators-mcp` | RSI, MACD signals |
| defillama | `@dcspark/mcp-server-defillama` | TVL analytics |
