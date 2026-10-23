import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { levelCoinFactor, upgradeMultiplier } from '../src/core/shop';
import { validateLevel } from '../src/levels/validate';
import type { StationaryLevel } from '../src/levels/schema';
import { PILOTS, runBot, type Pilot } from '../src/modes/stationary/bot';
import type { LogItem, RunEntry } from '../src/modes/stationary/runlog';
import type { RunTrace, StationarySim } from '../src/modes/stationary/sim';

// Lays a playtest next to the bot: every run in a run log (`?debug` -> EXPORT RUN LOG) is replayed
// by the bot with exactly the upgrades the player had, over several seeds. Where the player won,
// the bot should win most seeds; where the player lost, it should get about as far. This is how a
// pilot is calibrated against real players.
// Run with: npm run compare:runlog -- <runlog.json> [--pilot=good,casual] [--seeds=10]
//   --pilot   pilots to compare (names from PILOTS in bot.ts), default: good
//   --seeds   bot runs per logged run
//   --level   only the runs of this level (its id, e.g. stationary-05)
//   --all     every run in the log; by default only the runs after its last progress reset, as a
//             reset starts a new playthrough (a log can hold several)
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error(
    'usage: npm run compare:runlog -- <runlog.json> [--pilot=good,casual] [--seeds=10]',
  );
  process.exit(1);
}
const option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const seeds = Number(option('seeds') ?? 10);
const names = (option('pilot') ?? 'good').split(',');
for (const n of names) {
  if (!PILOTS[n]) {
    console.error(`unknown pilot "${n}", known: ${Object.keys(PILOTS).join(', ')}`);
    process.exit(1);
  }
}

const dir = join(import.meta.dirname, '..', 'src', 'levels');
const levels = new Map<string, StationaryLevel>();
for (const f of readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()) {
  const result = validateLevel(JSON.parse(readFileSync(join(dir, f), 'utf8')));
  if (result.ok && result.level.mode === 'stationary') levels.set(result.level.id, result.level);
}
// position among the shooter levels, for the level's payout factor
const order = new Map([...levels.keys()].map((id, i) => [id, i]));

const full = JSON.parse(readFileSync(file, 'utf8')) as LogItem[];
let lastReset = -1;
if (!args.includes('--all')) full.forEach((e, i) => 'reset' in e && (lastReset = i));
const log = full.slice(lastReset + 1);
// a run left from the pause screen says nothing about how far it would have got
const only = option('level');
const runs = log.filter(
  (e): e is RunEntry =>
    !('reset' in e) && e.result !== 'left' && (only === undefined || e.level === only),
);

const median = (values: number[]) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : NaN;
const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);
const bossOf = (trace: RunTrace) => trace.elites.find((e) => e.kind === 'boss');

/** What the bot makes of one logged run, over `seeds` seeds. */
function replay(entry: RunEntry, level: StationaryLevel, pilot: Pilot) {
  let wins = 0;
  const reached: number[] = [];
  const lost: number[] = [];
  const atBoss: number[] = [];
  const coins: number[] = [];
  // what the game pays for the run: the coin upgrade and the level's payout factor on top
  const pay =
    upgradeMultiplier('coins', entry.upgrades.coins) * levelCoinFactor(order.get(level.id) ?? 0);
  for (let s = 1; s <= seeds; s++) {
    let sim: StationarySim | null = null;
    const r = runBot(level, s * 7919, entry.upgrades, { pilot, trace: (x) => (sim = x) });
    if (r.won) wins++;
    reached.push(r.won ? 1 : r.progress);
    coins.push(Math.floor(r.coins * pay));
    const trace = (sim as StationarySim | null)?.trace;
    if (!trace) continue;
    lost.push(trace.bitten + trace.struck);
    const boss = bossOf(trace);
    if (boss) atBoss.push(boss.count);
  }
  return {
    wins,
    reached: median(reached),
    lost: median(lost),
    atBoss: median(atBoss),
    coins: median(coins),
  };
}

console.log(
  `each logged run replayed ${seeds}x with its upgrades (bot columns are medians). lost = soldiers bitten + struck, boss = squad when the boss arrived, coins = paid for the run (k)`,
);
const COL = 40;
const head = names.map((n) => `| ${n}: wins reached lost boss coins`.padEnd(COL)).join('');
console.log(`level try  you: result reached lost boss coins  ${head}`);
const score = Object.fromEntries(
  names.map((n) => [n, { match: 0, gap: [] as number[], coins: [] as number[] }]),
);
const k = (coins: number) => `${(coins / 1000).toFixed(1)}`.padStart(5);
for (const entry of runs) {
  const level = levels.get(entry.level);
  if (!level) continue;
  const boss = bossOf(entry.trace);
  let line =
    `${entry.level.slice(-2).padEnd(5)} ${String(entry.attempt).padStart(3)}  ` +
    `${entry.result.padEnd(4)}  ${pct(entry.reached)}  ${String(entry.trace.bitten + entry.trace.struck).padStart(4)}  ${boss ? String(boss.count).padStart(4) : '   -'} ${k(entry.earned)}  `;
  for (const n of names) {
    const r = replay(entry, level, PILOTS[n]);
    // a won run matches when the bot wins most seeds, a lost one when it loses most
    const won = r.wins * 2 > seeds;
    if (won === (entry.result === 'won')) score[n].match++;
    if (entry.result === 'lost') score[n].gap.push(r.reached - entry.reached);
    score[n].coins.push(r.coins / Math.max(1, entry.earned));
    line +=
      `| ${String(r.wins).padStart(2)}/${seeds} ${pct(r.reached)}  ${String(r.lost).padStart(4)}  ${Number.isNaN(r.atBoss) ? '   -' : String(r.atBoss).padStart(4)} ${k(r.coins)}`.padEnd(
        COL,
      );
  }
  console.log(line);
}
for (const n of names) {
  const gap = score[n].gap;
  const mean = gap.reduce((a, b) => a + b, 0) / Math.max(1, gap.length);
  console.log(
    `${n}: outcome matches ${score[n].match}/${runs.length} runs, on lost runs it gets ${mean >= 0 ? '+' : ''}${Math.round(mean * 100)}% further than you (mean), earns x${median(score[n].coins).toFixed(2)} your coins (median)`,
  );
}
