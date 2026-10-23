import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRunner, starsFor } from '../src/levels/analyze';
import type { RunnerLevel, StationaryLevel } from '../src/levels/schema';
import { validateLevel } from '../src/levels/validate';
import { noUpgrades, upgradeCost } from '../src/core/shop';
import {
  MAX_TIER,
  TUTORIAL,
  VALIDATION_RUNS,
  WIN_RATE_TARGET,
  analyzeStationary,
  runBot,
} from '../src/modes/stationary/bot';
import {
  CAMPAIGN,
  CAMPAIGN_SEEDS,
  MAX_DRY,
  NEAR_MISS,
  PROFILES,
  playCampaign,
  spend,
  type ProfileName,
} from '../src/modes/stationary/campaign';

const dir = join(import.meta.dirname, '..', 'src', 'levels');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();

const minimal = {
  id: 't',
  name: 'T',
  mode: 'runner',
  startCount: 5,
  length: 50,
  gates: [],
  enemies: [],
  obstacles: [],
};

function errorsOf(data: unknown): string[] {
  const r = validateLevel(data);
  return r.ok ? [] : r.errors;
}

/** Losing at the start is the cheap, near-certain case, so it needs fewer runs. */
const FIRST_TRY_RUNS = 8;
/** Bot wins needed out of `VALIDATION_RUNS`: the same bar `npm run validate:levels` sets. */
const ENOUGH_WINS = Math.ceil(VALIDATION_RUNS * WIN_RATE_TARGET);
/** Shooter level files in campaign order; the first one is the tutorial. */
const shooterFiles = files.filter(
  (f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).mode === 'stationary',
);
/** Simulating the bot runs of a stationary level takes a while. */
const SLOW_TEST_MS = 60_000;

/**
 * Bot wins out of `runs` (same seeds as `analyzeStationary`), counting only until `enough` are
 * in: a level that clears the bar early does not need the remaining, slowest runs simulated.
 */
function wins(level: StationaryLevel, tier: number, runs: number, enough: number): number {
  let won = 0;
  for (let seed = 1; seed <= runs && won < enough; seed++) {
    if (runBot(level, seed * 7919, tier).won) won++;
  }
  return won;
}

describe('shipped levels', () => {
  it('has at least one level', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)(
    '%s is valid and winnable',
    (file) => {
      const data: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const result = validateLevel(data);
      expect(result.ok ? [] : result.errors).toEqual([]);
      if (result.ok && result.level.mode === 'runner') {
        const analysis = analyzeRunner(result.level);
        expect(analysis.failure).toBeUndefined();
        expect(analysis.winnable).toBe(true);
      }
      if (result.ok && result.level.mode === 'stationary') {
        const level = result.level;
        if (shooterFiles.indexOf(file) === 0) {
          // the tutorial: the first run is lost part of the way in and pays for damage and fire
          // rate, and a handful of runs later the level is won
          const first = analyzeStationary(level, FIRST_TRY_RUNS, 0);
          expect(first.winRate).toBe(0);
          expect(first.medianProgress).toBeGreaterThanOrEqual(TUTORIAL.firstRun[0]);
          expect(first.medianProgress).toBeLessThanOrEqual(TUTORIAL.firstRun[1]);
          expect(first.coinsPerRun).toBeGreaterThanOrEqual(
            upgradeCost('damage', 0) + upgradeCost('rate', 0),
          );
          expect(
            wins(level, TUTORIAL.maxTier, VALIDATION_RUNS, ENOUGH_WINS),
          ).toBeGreaterThanOrEqual(ENOUGH_WINS);
        } else {
          // every later level needs shop upgrades (even the bot, which plays better than a
          // person, never wins it on the first try), yet a lost run pays a third of an upgrade
          const first = analyzeStationary(level, FIRST_TRY_RUNS, 0);
          expect(first.winRate).toBe(0);
          expect(first.coinsPerRun * 3).toBeGreaterThanOrEqual(upgradeCost('damage', 0));
        }
        // and a fully upgraded squad wins it as often as the level validator demands
        expect(wins(level, MAX_TIER, VALIDATION_RUNS, ENOUGH_WINS)).toBeGreaterThanOrEqual(
          ENOUGH_WINS,
        );
      }
    },
    SLOW_TEST_MS,
  );

  it('uses unique ids', () => {
    const ids = files.map(
      (f) => (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { id: string }).id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * The difficulty curve: the shooter levels played in order the way a player does (lose, keep the
 * coins, buy upgrades, retry), for every player profile and every one of `CAMPAIGN_SEEDS`, each
 * level held to its `CAMPAIGN` range of runs for that profile (the median of the seeds). A level `pending` for a profile is still played (the next one
 * starts with what it paid for) but not checked for it: it has not been tuned for that player yet.
 */
describe('campaign', () => {
  const shooterLevels = shooterFiles.map((f) => {
    const result = validateLevel(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    if (!result.ok || result.level.mode !== 'stationary') throw new Error(`bad level ${f}`);
    return result.level;
  });
  // one campaign per seed and profile, played on first use and shared by the checks
  const played = new Map<ProfileName, ReturnType<typeof playCampaign>[]>();
  const campaigns = (profile: ProfileName) => {
    let p = played.get(profile);
    if (!p) {
      p = CAMPAIGN_SEEDS.map((seed) =>
        playCampaign(shooterLevels, { profile: PROFILES[profile], maxRuns: 40, seed }),
      );
      played.set(profile, p);
    }
    return p;
  };
  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

  it('sets a target for every shooter level, and only for those', () => {
    expect(Object.keys(CAMPAIGN).sort()).toEqual(shooterLevels.map((l) => l.id).sort());
  });

  const checks = (Object.keys(PROFILES) as ProfileName[]).flatMap((profile) =>
    shooterLevels.map((level, order) => ({
      profile,
      level,
      order,
      target: CAMPAIGN[level.id],
      range: CAMPAIGN[level.id]?.runs[profile],
    })),
  );
  const pending = (c: (typeof checks)[number]) => c.target?.pending?.includes(c.profile) ?? false;
  it.each(checks.filter((c) => !pending(c)))(
    '$level.name takes the runs it is meant to ($profile)',
    ({ profile, order, range }) => {
      const levels = campaigns(profile).map((c) => c[order]);
      for (const p of levels) {
        expect(p.won).toBe(true);
        // losing keeps paying for upgrades
        expect(p.dry).toBeLessThanOrEqual(MAX_DRY);
      }
      const runs = median(levels.map((p) => p.runs));
      expect(runs).toBeGreaterThanOrEqual(range[0]);
      expect(runs).toBeLessThanOrEqual(range[1]);
      // and no cliff: the win is announced by a run that came close
      const lastLost = levels.filter((p) => p.runs > 1).map((p) => p.reached[p.runs - 2]);
      if (lastLost.length > 0) expect(median(lastLost)).toBeGreaterThanOrEqual(NEAR_MISS);
    },
    SLOW_TEST_MS,
  );
  for (const c of checks.filter(pending)) {
    it.todo(
      `${c.level.name} takes ${c.range[0]}-${c.range[1]} runs (${c.profile}: ${c.target.role})`,
    );
  }
});

/** The two ways the campaign shops, checked against purchases from the user's logged playtest. */
describe('spend', () => {
  it('buys like the user: one of each card per round, soldiers first, then coins, then damage and rate', () => {
    // the first run: two rounds of the coin bonus, one of fire rate and damage
    const first = noUpgrades();
    expect(spend(first, 4957, 'player')).toBe(1057);
    expect(first).toEqual({ damage: 1, rate: 1, soldiers: 0, coins: 2 });
    // the soldiers card as soon as it is affordable
    const up = { damage: 1, rate: 1, soldiers: 0, coins: 2 };
    expect(spend(up, 8123, 'player')).toBe(123);
    expect(up).toEqual({ damage: 1, rate: 1, soldiers: 1, coins: 2 });
    // coin bonus maxed, soldiers out of reach: damage and fire rate by turns
    const later = { damage: 4, rate: 5, soldiers: 3, coins: 5 };
    expect(spend(later, 26859, 'player')).toBe(2605);
    expect(later).toEqual({ damage: 6, rate: 7, soldiers: 3, coins: 5 });
  });

  it('buys the cheapest upgrade and never the coin bonus', () => {
    const up = noUpgrades();
    const left = spend(up, 20000, 'cheapest');
    expect(up.coins).toBe(0);
    expect(up.damage + up.rate).toBeGreaterThan(2);
    expect(left).toBeLessThan(upgradeCost('damage', up.damage));
  });
});

describe('validateLevel', () => {
  it('accepts a minimal level', () => {
    expect(validateLevel(minimal).ok).toBe(true);
  });

  it('rejects non-objects and unknown modes', () => {
    expect(validateLevel(null).ok).toBe(false);
    expect(validateLevel([]).ok).toBe(false);
    expect(errorsOf({ ...minimal, mode: 'nope' })[0]).toContain('mode');
  });

  it('reports typos in keys', () => {
    expect(errorsOf({ ...minimal, enemys: [] }).join()).toContain('enemys');
  });

  it('reports bad gates with a readable path', () => {
    const errs = errorsOf({
      ...minimal,
      gates: [{ at: 10, options: [{ op: 'x3', value: 2 }] }],
    });
    expect(errs.join()).toContain('gates[0].options[0].op');
  });

  it('limits a gate row to 1-3 options', () => {
    const g = { op: '+', value: 1 };
    expect(errorsOf({ ...minimal, gates: [{ at: 10, options: [] }] })).not.toEqual([]);
    expect(errorsOf({ ...minimal, gates: [{ at: 10, options: [g, g, g, g] }] })).not.toEqual([]);
  });

  it('rejects out-of-range numbers', () => {
    expect(errorsOf({ ...minimal, startCount: 0 })).not.toEqual([]);
    expect(errorsOf({ ...minimal, enemies: [{ at: 49.5, count: 3 }] })).not.toEqual([]);
    expect(errorsOf({ ...minimal, enemies: [{ at: 10, count: 3, x: 2 }] })).not.toEqual([]);
    expect(
      errorsOf({ ...minimal, gates: [{ at: 10, options: [{ op: '/', value: 0 }] }] }),
    ).not.toEqual([]);
  });

  it('sorts events by distance', () => {
    const r = validateLevel({
      ...minimal,
      enemies: [
        { at: 30, count: 2 },
        { at: 10, count: 1 },
      ],
    });
    expect(r.ok && r.level.mode === 'runner' ? r.level.enemies.map((e) => e.at) : []).toEqual([
      10, 30,
    ]);
  });
});

describe('analyzeRunner', () => {
  const base = minimal as unknown as RunnerLevel;

  it('picks the best gate every time', () => {
    const level: RunnerLevel = {
      ...base,
      startCount: 5,
      gates: [
        {
          at: 10,
          options: [
            { op: '+', value: 10 },
            { op: 'x', value: 2 },
          ],
        },
      ],
      enemies: [{ at: 20, count: 14 }],
    };
    expect(analyzeRunner(level)).toEqual({ winnable: true, bestFinalCount: 1 });
  });

  it('flags levels the best path cannot win', () => {
    const level: RunnerLevel = { ...base, startCount: 5, boss: { count: 5 } };
    const a = analyzeRunner(level);
    expect(a.winnable).toBe(false);
    expect(a.failure).toContain('boss');
  });
});

describe('starsFor', () => {
  it('rewards keeping more of the best possible crowd', () => {
    expect(starsFor(10, 10)).toBe(3);
    expect(starsFor(8, 10)).toBe(3);
    expect(starsFor(5, 10)).toBe(2);
    expect(starsFor(1, 10)).toBe(1);
  });

  it('gives full stars when the best case is unknown or exceeded', () => {
    expect(starsFor(3, 0)).toBe(3);
    expect(starsFor(30, 10)).toBe(3);
  });
});
