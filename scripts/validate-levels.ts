import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeRunner } from '../src/levels/analyze';
import {
  MAX_TIER,
  VALIDATION_RUNS,
  WIN_RATE_TARGET,
  analyzeStationary,
  minimumTier,
} from '../src/modes/stationary/bot';
import { validateLevel } from '../src/levels/validate';

// Validates every level file the way the game does, and checks that a perfect
// player could win. Run with: npm run validate:levels
const dir = join(import.meta.dirname, '..', 'src', 'levels');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();

let failed = false;
const ids = new Set<string>();
/** Position among the shooter levels: the first one is the tutorial and needs no upgrades. */
let shooterOrder = 0;

for (const file of files) {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch (e) {
    console.error(`FAIL ${file}: not valid JSON (${(e as Error).message})`);
    failed = true;
    continue;
  }
  const result = validateLevel(data);
  if (!result.ok) {
    console.error(`FAIL ${file}`);
    for (const err of result.errors) console.error(`  - ${err}`);
    failed = true;
    continue;
  }
  const { level } = result;
  if (ids.has(level.id)) {
    console.error(`FAIL ${file}: duplicate level id "${level.id}"`);
    failed = true;
    continue;
  }
  ids.add(level.id);

  if (level.mode === 'runner') {
    const analysis = analyzeRunner(level);
    if (!analysis.winnable) {
      console.error(`FAIL ${file}: not winnable (${analysis.failure})`);
      failed = true;
      continue;
    }
    console.log(`ok   ${file}  [${level.mode}] best case: ${analysis.bestFinalCount} survivors`);
  } else {
    const order = shooterOrder++;
    const { tier, analysis } = minimumTier(level);
    const pct = (r: number) => `${Math.round(r * 100)}%`;
    if (tier < 0) {
      console.error(
        `FAIL ${file}: the bot wins only ${pct(analysis.winRate)} of ${VALIDATION_RUNS} runs with tier ${MAX_TIER} upgrades (needs ${pct(WIN_RATE_TARGET)})`,
      );
      failed = true;
      continue;
    }
    const base = analyzeStationary(level, VALIDATION_RUNS, 0);
    if (order === 0 && tier > 0) {
      console.error(
        `FAIL ${file}: the first shooter level must be won without upgrades (bot wins ${pct(base.winRate)})`,
      );
      failed = true;
      continue;
    }
    const warn =
      order > 0 && base.winRate > 0
        ? '  WARNING: too easy, should need upgrades (bot wins without any)'
        : '';
    console.log(
      `ok   ${file}  [${level.mode}] needs upgrade tier ${tier} (bot wins ${pct(analysis.winRate)}), ~${Math.round(base.coinsPerRun)} coins per run${warn}`,
    );
  }
}

if (failed) process.exit(1);
console.log(`\n${files.length} level file(s) valid.`);
