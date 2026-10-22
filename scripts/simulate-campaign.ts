import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UPGRADE_KINDS, type UpgradeKind } from '../src/core/shop';
import { HUMAN, SHARP } from '../src/modes/stationary/bot';
import { CAMPAIGN, playCampaign, squadPower } from '../src/modes/stationary/campaign';
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

const seconds = (times: number[]) => times.map((t) => t.toFixed(0)).join(' ');
const median = (values: number[]) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : 0;
const BUYABLE: UpgradeKind[] = UPGRADE_KINDS.filter((k) => k !== 'coins');

console.log(`pilot: ${pilot === HUMAN ? 'human' : 'sharp'}`);
const played = playCampaign(levels.slice(0, onlyLevels), {
  pilot,
  maxRuns,
  onRun: perRun
    ? ({ order, run, result: r, before, after }) => {
        const level = levels[order];
        if (run === 1) {
          console.log(
            `\n${level.name}  (enters with power x${squadPower(before, level).toFixed(2)})`,
          );
        }
        const blocks = level.lane.elements.filter((e) => e.type === 'block').length;
        const result = r.won ? 'WON ' : `${Math.floor(r.progress * 100)}%`.padEnd(4);
        const left =
          (r.blockLeft === null ? '' : `, next ${Math.round(r.blockLeft * 100)}% left`) +
          (r.bossLeft === null ? '' : `, boss ${Math.round(r.bossLeft * 100)}% left`);
        const bought = BUYABLE.filter((k) => after[k] > before[k]);
        const buys = bought.map((k) => `${k}+${after[k] - before[k]}`).join(' ') || 'nothing';
        console.log(
          `  run ${String(run).padStart(2)}  ${result} ${(r.seconds / GAME_SPEED).toFixed(0).padStart(3)}s` +
            `  blocks ${r.blocks}/${blocks} at ${seconds(r.blockTimes) || '-'}s${left}` +
            `  power x${squadPower(before, level).toFixed(2)} -> bought ${buys}`,
        );
      }
    : undefined,
});
for (const p of played) {
  const have = BUYABLE.map((k) => `${k} ${p.upgrades[k]}`).join(', ');
  // how far each run got (a won run also says how long the upgrade lane lasted, see LANE_LASTS):
  // the first few and the last one
  const lane = `won (lane ${Math.round((p.laneShare ?? 0) * 100)}%)`;
  const path = p.reached.map((x) => (x >= 1 ? lane : `${Math.floor(x * 100)}%`));
  const target = CAMPAIGN[p.level.id];
  const goal = target
    ? `   target ${target.runs[0]}-${target.runs[1]}${target.pending ? ' (pending)' : ''}`
    : '   no target';
  const shown = path.length > 6 ? [...path.slice(0, 5), '...', path[path.length - 1]] : path;
  console.log(
    `${p.level.name.padEnd(16)} ${p.won ? `won after ${p.runs} runs` : `NOT won in ${p.runs} runs`} (${p.minutes.toFixed(0)} min)   enters with power x${p.entry.toFixed(2)}   ~${Math.round(p.coinsPerRun)} coins/run, ${p.dry} runs max without a purchase   (${have})${goal}\n${''.padEnd(17)}rewards every ${median(p.gaps).toFixed(0)}s (median), longest wait ${Math.max(0, ...p.gaps).toFixed(0)}s\n${''.padEnd(17)}runs: ${shown.join(' > ')}`,
  );
}
const total = played.reduce((n, p) => n + p.runs, 0);
const longestDry = Math.max(0, ...played.map((p) => p.dry));
console.log(`runs in total: ${total}, longest stretch of runs without a purchase: ${longestDry}`);
