import { mulberry32 } from '../../core/rng';
import { tierUpgrades, upgradeMultiplier } from '../../core/shop';
import type { StationaryLevel } from '../../levels/schema';
import { MAX_MONSTERS, StationarySim } from './sim';

export interface BotResult {
  won: boolean;
  survivors: number;
  seconds: number;
  /** Lowest squad size seen during the run (how close it came to losing). */
  lowest: number;
  /** Coins earned (before the coin-bonus upgrade). */
  coins: number;
}

/**
 * Where the bot wants the squad: under a monster that is about to reach it; otherwise
 * under a falling power-up; otherwise under the block; otherwise under the nearest monster.
 */
function botTarget(sim: StationarySim): number {
  let nearest = -1;
  let nearestY = Infinity;
  for (let i = 0; i < MAX_MONSTERS; i++) {
    if (sim.malive[i] && sim.my[i] < nearestY) {
      nearestY = sim.my[i];
      nearest = i;
    }
  }
  const block = sim.obstacles.find((o) => o.alive);
  const item = sim.items[0];
  if (nearest >= 0 && nearestY < 7) return sim.mx[nearest];
  if (item) return item.x;
  if (block && (nearest < 0 || nearestY > 10)) return block.x;
  if (nearest >= 0) return sim.mx[nearest];
  return 0;
}

/**
 * A simple but sensible player: it keeps the squad under whatever is most urgent (close
 * monsters, falling power-ups, the block). Used by `npm run validate:levels` to check
 * that a level can be won.
 */
export function runBot(
  level: StationaryLevel,
  seed: number,
  tier = 0,
  maxSeconds = 300,
): BotResult {
  const up = tierUpgrades(tier);
  const sim = new StationarySim(
    level,
    mulberry32(seed),
    {},
    {
      damageMul: upgradeMultiplier('damage', up.damage),
      rateMul: upgradeMultiplier('rate', up.rate),
    },
  );
  const dt = 1 / 30;
  const steps = Math.ceil(maxSeconds / dt);
  let lowest = sim.count;
  for (let step = 0; step < steps; step++) {
    if (sim.phase === 'won' || sim.phase === 'lost') break;
    sim.targetX = botTarget(sim);
    sim.update(dt);
    lowest = Math.min(lowest, sim.count);
  }
  return {
    won: sim.phase === 'won',
    survivors: sim.phase === 'won' ? sim.count : 0,
    seconds: sim.time,
    lowest,
    coins: sim.coinsRaw,
  };
}

export interface StationaryAnalysis {
  /** Fraction of bot runs (different random spawn positions) that were won. */
  winRate: number;
  /** Most survivors in a won run (0 if none). */
  bestSurvivors: number;
  /** Lowest squad size reached in any won run, as a fraction of the starting squad. */
  tightness: number;
  /** Average coins per run (won or lost), before the coin-bonus upgrade. */
  coinsPerRun: number;
}

export function analyzeStationary(level: StationaryLevel, runs = 5, tier = 0): StationaryAnalysis {
  let wins = 0;
  let coins = 0;
  let best = 0;
  let tight = Infinity;
  for (let seed = 1; seed <= runs; seed++) {
    const r = runBot(level, seed * 7919, tier);
    coins += r.coins;
    if (r.won) {
      wins++;
      best = Math.max(best, r.survivors);
      tight = Math.min(tight, r.lowest);
    }
  }
  return {
    winRate: wins / runs,
    bestSurvivors: best,
    tightness: wins > 0 ? tight / level.startCount : 0,
    coinsPerRun: coins / runs,
  };
}

export const MAX_TIER = 16;

/**
 * Lowest uniform damage+fire-rate upgrade tier at which the bot wins at least 60% of its
 * runs, or -1 if even the maximum tier is not enough. Levels are meant to need upgrades,
 * so this is the "how far into the shop do I have to be" number.
 */
export function minimumTier(
  level: StationaryLevel,
  runs = 5,
): { tier: number; analysis: StationaryAnalysis } {
  let last = analyzeStationary(level, runs, 0);
  for (let tier = 0; tier <= MAX_TIER; tier++) {
    last = analyzeStationary(level, runs, tier);
    if (last.winRate >= 0.6) return { tier, analysis: last };
  }
  return { tier: -1, analysis: last };
}
