You are running the /deepdive workflow for the ASTRA trading bot. The user wants a comprehensive analysis of a Solana token.

**Input:** The user provides a token mint address (e.g., `8GC4kBVgREoeQcZJAr1prxtfqW67RSu411aCqeaCpump`) or a token symbol to look up.

---

## Research Steps — Run in Parallel

Launch 3 subagents in parallel using the Task tool:

### Agent 1: DexScreener + Pump.fun Data
Fetch and analyze:
- `https://api.dexscreener.com/tokens/v1/solana/{TOKEN_ADDRESS}` — price, MC, FDV, volume (5m/1h/6h/24h), price changes, liquidity, buy/sell counts, pair age, socials, boosts
- `https://frontend-api-v3.pump.fun/coins/{TOKEN_ADDRESS}` — pump.fun specific data (if applicable), reply count, creator, description
- Calculate: volume/MC ratio, volume/liquidity ratio, buy/sell pressure across timeframes
- Note any socials (Twitter, Telegram, website, Discord)

### Agent 2: Holder Analysis + Risk
Fetch and analyze:
- `https://solscan.io/token/{TOKEN_ADDRESS}` — top holders, total holder count
- `https://api.solscan.io/v2/token/holders?token={TOKEN_ADDRESS}&page=1&page_size=20` — top 20 holders with amounts
- `https://api.rugcheck.xyz/v1/tokens/{TOKEN_ADDRESS}/report/summary` — risk score, mint/freeze authority, insider networks, LP lock status
- Calculate: top 5/10/20 holder concentration %
- Check if creator wallet still holds tokens
- Flag any wallets holding >5%

### Agent 3: Smart Money + Socials
Fetch and analyze:
- `https://gmgn.ai/sol/token/{TOKEN_ADDRESS}` — smart money wallets, top traders (note: may 403, report if so)
- `https://birdeye.so/token/{TOKEN_ADDRESS}?chain=solana` — additional market data (note: may 403)
- Any Twitter/X links found — check account age, follower count, engagement
- Check if token was launched via bundler tools (Uxento, etc.)
- Search for the token name/symbol on web for any news or context

---

## Output Format

After all 3 agents complete, compile a unified report:

### 1. Overview Table
Token name, symbol, MC, ATH MC, age, DEX, 24h volume, liquidity, holders, price change (1h/6h/24h)

### 2. Holder Distribution Table
Top 1/5/10/20 concentration %. Flag any whales >5%. Note creator balance.

### 3. Buy/Sell Activity Table
5m/1h/6h/24h buys, sells, ratio

### 4. Risk Assessment
RugCheck score, mint/freeze authority, LP lock, insider networks, bundler launch detection

### 5. Social Presence
Website, Twitter, Telegram, Discord, DexScreener boosts, pump.fun replies

### 6. Smart Money (if available)
GMGN data on whale wallets, whether known profitable wallets are involved

### 7. Trading Assessment
- Would ASTRA's filters have caught this token? Which strategy, at what MC?
- Liquidity depth — can we enter/exit 0.1 SOL cleanly?
- Key risks (thin liquidity, whale concentration, bundler launch, no socials, etc.)
- Bull/bear case for the trade

Keep the report concise and data-driven. No fluff. Highlight actionable signals.
