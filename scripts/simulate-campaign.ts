import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UPGRADE_KINDS,
  firstClearBonus,
  noUpgrades,
  upgradeCost,
  type UpgradeKind,
} from '../src/core/shop';
import { runBot } from '../src/modes/stationary/bot';
import { validateLevel } from '../src/levels/validate';
import type { StationaryLevel } from '../src/levels/schema';

// Plays the shooter levels in order with ONE shared wallet and permanent upgrades, like a player
// working through the campaign: lose, bank the coins, buy the cheapest upgrade, retry. Prints how
// many runs each level took. The bot is better than most people, so a person needs fewer runs.
// Run with: npm run simulate:campaign [maxRunsPerLevel]
const maxRuns = Number(process.argv[2] ?? 400);
const dir = join(import.meta.dirname, '..', 'src', 'levels');
const levels: StationaryLevel[] = [];
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()) {
  const result = validateLevel(JSON.parse(readFileSync(join(dir, file), 'utf8')));
  if (result.ok && result.level.mode === 'stationary') levels.push(result.level);
}

// coin bonus is left out on purpose: it only speeds a run up and a careful player buys it late
const BUYABLE: UpgradeKind[] = UPGRADE_KINDS.filter((k) => k !== 'coins');
const up = noUpgrades();
let coins = 0;
let seed = 1;
let sinceBuy = 0;
let longestDry = 0;
for (const [order, level] of levels.entries()) {
  let runs = 0;
  let won = false;
  let earned = 0;
  let dry = 0;
  while (!won && runs < maxRuns) {
    const r = runBot(level, seed++ * 7919, up);
    runs++;
    coins += r.coins;
    earned += r.coins;
    won = r.won;
    if (won) coins += firstClearBonus(order);
    sinceBuy++;
    // spend: always the cheapest upgrade that is still available
    for (;;) {
      const options = BUYABLE.map((k) => ({ k, cost: upgradeCost(k, up[k]) }))
        .filter((o) => Number.isFinite(o.cost) && o.cost <= coins)
        .sort((a, b) => a.cost - b.cost);
      if (options.length === 0) break;
      coins -= options[0].cost;
      up[options[0].k]++;
      longestDry = Math.max(longestDry, sinceBuy);
      dry = Math.max(dry, sinceBuy);
      sinceBuy = 0;
    }
  }
  const have = BUYABLE.map((k) => `${k} ${up[k]}`).join(', ');
  console.log(
    `${level.name.padEnd(16)} ${won ? `won after ${runs} runs` : `NOT won in ${runs} runs`}   ~${Math.round(earned / runs)} coins/run, ${dry} runs max without a purchase   (${have})`,
  );
}
console.log(`longest stretch of runs without a purchase: ${longestDry}`);
