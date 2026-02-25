# ASTRA Trading Bot — Claude Context Document
> Read this first. It contains everything learned across all sessions.
> Update this at the end of every session with new findings.
---

## 🚨 SESSION RECAP (Feb 25 late night)

**What was done this session:**
1. ✅ BTC Market Guard persisted to disk (`data/btc_guard.json`) — price history, vol history, alert level all survive restarts
2. ✅ Fast stop loss monitor added (`monitor/fastStopLoss.js`) — Jupiter Price API every 10s, catches drops the 60s DexScreener monitor misses
3. ✅ Jupiter API migrated from deprecated `lite-api.jup.ag` → `api.jup.ag` with `x-api-key` header (free key from portal.jup.ag)
4. ✅ Momentum interval lowered 90s → 45s (safe within DexScreener 300 req/min cap)
5. ✅ `executeSell` exported from activeTrades.js for reuse by fast stop loss

**Bot is running live** with all 5 loops (SCALP 90s, MOMENTUM 45s, BREAKOUT 90s, MONITOR 60s, FAST_SL 10s).

**Next session priorities:**
- Check PnL — has the fast stop loss improved avg loss from -26%?
- Regime-aware trading system (bear/flat/bull parameter sets + auto-detection) — still the top architectural priority
- Isolate pre vs post vol filter win rates

---


---

## What This Project Is

**ASTRA** is an automated Solana trading bot running locally on a Windows machine.
- **Stack:** Node.js (ES modules), Jupiter API (api.jup.ag, key required), DexScreener API, Helius RPC
- **Mode:** Paper trading (no real money yet)
- **Location:** `C:\Users\black\astra\solscalp-bot\`
- **Run command:** `node index.js` from project root
- **Dashboard:** Marathon cyberpunk aesthetic, ASCII space canvas, exoplanet background

---

## Architecture Overview

```
index.js                          ← entry point, runs all loops concurrently
├── strategies/
│   ├── momentum.js               ← pump.fun graduation sniper ($75K–$110K MC)
│   ├── scalp.js                  ← tight range scalper ($280K–$320K MC)
│   └── breakout.js               ← mid-cap compounder ($2M–$20M MC)
├── monitor/
│   ├── activeTrades.js           ← monitors open positions, fires exits (60s DexScreener)
│   └── fastStopLoss.js           ← fast stop loss via Jupiter Price API (10s interval)
├── dexscreener/
│   └── index.js                  ← token fetching (fetchTopSolanaTokens + fetchMidCapSolanaTokens)
├── utils/
│   ├── discord.js                ← webhook notifier (all 8 notification types)
│   ├── settingsDiff.js           ← diffs settings on restart, posts changes to Discord
│   ├── marketGuard.js            ← BTC cascade protection (persisted to btc_guard.json)
│   ├── cooldownStore.js          ← persistent per-token cooldowns (survives restarts)
│   └── logger.js
├── config/
│   └── settings.js               ← all settings via env vars with defaults
├── data/
│   ├── cooldowns.json            ← persistent stop loss cooldowns
│   ├── btc_guard.json            ← persistent BTC market guard state (survives restarts)
│   ├── trades.json               ← full trade history (all entries/exits)
│   └── settings_snapshot.json   ← baseline for settings diff on restart
├── jupiter/
│   └── index.js                  ← Jupiter swap API (migrated to api.jup.ag + x-api-key)
└── .env                          ← DISCORD_WEBHOOK_URL, HELIUS_API_KEY, WALLET_PRIVATE_KEY, JUPITER_API_KEY
```

---

## Protection System (5 Layers — All Active)

| Layer | What It Does | Persistence |
|-------|-------------|-------------|
| SOL price failsafe | Pauses entries if SOL drops 7%+ in 1h | In-memory (resets on restart) |
| Consecutive stop pause | 2 stops in 30min → 90min pause | ✅ Disk (cooldowns.json) |
| Per-token cooldown | 45min cooldown after stop loss on a token | ✅ Disk (cooldowns.json) |
| BTC yellow alert | 3% drop in 1h → pause entries | ✅ Disk (btc_guard.json) |
| BTC orange alert | 4% drop in 4h → pause + tighten stops | ✅ Disk (btc_guard.json) |
| BTC red alert | 5% drop in 30m or 10x vol spike → close momentum positions | ✅ Disk (btc_guard.json) |
| Fast stop loss | Jupiter Price API every 10s → immediate sell on stop hit | In-memory (real-time) |

---

## Strategy Parameters (Current Defaults)

### Momentum (pump.fun graduation sniper)
```
Entry MC:     $75K – $110K
Exit MC:      $135K – $180K
Vol min:      5x   ← raised from 2x (data: <5x = 0% win rate)
Vol max:      12x  ← new cap (>12x = token likely already peaked)
Stop loss:    -20%
Trade size:   0.1 SOL
Q threshold:  55   ← lowered from 65 (Q score has weak predictive value)
Interval:     45s  ← lowered from 90s (Feb 25, DexScreener rate limit safe at ~93 req/min vs 300 cap)
```

### Scalp
```
Entry MC:     $280K – $320K
Exit MC:      $500K
Stop loss:    -20%
Trade size:   0.1 SOL
```

### Breakout (mid-cap compounder)
```
Entry MC:     $2M – $20M
Vol min:      1.5x
1h change:    +2% minimum
5m change:    +1% minimum
Buy pressure: 55%+
Liquidity:    $50K minimum
Q threshold:  75
Stop loss:    -12%
Target:       +20%
Trade size:   0.2 SOL
Re-entry:     allowed after 10min cooldown
```

---

## Key Data Findings (Feb 23 Stop Loss Analysis)

Analyzed 22 momentum trade evaluations against outcomes. **Volume was the only reliable predictor:**

| Vol Range | Win Rate |
|-----------|----------|
| < 3x      | 0% (0W/4L) |
| 3–5x      | 0% (0W/8L) |
| **5–10x** | **100% (4W/0L)** |
| 10–24x    | 33% (2W/4L) |

**Q score had zero predictive value** — BLOB (Q:100) and Moon (Q:85) both stopped out. High Q score does not mean the trade will work. Vol filter now does the heavy lifting.

**Buy pressure helped but was secondary:**
- Buy 80%+: 67% win rate
- Buy <60%: 14% win rate

**Re-entry without cooldown was the biggest damage multiplier** — CTO stopped 3x, CLAW stopped 2x, KIM stopped 2x. This is fixed by persistent cooldowns.

**SITH (-54%)** was a rug pull — instant liquidity drain in one 60-second window. Unavoidable by any stop loss system.

---

## Overall PnL Snapshot (as of Feb 25, 2026)

**72 closed trades | 7 active | Paper trading**

| | Momentum | Scalp | Combined |
|---|---|---|---|
| Record | 10W / 38L | 4W / 20L | **14W / 58L** |
| Win Rate | 21% | 17% | **19.4%** |
| Avg Win | +53.9% | +80.2% | +61.4% |
| Avg Loss | -27.2% | -23.5% | -25.9% |
| Net PnL | -0.496 SOL | -0.149 SOL | **-0.645 SOL** |

**Active positions (est +0.080 SOL unrealized):** PEPE +17.7%, AI +12.4%, CAT +25.5%, RETURN +11.6%, Fergani +11.4%, DARWIN +2.1%, house -0.5%

**Total est (closed + open): -0.565 SOL**

### Context & Caveats
- **Collected during SOL downtrend** — macro headwinds are inflating loss rate. Win rate is likely understated vs neutral/bullish conditions.
- **Old vol filter (2x) dominated early trades** — majority of losses came before the 5x floor was added Feb 24. Pre/post filter split not yet isolated.
- **Stop loss slippage issue** — avg loss should be ~20% but came out -25.9%. Several trades hit -47%, -52%, -74% (Gaper was worst at -74%). Either stop loss is delayed or price gapping through it. Needs investigation.
- **48–72h of data needed** under new 5–12x vol filter before drawing conclusions on WR improvement.

### Notable Trades
| Token | Strategy | PnL | Notes |
|-------|----------|-----|-------|
| LOBCHURCH | scalp | +104% | Best trade |
| Limited | scalp | +80.7% | Entered 4x, won on 4th attempt |
| Chapo | momentum | +80.6% | |
| GOLDENERA | momentum | +75.3% | Under new vol filter, vol 6.8x |
| Gaper | momentum | -74.3% | Worst trade — price collapsed after entry |
| SITH | momentum | -54.4% | Likely rug pull |

---

## Token Scoring Example (Feb 25)

**RETARDS (CRYPTOMAXXING) — `kkAjN1Gnuq3AkfCTotuLaadLUFWs7VujivmF7Xwpump`**
- MC: $311K — falls in dead zone between scalp ($320K max) and breakout ($2M min)
- Vol 24x, but h1 == h24 meaning all volume in last hour — brand new token
- +876% in 1h then -20% in 5m — classic pump.fun pump-and-dump
- Correctly rejected by all three strategies

---

## Discord Integration

**Channel:** `#astra-live-feed`  
**Webhook env var:** `DISCORD_WEBHOOK_URL`

**Notification types:**
1. `botStarted` — fires on every restart, includes settings diff if anything changed
2. `tradeOpen` — momentum/scalp/breakout entries with MC, Q, vol
3. `tradeClose` — all normal exits
4. `stopLoss` — stop loss hits
5. `partialExit` — scalp 80% partial exits
6. `marketAlert` — yellow/orange/red BTC alerts
7. `allClear` — market stable after 4h
8. `configUpdate` — standalone config change announcement

**Settings diff system:** On every restart, `settingsDiff.js` compares current settings against `data/settings_snapshot.json`. Only safe keys are diffed (no credentials). Changes are included in the botStarted Discord message in teal.

---

## DexScreener Fetching Strategy

Two separate fetch functions:

**`fetchTopSolanaTokens()`** — used by momentum + scalp
- Searches: pump, sol, meme, cat, dog, pepe, moon, ai, based
- Sorted by 24h volume, returns top 250
- Biased toward micro-caps ($50K–$500K range)

**`fetchMidCapSolanaTokens(mcMin, mcMax)`** — used by breakout only
- Searches: solana, raydium, jupiter, bonk, wif, jup, orca, drift, tensor, popcat, fwog, mother, goat, bome, myro, slerf, mew, finance, protocol, network
- Sorted by **1h volume** (not 24h — breakout wants tokens moving NOW)
- Filtered client-side to MC range
- Yields ~20–40 candidates vs ~6 with old approach

---

## MCP Servers (Claude Code Integration)

**Config location:** `~/.claude/settings.json` → `mcpServers`
**Transport:** All via `npx -y` (auto-downloads on first use)
**Activation:** Requires Claude Code session restart after config changes

| Server | Package | Purpose |
|--------|---------|---------|
| jupiter | `@mcp-dockmaster/mcp-server-jupiter` | Solana swap quotes & execution |
| dexscreener | `@opensvm/dexscreener-mcp-server` | Real-time DEX pair data, token search |
| coingecko | `coingecko-mcp-server` | Market data for 15K+ coins |
| crypto-feargreed | `@kukapay/crypto-feargreed-mcp` | Fear & Greed index (regime detection) |
| crypto-indicators | `@kukapay/crypto-indicators-mcp` | RSI, MACD technical signals |
| defillama | `@dcspark/mcp-server-defillama` | TVL & DeFi liquidity analytics |

**Use cases for the bot:**
- **jupiter** — can replace direct Jupiter API calls for swap execution
- **dexscreener** — alternative data source for token discovery/validation
- **crypto-feargreed** — input signal for regime detection (bear/flat/bull)
- **crypto-indicators** — RSI/MACD for breakout confirmation
- **coingecko + defillama** — macro market context, TVL validation for larger caps

**Status note (Feb 25):** Config was lost after initial setup due to session restart overwriting `settings.json`. Re-added all 6 servers. Verify with `/mcp` after restart.

---

## Known Issues / Watch List

- **Stop loss slippage** — ~~actual avg loss is -26% vs -20% target~~ MITIGATED: Fast stop loss monitor (10s Jupiter Price API) added Feb 25. Still monitor avg loss to verify improvement.
- ~~**BTC market guard in-memory**~~ — FIXED Feb 25: btc_guard.json persists all state (price history, vol history, alert level, baseline volatility). Survives restarts.
- **Breakout re-entry cooldown in-memory** — resets on restart. Acceptable since breakout doesn't fire often. Could persist to disk later if needed.
- **$320K–$2M MC gap** — no strategy covers this range. Tokens like RETARDS ($311K) fall through. Not necessarily a problem, just a known blind spot.
- **RIZZTER** — appeared in logs at Q:40–70, Vol 3.1–3.4x. Would be blocked by new 5x vol floor. Good filter confirmation.

---

## Infrastructure History

| Date | Event |
|------|-------|
| Feb 22 | Bot rebuilt from Base44 backup, deployed to Railway |
| Feb 22 | Railway blocked Jupiter API — migrated to DigitalOcean VPS |
| Feb 22 | DigitalOcean also blocked — wallet key compromised, rotated |
| Feb 22 | **Root cause found:** Jupiter API deprecated old endpoint. Fixed. |
| Feb 22 | Bot deployed locally on Windows home machine — working |
| Feb 22 | Dashboard built with Marathon cyberpunk aesthetic |
| Feb 23 | Protection system built (5 layers) |
| Feb 23 | Discord webhook integrated |
| Feb 23 | Cooldown persistence bug fixed (cooldownStore.js) |
| Feb 24 | Vol filter tuned: 2x→5x floor, 12x cap added |
| Feb 24 | Q threshold lowered: 65→55 |
| Feb 24 | Breakout data source fixed: dedicated fetchMidCapSolanaTokens() |
| Feb 24 | Settings diff system built (auto-posts config changes to Discord) |
| Feb 25 | First full PnL audit: 72 closed trades, -0.645 SOL, 19.4% WR |
| Feb 25 | 6 MCP servers configured (jupiter, dexscreener, coingecko, feargreed, indicators, defillama) |
| Feb 25 | BTC Market Guard persisted to disk (btc_guard.json) — survives restarts |
| Feb 25 | Fast stop loss monitor added (Jupiter Price API, 10s interval) — mitigates -26% avg loss slippage |
| Feb 25 | Momentum interval lowered 90s → 45s (DexScreener rate budget: ~93 req/min vs 300 cap) |
| Feb 25 | Jupiter API migrated: lite-api.jup.ag → api.jup.ag + x-api-key header (free key from portal.jup.ag) |

---

## Roadmap / Next Up

- [x] **Investigate stop loss slippage** — MITIGATED: added fast stop loss (10s Jupiter Price API). Monitor avg loss improvement.
- [ ] Isolate pre vs post vol filter win rates (cutoff: Feb 24 vol filter change)
- [ ] Monitor breakout strategy — does 29 candidates → actual signals?
- [ ] Collect 48–72h of data under new vol filter (5–12x), measure win rate improvement
- [ ] Tailscale + Termius for iPhone monitoring access
- [ ] Daily summary notification (midnight trigger)
- [x] Consider persisting BTC alert state to disk — DONE: btc_guard.json
- [ ] Integrate MCP servers into bot — feargreed for regime detection, indicators for breakout confirmation
- [ ] Electron app packaging (discussed, not started)
- [ ] Multi-user deployment (3-week horizon)

---

## Session Notes / One-Liners

- Always check `data/cooldowns.json` exists before asking why cooldowns aren't firing
- `node --input-type=module < filename.js` to syntax check — ERR_MODULE_NOT_FOUND is expected/clean
- Settings are all env vars with defaults in `config/settings.js` — no hardcoded values
- Paper trading mode: `PAPER_TRADING=true` in `.env`
- Bot runs on port 3000 for dashboard API
- `punycode` deprecation warning on startup is harmless — Node.js v24 issue, ignore it
- trades.json lives at `data/trades.json` — 72 trades as of Feb 25, ~66KB
- Current PnL data was collected during SOL downtrend — baseline WR is likely understated
- To analyze trades: `type data\trades.json` and paste into Claude for full breakdown
- Jupiter API key (free tier, 60 req/min) — required for both swap and price APIs. Generate at portal.jup.ag. Stored as `JUPITER_API_KEY` in `.env`
- `lite-api.jup.ag` is deprecated — all Jupiter calls now go through `api.jup.ag` with `x-api-key` header
