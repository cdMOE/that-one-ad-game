import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeRunner } from '../src/levels/analyze';
import { analyzeStationary } from '../src/modes/stationary/bot';
import { validateLevel } from '../src/levels/validate';

// Validates every level file the way the game does, and checks that a perfect
// player could win. Run with: npm run validate:levels
const dir = join(import.meta.dirname, '..', 'src', 'levels');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();

let failed = false;
const ids = new Set<string>();

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
    const analysis = analyzeStationary(level);
    if (analysis.winRate === 0) {
      console.error(`FAIL ${file}: the bot could not win in any run`);
      failed = true;
      continue;
    }
    const warn = analysis.winRate < 0.6 ? '  WARNING: hard, the bot wins less than 60%' : '';
    console.log(
      `ok   ${file}  [${level.mode}] bot wins ${Math.round(analysis.winRate * 100)}%, best ${analysis.bestSurvivors} survivors, lowest squad ${Math.round(analysis.tightness * 100)}% of start${warn}`,
    );
  }
}

if (failed) process.exit(1);
console.log(`\n${files.length} level file(s) valid.`);
