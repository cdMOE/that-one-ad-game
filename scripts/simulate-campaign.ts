import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UPGRADE_KINDS,
  firstClearBonus,
  noUpgrades,
  startSoldiers,
  upgradeCost,
  upgradeMultiplier,
  type UpgradeKind,
  type UpgradeLevels,
} from '../src/core/shop';
import { HUMAN, SHARP, runBot } from '../src/modes/stationary/bot';
import { GAME_SPEED } from '../src/modes/stationary/sim';
import { validateLevel } from '../src/levels/validate';
import type { StationaryLevel } from '../src/levels/schema';

// Plays the shooter levels in order with ONE shared wallet and permanent upgrades, like a player
// working through the campaign: lose, bank the coins, buy the cheapest upgrade, retry. Prints how
// many runs each level took. The sharp bot is better than most people (it snaps to its target and
// reacts fast); `--human` plays with a slower, less precise hand, closer to a person.
// Run with: npm run simulate:campaign -- [maxRunsPerLevel] [--human] [--levels=N] [--runs]
//   --levels=N  only the first N shooter levels
//   --runs      one line per run: when each block broke, how close the next one was, what it bought
const args = process.argv.slice(2);
const maxRuns = Number(args.find((a) => /^\d+$/.test(a)) ?? 400);
const pilot = args.includes('--human') ? HUMAN : SHARP;
const onlyLevels = Number(args.find((a) => a.startsWith('--levels='))?.split('=')[1] ?? Infinity);
const perRun = args.includes('--runs');

const dir = join(import.meta.dirname, '..', 'src', 'levels');
const levels: StationaryLevel[] = [];
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()) {
  const result = validateLevel(JSON.parse(readFileSync(join(dir, file), 'utf8')));
  if (result.ok && result.level.mode === 'stationary') levels.push(result.level);
}

/**
 * Firepower of the squad at the start of a run, relative to a squad without any upgrades: the
 * number the lane and the bosses of the next level have to be measured against.
 */
function power(up: UpgradeLevels, level: StationaryLevel): number {
  const n = level.startCount;
  return (
    upgradeMultiplier('damage', up.damage) *
    upgradeMultiplier('rate', up.rate) *
    ((n + startSoldiers(up.soldiers)) / n)
  );
}

const seconds = (times: number[]) => times.map((t) => t.toFixed(0)).join(' ');
const median = (values: number[]) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : 0;

// coin bonus is left out on purpose: it only speeds a run up and a careful player buys it late
const BUYABLE: UpgradeKind[] = UPGRADE_KINDS.filter((k) => k !== 'coins');
const up = noUpgrades();
let coins = 0;
let seed = 1;
let sinceBuy = 0;
let longestDry = 0;
let total = 0;
console.log(`pilot: ${pilot === HUMAN ? 'human' : 'sharp'}`);
for (const [order, level] of levels.entries()) {
  if (order >= onlyLevels) break;
  const entry = power(up, level);
  const blocks = level.lane.elements.filter((e) => e.type === 'block').length;
  let runs = 0;
  let won = false;
  let earned = 0;
  let dry = 0;
  let minutes = 0;
  const gaps: number[] = [];
  const path: string[] = [];
  if (perRun) console.log(`\n${level.name}  (enters with power x${entry.toFixed(2)})`);
  while (!won && runs < maxRuns) {
    const r = runBot(level, seed++ * 7919, up, { pilot });
    runs++;
    minutes += r.seconds / GAME_SPEED / 60;
    // the rhythm of the rewards: seconds from the start (or the last reward) to the next one
    r.itemTimes.forEach((t, i) => gaps.push(t - (i > 0 ? r.itemTimes[i - 1] : 0)));
    // a won run also says how long the upgrade lane lasted (see LANE_LASTS)
    path.push(
      r.won ? `won (lane ${Math.round(r.laneShare * 100)}%)` : `${Math.floor(r.progress * 100)}%`,
    );
    coins += r.coins;
    earned += r.coins;
    won = r.won;
    if (won) coins += firstClearBonus(order);
    sinceBuy++;
    const before = { ...up };
    // spend: always the cheapest upgrade that is still available
    for (;;) {
      const options = BUYABLE.map((k) => ({ k, cost: upgradeCost(k, up[k]) }))
        .filter((o) => Number.isFinite(o.cost) && o.cost <= coins)
        .sort((a, b) => a.cost - b.cost);
      if (options.length === 0) break;
      coins -= options[0].cost;
      up[options[0].k]++;
    }
    const bought = BUYABLE.filter((k) => up[k] > before[k]);
    // a run that buys nothing (also because everything is maxed out) extends the dry stretch
    if (bought.length > 0) sinceBuy = 0;
    else {
      dry = Math.max(dry, sinceBuy);
      longestDry = Math.max(longestDry, sinceBuy);
    }
    if (perRun) {
      const result = r.won ? 'WON ' : `${Math.floor(r.progress * 100)}%`.padEnd(4);
      const left = r.blockLeft === null ? '' : `, next ${Math.round(r.blockLeft * 100)}% left`;
      const buys = bought.map((k) => `${k}+${up[k] - before[k]}`).join(' ') || 'nothing';
      console.log(
        `  run ${String(runs).padStart(2)}  ${result} ${(r.seconds / GAME_SPEED).toFixed(0).padStart(3)}s` +
          `  blocks ${r.blocks}/${blocks} at ${seconds(r.blockTimes) || '-'}s${left}` +
          `  power x${power(before, level).toFixed(2)} -> bought ${buys}`,
      );
    }
  }
  total += runs;
  const have = BUYABLE.map((k) => `${k} ${up[k]}`).join(', ');
  // how far each run got: the first few and the last one
  const shown = path.length > 6 ? [...path.slice(0, 5), '...', path[path.length - 1]] : path;
  console.log(
    `${level.name.padEnd(16)} ${won ? `won after ${runs} runs` : `NOT won in ${runs} runs`} (${minutes.toFixed(0)} min)   enters with power x${entry.toFixed(2)}   ~${Math.round(earned / runs)} coins/run, ${dry} runs max without a purchase   (${have})\n${''.padEnd(17)}rewards every ${median(gaps).toFixed(0)}s (median), longest wait ${Math.max(0, ...gaps).toFixed(0)}s\n${''.padEnd(17)}runs: ${shown.join(' > ')}`,
  );
}
console.log(`runs in total: ${total}, longest stretch of runs without a purchase: ${longestDry}`);
