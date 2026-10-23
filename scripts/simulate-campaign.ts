import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UPGRADE_KINDS } from '../src/core/shop';
import {
  CAMPAIGN,
  CAMPAIGN_SEEDS,
  PROFILES,
  playCampaign,
  squadPower,
  type LevelCampaign,
  type ProfileName,
} from '../src/modes/stationary/campaign';
import { GAME_SPEED } from '../src/modes/stationary/sim';
import { validateLevel } from '../src/levels/validate';
import type { StationaryLevel } from '../src/levels/schema';

// Plays the shooter levels in order with ONE shared wallet and permanent upgrades, like a player
// working through the campaign: lose, bank the coins, buy upgrades, retry. Prints how many runs each
// level took, for each player profile (see PROFILES: `good` is a strong player who knows the game,
// calibrated against a logged playtest, `casual` plays now and then), and at the end a table of
// the median of the CAMPAIGN_SEEDS campaigns against the targets, as the unit tests check it.
// Run with: npm run simulate:campaign -- [maxRunsPerLevel] [--profile=good|casual] [--levels=N] [--runs]
//   --profile=X only this profile (default: both)
//   --levels=N  only the first N shooter levels
//   --runs      one line per run: when each block broke, how close the next one was, what it bought
const args = process.argv.slice(2);
const maxRuns = Number(args.find((a) => /^\d+$/.test(a)) ?? 400);
const only = args.find((a) => a.startsWith('--profile='))?.split('=')[1];
const names = (Object.keys(PROFILES) as ProfileName[]).filter((n) => !only || n === only);
if (names.length === 0) {
  console.error(`unknown profile "${only}", known: ${Object.keys(PROFILES).join(', ')}`);
  process.exit(1);
}
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
const results = new Map<ProfileName, LevelCampaign[]>();
for (const name of names) {
  console.log(`\n=== ${name} (buys: ${PROFILES[name].buy}) ===`);
  const played = playCampaign(levels.slice(0, onlyLevels), {
    profile: PROFILES[name],
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
          const bought = UPGRADE_KINDS.filter((k) => after[k] > before[k]);
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
    const have = UPGRADE_KINDS.map((k) => `${k} ${p.upgrades[k]}`).join(', ');
    // how far each run got (a won run also says how long the upgrade lane lasted, see LANE_LASTS):
    // the first few and the last one
    const lane = `won (lane ${Math.round((p.laneShare ?? 0) * 100)}%)`;
    const path = p.reached.map((x) => (x >= 1 ? lane : `${Math.floor(x * 100)}%`));
    const target = CAMPAIGN[p.level.id];
    const range = target?.runs[name];
    const goal = range
      ? `   target ${range[0]}-${range[1]}${target.pending?.includes(name) ? ' (pending)' : ''}`
      : '   no target';
    const shown = path.length > 6 ? [...path.slice(0, 5), '...', path[path.length - 1]] : path;
    console.log(
      `${p.level.name.padEnd(16)} ${p.won ? `won after ${p.runs} runs` : `NOT won in ${p.runs} runs`} (${p.minutes.toFixed(0)} min)   enters with power x${p.entry.toFixed(2)}   ~${Math.round(p.coinsPerRun)} coins/run, ${p.dry} runs max without a purchase   (${have})${goal}\n${''.padEnd(17)}rewards every ${median(p.gaps).toFixed(0)}s (median), longest wait ${Math.max(0, ...p.gaps).toFixed(0)}s\n${''.padEnd(17)}runs: ${shown.join(' > ')}`,
    );
  }
  const total = played.reduce((n, p) => n + p.runs, 0);
  const longestDry = Math.max(0, ...played.map((p) => p.dry));
  console.log(`runs in total: ${total}, longest stretch of runs without a purchase: ${longestDry}`);
  results.set(name, played);
}

// the profiles side by side, as the unit tests see them: the median of the campaigns played with
// CAMPAIGN_SEEDS (the first one is the campaign above), the spread in brackets, * = outside the
// range
const seeded = new Map<ProfileName, LevelCampaign[][]>();
for (const n of names) {
  seeded.set(n, [
    results.get(n) ?? [],
    ...CAMPAIGN_SEEDS.slice(1).map((seed) =>
      playCampaign(levels.slice(0, onlyLevels), { profile: PROFILES[n], maxRuns, seed }),
    ),
  ]);
}
const runsAt = (n: ProfileName, i: number) =>
  (seeded.get(n) ?? []).map((c) => (c[i].won ? c[i].runs : Infinity));
console.log(
  `\nmedian of ${CAMPAIGN_SEEDS.length} campaigns\n${'level'.padEnd(17)}${names.map((n) => `${n} (spread) target`.padEnd(26)).join('')}${names.length > 1 ? 'ratio' : ''}`,
);
const first = results.get(names[0]) ?? [];
const totals = new Map<ProfileName, number>();
for (const [i, p] of first.entries()) {
  const cells = names.map((n) => {
    const runs = runsAt(n, i);
    const mid = median(runs);
    totals.set(n, (totals.get(n) ?? 0) + mid);
    const range = CAMPAIGN[p.level.id]?.runs[n];
    const off = range && (mid < range[0] || mid > range[1]) ? '*' : ' ';
    const show = (x: number) => (Number.isFinite(x) ? String(x) : 'lost');
    const spread = `(${show(Math.min(...runs))}-${show(Math.max(...runs))})`;
    return `${show(mid)}${off} ${spread} ${range ? `${range[0]}-${range[1]}` : '-'}`.padEnd(26);
  });
  const ratio =
    names.length > 1
      ? `x${(median(runsAt(names[names.length - 1], i)) / median(runsAt(names[0], i))).toFixed(1)}`
      : '';
  console.log(`${p.level.name.padEnd(17)}${cells.join('')}${ratio}`);
}
const total = (n: ProfileName) => totals.get(n) ?? 0;
console.log(
  `${'total'.padEnd(17)}${names.map((n) => String(total(n)).padEnd(26)).join('')}${names.length > 1 ? `x${(total(names[names.length - 1]) / total(names[0])).toFixed(1)}` : ''}`,
);
