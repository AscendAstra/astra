import { readFileSync, writeFileSync } from 'fs';
const trades = JSON.parse(readFileSync('data/trades.json', 'utf8'));

let tagged = 0;
for (const t of trades) {
  if (t.stale_artifact === true) continue;
  if (t.strategy !== 'pumpfun') continue;
  if (t.status !== 'completed' && t.status !== 'stopped') continue;

  // Tag pumpfun trades with absurd PnL (bogus per-trade price bug + race condition duplicates)
  if (Math.abs(t.pnl_percent) > 200) {
    t.stale_artifact = true;
    t.stale_reason = 'Bogus PnL from per-trade solAmount/tokenAmount price spike or race condition duplicate.';
    tagged++;
    console.log('Tagged artifact:', t.token_symbol, `${t.pnl_percent.toFixed(1)}%`, t.status, t.exit_reason);
  } else {
    console.log('REAL pumpfun:', t.token_symbol, `${t.pnl_percent.toFixed(1)}%`, t.status, t.exit_reason);
  }
}

writeFileSync('data/trades.json', JSON.stringify(trades, null, 2));
console.log(`\nTagged ${tagged} more artifacts`);
