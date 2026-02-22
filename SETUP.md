# SolScalp Bot — Setup & Deployment Guide

## Prerequisites
- Node.js 18+ (Railway handles this automatically)
- A Helius API key → https://helius.dev
- A funded Solana wallet (custodial — the bot holds the private key)
- A Railway account → https://railway.app

---

## Step 1 — Get your wallet private key

Your custodial wallet private key can be exported from:
- **Phantom**: Settings → Security & Privacy → Export Private Key
- **Solflare**: Settings → Export Private Key
- Or generate a fresh one with `solana-keygen new`

⚠️ This wallet will be used for automated trading. Fund it with only what you're willing to risk.
⚠️ Never share your private key with anyone else.

---

## Step 2 — Deploy to Railway

1. Go to https://railway.app and create a new project
2. Choose **Deploy from GitHub repo** (push this code to a GitHub repo first)
   — OR — choose **Empty project** and use the Railway CLI:
   ```
   npm install -g @railway/cli
   railway login
   railway init
   railway up
   ```

---

## Step 3 — Set Environment Variables in Railway

In your Railway project → Variables tab, add the following:

### Required
| Variable | Value |
|---|---|
| `HELIUS_API_KEY` | Your Helius API key |
| `WALLET_PRIVATE_KEY` | Your wallet private key (base58 or JSON array) |

### Bot Control
| Variable | Default | Description |
|---|---|---|
| `IS_BOT_ACTIVE` | `true` | Master on/off switch |
| `AUTO_TRADE_ENABLED` | `true` | Actually execute trades |
| `PAPER_TRADING` | `false` | Set to `true` to simulate without real trades |

### Trade Sizing
| Variable | Default | Description |
|---|---|---|
| `DEFAULT_TRADE_AMOUNT_SOL` | `0.1` | Default trade size |
| `MAX_TRADE_SIZE_SOL` | `0.5` | Max trade size |
| `DAILY_LOSS_LIMIT_SOL` | `5` | Bot pauses if daily loss exceeds this |
| `SLIPPAGE_TOLERANCE` | `1.5` | Default slippage % |

### Scalp Strategy
| Variable | Default |
|---|---|
| `SCALP_ENABLED` | `true` |
| `SCALP_ENTRY_MC_MIN` | `280000` |
| `SCALP_ENTRY_MC_MAX` | `420000` |
| `SCALP_EXIT_MC` | `800000` |
| `SCALP_TRADE_AMOUNT_SOL` | `0.1` |
| `SCALP_STOP_LOSS_PERCENT` | `20` |
| `SCALP_PUNCH_CHECK_ENABLED` | `true` |

### Momentum Strategy
| Variable | Default |
|---|---|
| `MOMENTUM_ENABLED` | `true` |
| `MOMENTUM_ENTRY_MC_MIN` | `100000` |
| `MOMENTUM_ENTRY_MC_MAX` | `150000` |
| `MOMENTUM_TRADE_AMOUNT_SOL` | `0.5` |
| `MOMENTUM_STOP_LOSS` | `20` |
| `MOMENTUM_VOLUME_MULT` | `2` |

### Breakout Strategy
| Variable | Default |
|---|---|
| `BREAKOUT_ENABLED` | `true` |
| `BREAKOUT_ENTRY_MC_MIN` | `5000000` |
| `BREAKOUT_ENTRY_MC_MAX` | `20000000` |
| `BREAKOUT_TRADE_AMOUNT_SOL` | `0.2` |
| `BREAKOUT_STOP_LOSS` | `20` |
| `BREAKOUT_TARGET_GAIN` | `30` |
| `BREAKOUT_MIN_5M_PUMP` | `10` |
| `BREAKOUT_MIN_BUY_PRESSURE` | `55` |
| `BREAKOUT_VOLUME_MULT` | `2` |

### Safety
| Variable | Default |
|---|---|
| `RUG_CHECK_ENABLED` | `true` |
| `HONEYPOT_CHECK_ENABLED` | `true` |
| `STOP_LOSS_PERCENT` | `20` |
| `TRAILING_STOP_ENABLED` | `false` |
| `TRAILING_STOP_PERCENT` | `10` |

---

## Step 4 — Start with Paper Trading

**STRONGLY recommended**: Set `PAPER_TRADING=true` first and watch the logs for 24–48 hours. This runs the full strategy logic without spending real SOL.

In Railway → Deployments, click the deployment to see live logs.

Once you're confident the strategies are finding good signals, set `PAPER_TRADING=false`.

---

## File Structure

```
solscalp-bot/
├── index.js                   # Main entry — starts all strategy loops
├── package.json
├── railway.toml
├── config/
│   └── settings.js            # Loads all settings from env vars
├── wallet/
│   └── custodial.js           # Keypair management, tx signing
├── jupiter/
│   └── index.js               # Jupiter API v6 quotes + swaps
├── dexscreener/
│   └── index.js               # Token scanning via DexScreener
├── analysis/
│   └── scoring.js             # Quality score + PUNCH analysis
├── strategies/
│   ├── scalp.js               # Strategy 1: High-volume scalp
│   ├── momentum.js            # Strategy 2: Pump.fun graduation
│   └── breakout.js            # Strategy 3: Volume breakout
├── monitor/
│   └── activeTrades.js        # Exit logic for all active trades
├── store/
│   └── trades.js              # In-memory trade state + JSON persistence
└── utils/
    └── logger.js              # Structured logging
```

---

## Strategy Summary

### 1. High-Volume Scalp
- Scans 250 top-volume Solana tokens every 5 min
- Enters at $280K–$420K MC with quality + optional PUNCH check
- Partial exit: sells 80% at +70%, remaining 20% at +100%
- Stop loss: -20%
- Trade size: 0.1 SOL

### 2. Momentum / Pump.fun Graduation
- Targets tokens at $100K–$150K MC with 2x+ volume spike
- Exits at $250K–$300K MC
- Stop loss: -20%
- Trade size: 0.5 SOL

### 3. Breakout
- Targets $5M–$20M MC tokens with: 2x volume + 10%+ 5m pump + 55%+ buy pressure
- Exits at +30% gain OR sell pressure detected
- Stop loss: -20%
- Trade size: 0.2 SOL

---

## Monitoring

- View live logs in Railway → Deployments → Logs
- Trade history saved to `data/trades.json` in the container
- To check bot status remotely, you can optionally add a simple HTTP health endpoint

---

## ⚠️ Risk Disclaimer

This bot trades with real money on volatile assets. Use only funds you can afford to lose entirely.
Start with `PAPER_TRADING=true`, review signals carefully, and tune settings before going live.
