# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Update this at the end of every session via `/finalize` (runs validation first).

---

## Commands

```bash
# Run the bot
node index.js

# Validate all 28 files (syntax + boot test), ~3 seconds
node scripts/validate.js

# Syntax-check a single file
node --check <file.js>
```

There are no tests, no linter, no build step. The project is ES modules (`"type": "module"` in package.json). Node.js 18+.

---

## SESSION RECAP (Mar 3 — Optimization Audit: 5 Efficiency Fixes)

**Context:** End-of-week "sharpen the extra 10%" audit. Identified 5 real inefficiencies (filtered out 5 agent-overclaimed non-issues). All fixes are small, surgical changes across 4 files — no new files, no architecture changes.

**What was done this session:**
1. ✅ **Sell race condition guard** — `pendingSells` Set in `activeTrades.js` prevents both the 60s monitor and 10s fast stop loss from selling the same trade simultaneously. Same pattern as pumpfun.js. Critical for going live (prevents double Jupiter transactions/gas waste).
2. ✅ **DexScreener fetch cache** — 60s TTL cache in `dexscreener/index.js` for `fetchTopSolanaTokens()` (single cache) and `fetchMidCapSolanaTokens()` (keyed by `mcMin:mcMax`). Saves ~25 DexScreener API calls/min (~50% reduction). Momentum (45s) gets fresh, scalp (90s) gets cached. Midcap and breakout use different MC ranges so cache separately.
3. ✅ **CoinGecko rate limiter** — Max 3 fresh CoinGecko calls per breakout cycle in `trendCheck.js`. Prevents 429 error bursts when 10-20 new downtrend candidates appear. Cache TTL increased from 30min to 2h (downtrend status doesn't change fast). Skipped tokens get checked next cycle.
4. ✅ **Cooldown entry pruning** — `getEntryCount()` in `cooldownStore.js` now prunes individual stale entries from the `entries[]` array (not just the whole token key). Keeps `.count` in sync with pruned array. Prevents unbounded growth after months of trading.
5. ✅ **Stale trade P&L gap closed** — Stale exit lower bound widened from hardcoded `-5%` to `-(trade.stop_loss_percent || settings.stop_loss_percent)`. A trade at -10% that flatlines no longer sits in the dead zone between stale range and stop loss — now gets cleaned up after 90min.

**Files modified:** `monitor/activeTrades.js`, `dexscreener/index.js`, `analysis/trendCheck.js`, `utils/cooldownStore.js`

**Verification:**
- `node scripts/validate.js` → 28/28 syntax, 27/27 boot = PASS
- All consumer code verified — no breaking changes (function signatures, return types, import paths all unchanged)
- Race guard: watch `[SELL]` logs — same trade should not show sell attempts from both `[MONITOR]` and `[FAST_SL]`
- DexScreener: call count should drop from ~55/min to ~30/min
- CoinGecko: no more 429 errors in startup logs; `[TREND] Rate limit: skipping` when cap hit
- Cooldowns: `data/cooldowns.json` entries[] arrays stay pruned, won't grow unbounded
- Stale exit: trades at -10% (above stop loss) now eligible for stale exit after 90min timeout

**Non-issues verified (agent overclaimed):**
- `loadSettings()` 36x/min — no disk I/O, returns in-memory variable
- contentFilter `_logThrottle` Map — ~100 bytes per token, negligible
- scalp `monitorCounts` Map — scalp is PAUSED, entries cycle naturally
- trades.json 305KB — hits 1MB in ~6 months, not a concern yet
- activeTrades writes trades.json 60x/min — `writeFileSync` on 305KB takes <1ms

**Previous session (Mar 3 — Quiet Hours Checkpoint):**

Quiet Hours Checkpoint: activity-based idle briefing (zero trades 15min → Discord embed with portfolio + strategy + market context). 4h cooldown. Bug fixes: trade status filter, exit_time field, falsy-zero.

**Previous session (Mar 3 — Alpha Filter Tuning + Runtime Fixes):**

Pumpfun race condition fixes (pendingBuys/pendingSells Sets). Consecutive stop isolation. SOL price cache (CoinGecko 5min TTL). Alpha-only toggle + relaxed alpha filters. Stale artifact tagging for PnL analysis.

**Previous session (Mar 2 — Refinement Day: Tighten Controls, Pause Scalp, Fix Pumpfun):**

**Context:** 241 trades analyzed (Feb 22 - Mar 2). Total PnL: -0.897 SOL.

1. ✅ **Momentum UTC block** — Blocks entries during 12-15 & 18-21 UTC (configurable via `momentum_block_utc_ranges`). Data: 19% WR combined, -0.643 SOL (70% of momentum losses).
2. ✅ **Momentum no re-entries** — Re-entry cap lowered from 2 to 1 per token per 24h. Data: re-entries 19% WR, -0.330 SOL.
3. ✅ **Momentum profit target** — Auto-sell at +25% via `momentum_target_gain_percent`. Data: 11 trades saw +30%+ then reversed to losses.
4. ✅ **Scalp paused** — `SCALP_ENABLED=false` in .env. Data: 0W/8L post-Feb-28.
5. ✅ **Pumpfun MC fix (critical)** — Uses PumpPortal's `marketCapSol` field instead of hardcoded TOTAL_SUPPLY.
6. ✅ **Breakout 1h pump 10→5** — Catches entries 30-45min earlier.
7. ✅ **Settings + SAFE_KEYS** — Added `momentum_target_gain_percent`, `momentum_block_utc_ranges`, `breakout_min_1h_pump`.

**Known:** Hard kill -35% leaks on drained tokens (blockchain latency, not a bug). Holder concentration check (lines 166-171 in momentum.js) is now dead code since entryCount >= 1 blocks before it fires — harmless, no need to remove.

**Previous session (Feb 28 — Alpha Token Tracker: Community Launch Pipeline):**

**What was done this session:**
1. ✅ **Alpha token tracking** — Detects tokens from known alpha groups (e.g. Uxento) at pump.fun creation. Fetches pump.fun token descriptions, matches against configurable patterns, tags tokens for cross-strategy tracking.
2. ✅ **Cross-strategy stage pipeline** — Alpha-tagged tokens tracked through pumpfun → midcap → breakout stages. Each strategy independently enters as token moves through its MC range. Positions stack across strategies.
3. ✅ **Strategy-specific entry counting** — `cooldownStore.js` `recordEntry/getEntryCount` now accept optional `strategy` param. Alpha tokens use per-strategy count so a pumpfun entry doesn't block midcap's 1/24h cap.
4. ✅ **Hot-reloadable alpha sources** — `data/alpha_sources.json` with 60s TTL cache (same pattern as content_blocklist). Add new groups by editing the file — no code changes needed.
5. ✅ **Discord notifications** — `notify.alphaStageEntry()` posts purple embed on each strategy entry for alpha tokens. Source, strategy, MC, stage number.
6. ✅ **Persistence + pruning** — Alpha token data persisted to `data/alpha_tokens.json`. Entries older than 7 days auto-pruned on load.

**Files created:** `store/alphaTokens.js`, `data/alpha_sources.json`
**Files modified:** `strategies/pumpfun.js`, `strategies/midcap.js`, `strategies/breakout.js`, `utils/cooldownStore.js`, `utils/discord.js`, `config/settings.js`, `utils/settingsDiff.js`, `CLAUDE.md`

**Verification:**
- `node scripts/validate.js` → PASS (28 syntax, 27 boot)
- Create `data/alpha_sources.json` with Uxento pattern (done)
- Start bot → watch for `[PUMPFUN] 🏷 Alpha token detected` lines
- If an alpha token passes pumpfun filters → Discord shows purple stage entry embed
- If same token later appears in midcap/breakout range → entry cap doesn't block it
- Edit `alpha_sources.json` to add a test pattern → picks up within 60s
- Disable with `ALPHA_TRACKING_ENABLED=false`

**Previous session (Feb 28 — Midcap Strategy: Closing the $320K–$2M Gap):**
1. Midcap strategy fills $320K–$2M gap. 17 new settings, regime overlays, full exit integration, 12 protection layers.

**Previous session (Feb 28 — Content Filter for Brand Safety):**

**What was done this session:**
1. ✅ **Content filter** — `utils/contentFilter.js` blocks tokens with offensive/hateful names before any trade decision. L33t speak normalization (decodes `1→i, 3→e, 0→o, 4→a, 5→s, 7→t, @→a, $→s, !→i, 8→b`). Two match modes: substring (unambiguous terms) and word boundary (short terms that would false-positive as substrings).
2. ✅ **Hot-reloadable blocklist** — `data/content_blocklist.json` with 60s TTL cache. Terms stored in l33t-encoded form (no explicit slurs in the file). Edit while bot runs, changes take effect within 60s. 7 categories + word boundary list.
3. ✅ **All 5 strategies gated** — Pumpfun blocks at watchlist level (before WebSocket subscription), momentum/scalp/midcap/breakout block as first check in evaluation. Offensive tokens never enter any pipeline.
4. ✅ **Discord sanitization** — `sanitizeForDisplay()` in contentFilter.js, wired into all 4 Discord notification functions (tradeOpen, tradeClose, stopLoss, partialExit). Offensive symbols render as `[FILTERED]`. Unconditional — works even if content_filter_enabled is false.
5. ✅ **Settings toggle** — `content_filter_enabled` (default true, disable with `CONTENT_FILTER_ENABLED=false`). Added to settingsDiff SAFE_KEYS.

**Files created:** `utils/contentFilter.js`, `data/content_blocklist.json`
**Files modified:** `config/settings.js`, `utils/settingsDiff.js`, `utils/discord.js`, `strategies/pumpfun.js`, `strategies/momentum.js`, `strategies/scalp.js`, `strategies/breakout.js`, `CLAUDE.md`

**Verification:**
- `node scripts/validate.js` → PASS (26 syntax, 25 boot)
- Start bot → `content_filter_enabled` shows in Discord settings diff
- Watch console for `[CONTENT] BLOCKED <symbol>` lines (throttled: same symbol max once per 5min)
- Discord notifications will show `[FILTERED]` for any offensive symbol that reaches the notification layer
- Edit `data/content_blocklist.json` while running → changes take effect within 60s
- To test: temporarily add a known-clean token name to blocklist → verify block → remove

**Previous session (Feb 28 — Pumpfun Diagnostic Logging + Architectural Safety Nets):**
1. Pumpfun diagnostic logging (11 filters log `[PUMPFUN] SKIP`), stop loss export, activeTrades/fastStopLoss pumpfun integration, PumpPortal callback safety.

**Previous session (Feb 27 — Sell Pressure Exit Extended to All Strategies):**
1. Sell pressure exit extended to all 4 strategies (breakout 40%, momentum 35%, scalp 35%, pumpfun 30%). 8 new settings.

---

## What This Project Is

**ASTRA** is an automated Solana trading bot running locally on a Windows machine.
- **Stack:** Node.js (ES modules), Jupiter API (api.jup.ag, key required), DexScreener API, PumpPortal WebSocket, Helius RPC
- **Mode:** Paper trading (no real money yet)
- **Location:** `C:\Users\black\astra\solscalp-bot\`
- **Run command:** `node index.js` from project root
- **Dashboard:** Marathon cyberpunk aesthetic, ASCII space canvas, exoplanet background

---

## Architecture Overview

```
index.js                          ← entry point, runs all loops + WebSocket concurrently
├── strategies/
│   ├── pumpfun.js                ← pump.fun bonding curve scalp ($6K–$60K MC, WebSocket-driven)
│   ├── momentum.js               ← pump.fun graduation sniper ($75K–$100K MC)
│   ├── scalp.js                  ← tight range scalper ($280K–$320K MC)
│   ├── midcap.js                 ← midcap gap filler ($320K–$2M MC, +30% target)
│   └── breakout.js               ← mid-cap compounder ($2M–$20M MC)
├── pumpfun/
│   └── portal.js                 ← PumpPortal WebSocket client (real-time Pump.fun data)
├── monitor/
│   ├── activeTrades.js           ← monitors open positions, fires exits (60s DexScreener)
│   └── fastStopLoss.js           ← fast stop loss via Jupiter Price API (10s interval)
├── analysis/
│   ├── scoring.js                ← token quality + health scoring
│   ├── holderCheck.js            ← Helius holder concentration check (whale detection on re-entry)
│   └── trendCheck.js             ← CoinGecko 14-day downtrend detection (breakout DT bounce)
├── dexscreener/
│   └── index.js                  ← token fetching (fetchTopSolanaTokens + fetchMidCapSolanaTokens)
├── utils/
│   ├── discord.js                ← webhook notifier (all 12 notification types)
│   ├── settingsDiff.js           ← diffs settings on restart, posts changes to Discord
│   ├── claudeMdDiff.js          ← diffs CLAUDE.md on restart, posts sanitized recap to Discord
│   ├── marketGuard.js            ← BTC cascade protection (persisted to btc_guard.json)
│   ├── regimeDetector.js         ← BEAR/FLAT/BULL detection (F&G + BTC trend + vol, persisted to regime.json)
│   ├── cooldownStore.js          ← persistent per-token cooldowns + entry history (survives restarts)
│   ├── contentFilter.js          ← brand safety filter (blocks offensive token names, l33t normalization)
│   └── logger.js
├── config/
│   ├── settings.js               ← all settings via env vars with defaults + regime overlay
│   └── regimes.js                ← BEAR/FLAT/BULL parameter presets + applyRegime()
├── store/
│   └── alphaTokens.js            ← alpha token registry (tag, track stages, persist, hot-reload sources)
├── data/
│   ├── cooldowns.json            ← persistent stop loss cooldowns + entry history (re-entry cap)
│   ├── btc_guard.json            ← persistent BTC market guard state (survives restarts)
│   ├── regime.json               ← persistent regime state (BEAR/FLAT/BULL + score + signals)
│   ├── trades.json               ← full trade history (all entries/exits)
│   ├── settings_snapshot.json   ← baseline for settings diff on restart
│   ├── content_blocklist.json   ← offensive token name blocklist (hot-reloadable, 60s cache)
│   ├── alpha_sources.json       ← alpha group patterns (hot-reloadable, 60s cache)
│   ├── alpha_tokens.json        ← tracked alpha tokens + stage history (auto-pruned 7d)
│   └── quiet_checkpoint.json   ← quiet hours cooldown state (lastSentAt timestamp)
├── jupiter/
│   └── index.js                  ← Jupiter swap API (migrated to api.jup.ag + x-api-key)
├── scripts/
│   └── validate.js               ← session validator (syntax + boot test all 28 files)
├── .claude/
│   └── commands/
│       └── finalize.md           ← /finalize slash command (validation → cascade → CLAUDE.md update)
└── .env                          ← DISCORD_WEBHOOK_URL, HELIUS_API_KEY, WALLET_PRIVATE_KEY, JUPITER_API_KEY, WHALE_TRACKING_ENABLED, CONTENT_FILTER_ENABLED, ALPHA_TRACKING_ENABLED
```

---

## Protection System (5 Layers — All Active)

| Layer | What It Does | Persistence |
|-------|-------------|-------------|
| SOL price failsafe | Pauses entries if SOL drops 7%+ in 1h | In-memory (resets on restart) |
| Consecutive stop pause | 2 stops in 30min → 90min pause (momentum + scalp + midcap) | ✅ Disk (cooldowns.json) |
| Per-token cooldown | 45min cooldown after stop loss (momentum + scalp + midcap) | ✅ Disk (cooldowns.json) |
| Re-entry cap | Max 1 entry/token/24h (momentum + scalp + midcap + pumpfun), max 2 (breakout) | ✅ Disk (cooldowns.json entryHistory) |
| Momentum UTC block | No entries 12-15 & 18-21 UTC (data: 19% WR, -0.643 SOL) | Settings (momentum_block_utc_ranges) |
| Momentum profit target | Auto-sell at +25% (data: 11 trades reversed from +30%+) | Settings (momentum_target_gain_percent) |
| BTC yellow alert | 3% drop in 1h → pause entries | ✅ Disk (btc_guard.json) |
| BTC orange alert | 4% drop in 4h → pause + tighten stops | ✅ Disk (btc_guard.json) |
| BTC red alert | 5% drop in 30m or 10x vol spike → close momentum positions | ✅ Disk (btc_guard.json) |
| Fast stop loss | Jupiter Price API every 10s → immediate sell on stop hit | In-memory (real-time) |
| Stale trade exit | Momentum/scalp/midcap/pumpfun trades open >90min with P&L between stop loss and +5% auto-close | Settings (stale_trade_timeout_ms) |
| Unsellable auto-close | 3 failed sell cycles → force close trade + Discord alert | In-memory (resets on restart) |
| Scalp volume filter | 3x–15x vol multiplier gate (same formula as momentum) | Settings (scalp_volume_multiplier) |
| Regime detection | BEAR/FLAT/BULL auto-adjusts parameters (sizes, targets, intervals) | ✅ Disk (regime.json) |
| Hard kill circuit breaker | -35% catastrophic loss → max slippage sell (prevents -50%+ gaps) | Settings (hard_kill_loss_percent) |
| Scalp UTC block | No scalp entries 00-06 UTC (data: 0% WR in this window) | Settings (scalp_block_hours_start/end) |
| Downtrend bounce | Per-token: 2-stage detection (DexScreener + CoinGecko 14d), stricter entry params | In-memory (30min cache) |
| Pumpfun MC ceiling | Sell before graduation — $60K cap prevents holding through migration | Settings (pumpfun_max_mc) |
| Pumpfun stale exit | 10min max hold without target/stop hit → force sell | Settings (pumpfun_stale_timeout_ms) |
| Sell pressure exit | All 5 strategies: exit when buy_pressure drops below threshold while in profit | Settings ({strategy}_sell_pressure_enabled/threshold) |
| Sell race guard | `pendingSells` Set prevents activeTrades (60s) and fastStopLoss (10s) from double-selling same trade | In-memory (same pattern as pumpfun.js) |
| Pumpfun fallback exit | activeTrades + fastStopLoss handle pumpfun trades if WebSocket drops | In-memory (stop loss → cooldown recorded) |
| Content filter | Blocks offensive/hateful token names (l33t normalization, substring + word boundary) + Discord sanitization | ✅ Disk (content_blocklist.json, 60s hot-reload) |
| Alpha tracking | Detects tokens from known alpha groups at creation, tracks across strategy stages, per-strategy entry caps | ✅ Disk (alpha_tokens.json + alpha_sources.json, 60s hot-reload) |

---

## Strategy Parameters (Current Defaults)

### Pumpfun (bonding curve scalp — "Final Stretch")
```
Entry MC:     $6K – $60K (bonding curve tokens, sell before $69K graduation)
  Alpha:      $4K – $60K (alpha tokens detected early at creation)
Max age:      60 minutes (Decu0x filter)
Min volume:   25 SOL cumulative (proxy for activity/fees)
  Alpha:      10 SOL (alpha tokens have less initial volume)
Buy pressure: 60%+ (buyers dominating)
  Alpha:      55%+ (slightly relaxed for early-stage alpha tokens)
Target:       +25% (quick scalp)
Stop loss:    -20%
MC ceiling:   $60K (exit before graduation — never hold through migration)
Sell press:   exit if buy_pressure < 30% while in profit (WS-based, real-time)
Stale exit:   10 minutes max hold without target/stop
Trade size:   0.1 SOL
Max positions: 3 concurrent
Cooldown:     30 min per-token after stop loss
Re-entry cap: 1 per token per 24h
Discovery:    PumpPortal WebSocket (real-time, not polling)
Execution:    Jupiter (routes through Pump.fun bonding curve)
Inspiration:  Decu0x (kingdecu.sol) — 157 trades/day, 57% WR, <2min holds
```

### Momentum (pump.fun graduation sniper)
```
Entry MC:     $75K – $100K  ← tightened from $110K (data: $100-110K = 18% WR trap zone)
Exit MC:      $135K – $180K
Profit target: +25%  ← NEW (data: 11 trades saw +30%+ then reversed to losses, -0.335 SOL)
Vol min:      5x   ← raised from 2x (data: <5x = 0% win rate)
Vol max:      12x  ← cap (>12x = 0% WR, 15% avg slippage)
Stop loss:    -20% (hard kill at -35% prevents catastrophic gaps)
Sell press:   exit if buy_pressure < 35% while in profit (DexScreener 5min window)
Trade size:   0.1 SOL
Q threshold:  55   ← lowered from 65 (Q score has weak predictive value)
Interval:     45s  ← lowered from 90s (Feb 25, DexScreener rate limit safe at ~93 req/min vs 300 cap)
Re-entry cap: 1 per token per 24h  ← tightened from 2 (data: re-entries 19% WR, -0.330 SOL)
UTC block:    12-15 & 18-21 UTC  ← NEW (data: 19% WR combined, -0.643 SOL = 70% of momentum losses)
Logged:       buy_pressure, pump_1h, pump_5m, price_change_24h (NEW — enables future filter analysis)
```

### Scalp (PAUSED — 0W/8L post-Feb-28)
```
⚠ PAUSED via SCALP_ENABLED=false in .env — re-enable anytime
Entry MC:     $280K – $320K
Exit MC:      $500K
Target:       +30%  ← lowered from 70% (data: 19/28 losers saw +10% before reversing, 70% too greedy)
Vol min:      3x   ← hourly vol gate (same formula as momentum)
Vol max:      15x  ← wider than momentum (higher MC = different vol patterns)
Stop loss:    -20% (hard kill at -35% prevents catastrophic gaps)
Sell press:   exit if buy_pressure < 35% while in profit (DexScreener 5min window)
Trade size:   0.1 SOL
Cooldown:     45 min per-token after stop loss (reuses cooldownStore.js)
Re-entry cap: 1 per token per 24h  ← tightened from 2 (data: re-entries 18.8% WR vs 25% first entry)
UTC block:    00-06 UTC entries blocked  ← NEW (data: 0 wins out of 8 trades in this window)
Logged:       vol_multiplier, buy_pressure, pump_1h, pump_5m, price_change_24h (NEW — enables analysis)
```

### Midcap (gap filler — "Take the 30% and walk away")
```
Entry MC:     $320K – $2M (fills exact gap between scalp and breakout)
1h pump min:  +5% (must be actively trending)
5m pump min:  +1% (enter into strength, not a stall)
24h pump cap: 300% max (block extreme rug risk)
Buy pressure: 55%+
Vol min:      2x (want momentum)
Vol max:      10x (not FOMO peaks)
Liquidity:    $25K+ (graduated pumpfun tokens may start lower)
Q threshold:  55
Target:       +30% (user's explicit request — take profit, no greed)
Stop loss:    -15% (tighter — this range has better liquidity, stops hold)
Hard kill:    -35% (shared circuit breaker)
Sell press:   exit if buy_pressure < 35% while in profit (DexScreener 5min window)
Stale exit:   90 min (shared timeout — flat trades are dead money)
Trade size:   0.1 SOL
Cooldown:     45 min per-token after stop loss (reuses cooldownStore.js)
Re-entry cap: 1 per token per 24h (conservative — user burned on re-entries)
Consec stops: Shared (2 stops in 30min → 90min pause)
Scan interval: 60s (this range moves fast)
Discovery:    Reuses fetchMidCapSolanaTokens() — DexScreener keywords + Jupiter toptraded/1h
```

### Breakout (mid-cap compounder)
```
Entry MC:     $2M – $20M
Vol min:      1.5x
1h change:    +5% minimum    ← lowered from 10% (data: sell_pressure avg +5% suggests entries were late)
5m change:    +2% minimum    ← raised from 0.5% (top buys avg 2.44%, good entries avg 8.3%)
24h cap:      200% maximum   ← blocks extreme rug risk (AXIOMGATE +3880% → -80%)
Buy pressure: 55%+
Liquidity:    $50K minimum
Q threshold:  55   ← lowered from 75 (Q score has weak predictive value, matching momentum)
Stop loss:    -12%
Sell press:   exit if buy_pressure < 40% while in profit (DexScreener 5min, proven +5.28% avg)
Target:       +20%
Trade size:   0.2 SOL
Re-entry:     10min cooldown + max 2 per token per 24h  ← NEW cap (backtest: 3rd+ entries lose)
Discovery:    DexScreener keywords (21) + Jupiter toptraded/1h (toggle: BREAKOUT_JUPITER_DISCOVERY)
Logged:       vol_multiplier, buy_pressure, pump_1h, pump_5m, price_change_24h, volume_6h, volume_mc_ratio, pair_age_hours
```

### Breakout Downtrend Bounce (stricter params for tokens in decline)
```
Detection:    Stage 1: 24h < -10% AND 6h < -3% (DexScreener snapshot)
              Stage 2: CoinGecko 14-day decline > 20% (historical confirmation)
1h change:    +5% minimum    ← stricter (need stronger momentum to confirm real bounce)
5m change:    +1.5% minimum  ← stricter (need active buying RIGHT NOW)
Buy pressure: 62%+           ← stricter (buyers must clearly dominate)
Vol min:      3x             ← stricter (volume spike must be significant)
Liquidity:    $250K minimum  ← stricter (need deep liquidity for clean exit)
Stop loss:    -8%            ← tighter (cut losses faster — downtrend can resume)
Target:       +20% (same)
Trade size:   0.2 SOL (same)
Toggle:       BREAKOUT_DT_ENABLED=false to disable
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

**Re-entry without cooldown was the biggest damage multiplier** — CTO stopped 3x, CLAW stopped 2x, KIM stopped 2x. Fixed by persistent cooldowns + 2/24h re-entry cap + holder concentration check on re-entry.

**SITH (-54%)** was a rug pull — instant liquidity drain in one 60-second window. Unavoidable by any stop loss system.

---

## Overall PnL Snapshot (as of Feb 27, 2026)

**123 closed trades | 3 active | Paper trading**

| | Momentum | Scalp | Breakout | Combined |
|---|---|---|---|---|
| Record | 16W / 45L | 8W / 28L | 22W / 4L | **46W / 77L** |
| Win Rate | 26.2% | 22.2% | 84.6% | **37.4%** |
| Avg Win | +45.6% | +79.6% | +3.8% | varies |
| Avg Loss | -28.1% | -25.2% | -29.2% | varies |
| Net PnL | -0.535 SOL | -0.068 SOL | -0.065 SOL | **-0.669 SOL** |

**Active positions:** SAMO (breakout, flat), GOAT (breakout, -0.4%), PsyopAnime (breakout, -4.5%)

### Key Findings (Feb 27 deep analysis)
- **Momentum post-vol-filter**: 46.2% WR, +0.137 SOL — the 5x-12x filter is WORKING. Bleed is from pre-filter trades.
- **Momentum MC trap zone**: $100-110K = 18% WR. Below $100K = 31.6% WR. Fixed: MC cap tightened to $100K.
- **Scalp 70% target too greedy**: 19/28 losers saw +10% profit before reversing. Fixed: target lowered to 30%.
- **Scalp 3 catastrophic losses**: -0.198 SOL from 3 trades (Limited -95.7%, Punch-ku -54.4%, Leopard -47.5%). Without them, scalp = +0.130 SOL. Fixed: hard kill at -35%.
- **Breakout without AXIOMGATE**: +0.095 SOL at 88% WR. Fixed: 24h pump cap catches rugs.
- **Re-entries destroy value**: momentum re-entries 19% WR net -0.330 SOL; scalp re-entries 18.8% WR. Scalp capped to 1/token.

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

**Notification types (12):**
1. `botStarted` — fires on every restart, includes settings diff if anything changed
2. `tradeOpen` — all strategy entries (momentum, scalp, breakout) with MC, Q, vol
3. `tradeClose` — all normal exits
4. `stopLoss` — stop loss hits
5. `partialExit` — scalp 80% partial exits
6. `marketAlert` — yellow/orange/red BTC alerts
7. `allClear` — market stable after 4h
8. `configUpdate` — standalone config change announcement
9. `regimeChange` — BEAR/FLAT/BULL regime transitions with score breakdown
10. `claudeUpdate` — CLAUDE.md changes on restart (session recap, sanitized)
11. `alphaStageEntry` — alpha token entering a strategy stage (purple embed, source + MC + stage)
12. `quietCheckpoint` — idle briefing when zero trades for 15min (portfolio + strategy + market context, 4h cooldown)

**Settings diff system:** On every restart, `settingsDiff.js` compares current settings against `data/settings_snapshot.json`. Only safe keys are diffed (no credentials). Changes are included in the botStarted Discord message in teal.

---

## DexScreener Fetching Strategy

Two separate fetch functions:

**`fetchTopSolanaTokens()`** — used by momentum + scalp
- Searches: pump, sol, meme, cat, dog, pepe, moon, ai, based
- Sorted by 24h volume, returns top 250
- Biased toward micro-caps ($50K–$500K range)
- **Cached 60s** — momentum (45s) gets fresh, scalp (90s) gets cached

**`fetchMidCapSolanaTokens(mcMin, mcMax, opts)`** — used by breakout only
- **Source 1 — DexScreener keywords (21 searches):** solana, raydium, jupiter, bonk, wif, jup, orca, drift, tensor, popcat, fwog, mother, goat, bome, myro, slerf, mew, finance, protocol, network
- **Source 2 — Jupiter toptraded/1h (1 API call):** top 100 tokens by actual swap volume, pre-filtered to 500K-50M MC, deduped against keyword results, batch-looked up on DexScreener. Catches tokens with novel/generic names that keywords miss.
- Both sources run in parallel, merged + deduped by address
- Sorted by **1h volume** (not 24h — breakout wants tokens moving NOW)
- Filtered client-side to MC range
- Toggle: `opts.jupiterDiscovery` (default true), controlled by `BREAKOUT_JUPITER_DISCOVERY` env var
- **Cached 60s** per MC range key — midcap and breakout cache separately but avoid re-fetching within 60s
- API budget per cycle: +1 Jupiter req + 1-2 DexScreener batch reqs (~30 total vs 300/min cap, down from ~55)

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

- **Stop loss slippage** — ~~actual avg loss is -26% vs -20% target~~ MITIGATED: Fast stop loss (10s) + hard kill circuit breaker at -35% (aggressive slippage for catastrophic gaps). Momentum avg loss -28.1%, scalp avg loss -25.2% — hard kill would have saved 3 catastrophic scalp losses (-0.198 SOL).
- ~~**BTC market guard in-memory**~~ — FIXED Feb 25: btc_guard.json persists all state (price history, vol history, alert level, baseline volatility). Survives restarts.
- ~~**Breakout had ZERO trades**~~ — FIXED Feb 25: Q threshold 75→55, 5m filter 1%→0.5%. Monitor logs for `[BREAKOUT]` signals. DT bounce detection added Feb 26 — watch for `↩ DT-BOUNCE` vs `🎯 Signal` log lines.
- ~~**Scalp had no volume filter**~~ — FIXED Feb 25: 3x–15x vol multiplier gate added. Monitor for over-filtering.
- ~~**Scalp had no per-token cooldown**~~ — FIXED Feb 25: reuses cooldownStore.js, 45min per-token cooldown after stop loss.
- ~~**Scalp target_gain_percent hardcoded to 70**~~ — FIXED Feb 25: now reads settings. FURTHER TUNED Feb 27: 70→30 based on data (19/28 losers saw +10% profit before reversing).
- **Breakout 10min re-entry cooldown in-memory** — resets on restart. The 2/24h re-entry cap IS persisted (cooldowns.json). Only the short cooldown between trades resets.
- ~~**closeTrade() doesn't persist exit_reason**~~ — FIXED Feb 27: `exit_reason` field now written to trades.json on every close. Enables future trade analysis by exit type.
- ~~**$320K–$2M MC gap**~~ — FIXED Feb 28: midcap strategy covers $320K–$2M. +30% target, -15% stop, sell pressure exit at 35%, 1 entry/token/24h.
- **Pumpfun MC calculation fixed** — Root cause identified: hardcoded `TOTAL_SUPPLY = 1B` produced $0 MC for all tokens. Fixed: now uses PumpPortal's `marketCapSol` field. Diagnostic logging added to confirm field names. Once sample data captured, refine SOL price source (currently uses rough $140 fallback).
- ~~**Stale trade exit needs tuning**~~ — FIXED Mar 3: P&L range widened from `-5% to +5%` to `-(stop_loss) to +5%`. Catches trades stuck at -10% that were in the dead zone between old stale range and stop loss.
- ~~**Unsellable tokens retry forever**~~ — FIXED Feb 25: after 3 failed executeSell calls, trade auto-closes with reason `unsellable`. Triggered by Fergani (liquidity drained) and house (0x1789 slippage errors).
- **DexScreener delisting** — CAT returned no data from DexScreener, causing `[MONITOR] No data` spam every 60s. Force-closed manually. Unsellable auto-close doesn't catch this since the sell is never attempted (no price data). Could add a "no data for N cycles → force close" check later.

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
| Feb 25 | Regime-aware trading system: BEAR/FLAT/BULL auto-detection (F&G + BTC trend + vol), parameter overlays, Discord notifications |
| Feb 25 | Strategy audit (80 trades): breakout filters loosened (Q 75→55, 5m 1%→0.5%), scalp vol filter (3x–15x), stale trade exit (90min), scalp cooldowns, scalp target_gain fix |
| Feb 25 | Scalp Discord notifications added, consecutive stop pause shared (momentum + scalp) via cooldownStore.js |
| Feb 25 | CLAUDE.md change notifications — diffs against snapshot on restart, posts sanitized session recap to Discord |
| Feb 25 | Sell slippage: 300 bps floor + 1500 bps cap for sells (buys unchanged). Unsellable auto-close after 3 failed sell cycles. |
| Feb 25 | BTC RED alert triggered ~22:00 UTC during Feb 2026 liquidation event (BTC -44% from Oct peak, $3-4B liquidations). All entries paused, 4h stability hold. |
| Feb 25 | Force-closed 3 dead trades: Fergani (drained), house (unsellable), CAT (delisted from DexScreener) |
| Feb 25 | Momentum re-entry protection: 2/24h cap (persistent), holder concentration check (Helius, optional via WHALE_TRACKING_ENABLED) |
| Feb 26 | Session validation system: `/finalize` skill + `scripts/validate.js` (syntax + boot test 22 files, cascade analysis) |
| Feb 26 | Breakout downtrend bounce detection: 2-stage (DexScreener snapshot + CoinGecko 14d history), stricter DT params, `analysis/trendCheck.js` |
| Feb 26 | Jupiter TopTraded discovery: supplemental breakout token source via `toptraded/1h` API, catches novel-name tokens keyword search misses |
| Feb 27 | Breakout entry filter tuning: 1h pump 2%→10%, 5m pump 0.5%→2%, 24h pump cap 200%, exit_reason persisted in trades.json |
| Feb 27 | Deep PnL audit (123 trades): momentum 80% of losses, scalp 3 catastrophic losses = entire drag |
| Feb 27 | Momentum MC cap $110K→$100K (data: $100-110K = 18% WR trap zone), entry metrics logged |
| Feb 27 | Scalp target 70%→30%, re-entry cap 2→1, UTC 00-06 block, entry metrics logged |
| Feb 27 | Hard kill circuit breaker at -35% (all strategies) — aggressive slippage on catastrophic losses |
| Feb 27 | Discord recap fix — claudeMdDiff.js regex now matches both `## SESSION RECAP` and `## 🚨 SESSION RECAP` |
| Feb 27 | Pump.fun pre-migration strategy ("Final Stretch"): PumpPortal WebSocket + bonding curve scalp via Jupiter. Inspired by Decu0x. |
| Feb 27 | Decu0x wallet analysis (4vw54...9Ud9): 157 trades/day, 57% WR, <2min holds, $3K-$20K MC, bot-assisted sniping |
| Feb 27 | MACMINI breakout backtest (39 trades): sell_pressure exit best (+5.28% avg, 6/10 exact peak), re-entry cap 2/token/24h, observation metrics logged |
| Feb 27 | Sell pressure exit extended to all 4 strategies (momentum 35%, scalp 35%, breakout 40%, pumpfun 30%). 8 new settings, all configurable via env vars. |
| Feb 28 | Pumpfun diagnostic logging: all 11 entry filters now log `[PUMPFUN] SKIP` with reason + details (throttled 30s). Identifies bottleneck filter for zero-trade issue. |
| Feb 28 | Pumpfun architectural safety nets: `recordPumpfunStopLoss` export, activeTrades fallback exits (target/MC ceiling/sell pressure), fastStopLoss cooldown recording, PumpPortal callback try-catch. |
| Feb 28 | settingsDiff SAFE_KEYS: 11 missing pumpfun keys added (was 2, now 13). Full settings diff on Discord restart. |
| Feb 28 | Content filter: brand safety for token names. `utils/contentFilter.js` + `data/content_blocklist.json`. L33t normalization, substring + word boundary match, 60s hot-reload. All 4 strategies gated. Discord notifications sanitized (`sanitizeForDisplay` in discord.js). |
| Feb 28 | Midcap strategy: closes $320K–$2M gap. 12 protection layers, reuses fetchMidCapSolanaTokens dual-source infra. Regime overlays (FLAT/BULL). Full activeTrades + fastStopLoss integration. |
| Feb 28 | Alpha token tracker: community launch pipeline. Detects tokens from known alpha groups (Uxento) at pump.fun creation via description matching. Tags and tracks across pumpfun → midcap → breakout stages. Strategy-specific entry counting in cooldownStore. Hot-reloadable `alpha_sources.json`. Discord purple embeds on stage entries. |
| Mar 2 | Refinement Day: momentum UTC block (12-15 & 18-21 UTC), re-entry cap 2→1, profit target +25%. Scalp paused (0W/8L). Pumpfun MC fix (marketCapSol instead of hardcoded TOTAL_SUPPLY). Breakout 1h pump 10→5. |
| Mar 3 | Pumpfun race condition fixes (pendingBuys/pendingSells Sets). Consecutive stop isolation (pumpfun excluded). SOL price cache (CoinGecko 5min TTL). Alpha-only toggle + relaxed alpha filters (MC $4K, vol 10 SOL, buy 55%). Stale artifact tagging for PnL analysis. |
| Mar 3 | Quiet Hours Checkpoint: activity-based idle briefing (zero trades 15min → Discord embed with portfolio + strategy + market context). 4h cooldown, persisted to `data/quiet_checkpoint.json`. CoinGecko SOL price fetch on fire. Bug fixes: trade status filter (`completed`/`stopped` not `closed`), `exit_time` field name, falsy-zero best/worst trade. |
| Mar 3 | Optimization audit (5 fixes): sell race guard (`pendingSells` Set in activeTrades.js), DexScreener fetch cache (60s TTL, ~50% API reduction), CoinGecko rate limiter (max 3/cycle + 2h cache TTL), cooldown entry pruning (prune stale entries[] in getEntryCount), stale trade P&L gap fix (lower bound = stop loss, not -5%). |

---

## Roadmap / Next Up

- [x] **Investigate stop loss slippage** — MITIGATED: added fast stop loss (10s Jupiter Price API). Monitor avg loss improvement.
- [x] **Isolate pre vs post vol filter win rates** — DONE Feb 27: pre-filter 20.8% WR / -0.672 SOL, post-filter 46.2% WR / +0.137 SOL. Filter validated.
- [x] **Breakout downtrend bounce detection** — DONE: 2-stage (DexScreener + CoinGecko 14d), stricter DT params (1h +5%, 5m +1.5%, buy 62%, vol 3x, liq $250K, SL -8%)
- [ ] Monitor breakout strategy — does 29 candidates → actual signals?
- [x] **Collect vol filter data** — DONE Feb 27: 13 post-filter trades (6W/7L, 46.2% WR, +0.137 SOL). Filter validated.
- [ ] Collect 48h data under Feb 27 tuning (MC cap $100K, scalp target 30%, hard kill -35%) to measure combined impact
- [ ] Tailscale + Termius for iPhone monitoring access
- [x] **Quiet Hours Checkpoint** — DONE: activity-based idle briefing replaces fixed midnight trigger. Zero trades 15min → portfolio + strategy + market context Discord embed. 4h cooldown.
- [x] Consider persisting BTC alert state to disk — DONE: btc_guard.json
- [x] Integrate Fear & Greed into regime detection — DONE: fetched from alternative.me API, cached 15 min
- [x] **Re-entry protection** — DONE: 2/24h cap (persistent), holder concentration check on momentum re-entry (Helius API, optional via WHALE_TRACKING_ENABLED)
- [x] **Jupiter TopTraded discovery** — DONE: supplemental breakout source via `toptraded/1h`, catches tokens like Pigeon ($5.23M MC, +86.5% 24h) that keywords miss
- [ ] Birdeye Token List V3 API — future scaling option for discovery (broader coverage as bot scales into app)
- [ ] Integrate MCP servers into bot — indicators for breakout confirmation
- [x] **Session validation system** — DONE: `/finalize` skill runs `scripts/validate.js` (syntax + boot test all 23 files) + Claude cascade analysis before updating CLAUDE.md
- [x] **Pump.fun pre-migration strategy** — DONE: PumpPortal WebSocket + bonding curve scalp via Jupiter. Decu0x-inspired filters (MC $6K-$60K, age ≤60min, vol ≥25 SOL). Sell before graduation.
- [ ] Tune pumpfun strategy — diagnostic logging live (Feb 28), collect 48h of `[PUMPFUN] SKIP` data to identify bottleneck filter, then adjust
- [ ] Breakout vol ramp analysis — after 100+ trades with volume_6h/volume_mc_ratio/pair_age_hours, test: vol 1.5-2x sweet spot? older tokens break out better? volume/MC ratio 0.5-3x optimal?
- [ ] Electron app packaging (discussed, not started)
- [ ] Multi-user deployment (3-week horizon)

---

## Session Validation (`/finalize`)

**How to finalize a session:** Type `/finalize` in Claude Code. This triggers:

1. **Automated validation** — `node scripts/validate.js` syntax-checks all 26 files + boot-tests 25 (skips index.js). ~3 seconds, JSON output.
2. **Cascade analysis** — Claude reads modified files, traces imports, verifies all named exports exist in target files.
3. **CLAUDE.md update** — session recap, architecture changes, known issues.
4. **Final re-validation** — one more `node scripts/validate.js` to confirm CLAUDE.md update didn't break anything.

**Files:**
- `scripts/validate.js` — deterministic syntax + boot test, exit code 0 (PASS) or 1 (FAIL)
- `.claude/commands/finalize.md` — slash command skill definition

**Manual validation:** `cd C:\Users\black\astra\solscalp-bot && node scripts/validate.js`

---

## Session Notes / One-Liners

- **Stale artifact trades:** Some trades in `trades.json` have `stale_artifact: true` — exclude these from all PnL/WR analysis. Caused by state transitions (e.g. MC fix producing invalid entry prices). Filter: `trades.filter(t => !t.stale_artifact)`
- Always check `data/cooldowns.json` exists before asking why cooldowns aren't firing
- `node scripts/validate.js` for full project validation; `node --check <file>` for single-file syntax check
- Settings are all env vars with defaults in `config/settings.js` — no hardcoded values
- Paper trading mode: `PAPER_TRADING=true` in `.env`
- Bot runs on port 3000 for dashboard API
- `punycode` deprecation warning on startup is harmless — Node.js v24 issue, ignore it
- trades.json lives at `data/trades.json` — 72 trades as of Feb 25, ~66KB
- Current PnL data was collected during SOL downtrend — baseline WR is likely understated
- To analyze trades: `type data\trades.json` and paste into Claude for full breakdown
- Jupiter API key (free tier, 60 req/min) — required for both swap and price APIs. Generate at portal.jup.ag. Stored as `JUPITER_API_KEY` in `.env`
- `lite-api.jup.ag` is deprecated — all Jupiter calls now go through `api.jup.ag` with `x-api-key` header
- Helius free tier does NOT support JSON-RPC batch requests (returns 403) — use `Promise.all` with parallel single requests instead
- `getTokenLargestAccounts` returns top 20 holders. For concentration %, must also call `getTokenSupply` to get total supply. Top10/Top20 ratio is meaningless.
- `WHALE_TRACKING_ENABLED=true` in .env activates holder check on momentum re-entry (2nd entry only). Default is false.
