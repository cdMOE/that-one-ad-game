import { mulberry32 } from '../../core/rng';
import {
  MAX_TIER,
  startSoldiers,
  tierUpgrades,
  upgradeMultiplier,
  type UpgradeLevels,
} from '../../core/shop';
import type { StationaryLevel } from '../../levels/schema';
import { MAX_MONSTERS, MONSTERS, MONSTER_KIND_BY_INDEX, StationarySim } from './sim';

export interface BotResult {
  won: boolean;
  survivors: number;
  seconds: number;
  /** Lowest squad size seen during the run (how close it came to losing). */
  lowest: number;
  /** Coins earned (before the coin-bonus upgrade). */
  coins: number;
  /** Lane blocks smashed before the run ended. */
  blocks: number;
}

/**
 * Where the bot wants the squad. Monsters come down in masses, so it stands under the
 * densest column of monsters whenever they are close; otherwise it goes to the upgrade
 * lane to shoot the front block or catch the falling power-up.
 */
/** The bot re-aims every this many steps (1 = every ~33 ms); higher is slower than a mouse hand. */
const AIM_EVERY = 1;

/** How far into an announced strike the bot notices it (a person needs a moment as well). */
const REACTION = 0.25;

/** Where to stand to be out of every lit-up strike zone, or null when it is not in danger. */
function dodgeTarget(sim: StationarySim): number | null {
  const reach = sim.halfWidth() + 0.3;
  const limit = 6 - sim.halfWidth();
  const zones = sim.attacks.filter((a) => a.t >= REACTION);
  const blocked = (x: number) => zones.some((a) => x + reach >= a.lo && x - reach <= a.hi);
  if (!blocked(sim.squadX)) return null;
  // the nearest spot just beside a zone edge that no other zone covers
  const options = zones
    .flatMap((a) => [a.lo - reach - 0.05, a.hi + reach + 0.05])
    .filter((x) => x >= -limit && x <= limit && !blocked(x));
  if (options.length === 0) return null;
  return options.reduce((best, x) =>
    Math.abs(x - sim.squadX) < Math.abs(best - sim.squadX) ? x : best,
  );
}

/** Index of the elite closest to the squad, or -1 when none is on the field. */
function nearestElite(sim: StationarySim): number {
  let best = -1;
  for (let i = 0; i < MAX_MONSTERS; i++) {
    if (!sim.malive[i] || !MONSTERS[MONSTER_KIND_BY_INDEX[sim.mkind[i]]].elite) continue;
    if (best < 0 || sim.my[i] < sim.my[best]) best = i;
  }
  return best;
}

function botTarget(sim: StationarySim): number {
  const dodge = dodgeTarget(sim);
  if (dodge !== null) return dodge;
  const reach = sim.halfWidth() + 0.5;
  let nearestY = Infinity;
  let danger = 0;
  for (let i = 0; i < MAX_MONSTERS; i++) {
    if (!sim.malive[i]) continue;
    if (sim.my[i] < nearestY) nearestY = sim.my[i];
    if (sim.my[i] < 7) danger++;
  }
  // densest column: try a few positions across the monster lane, closer monsters count more
  let bestX = (sim.monsterMinX + sim.monsterMaxX) / 2;
  let bestScore = 0;
  for (let cx = sim.monsterMinX; cx <= sim.monsterMaxX + 0.01; cx += 0.7) {
    let score = 0;
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (sim.malive[i] && Math.abs(sim.mx[i] - cx) <= reach && sim.my[i] < 13) {
        score += 1 / (sim.my[i] + 1);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestX = cx;
    }
  }
  const front = sim.lane.elements[0];
  if (front?.type === 'item' && nearestY > 2.5) return sim.lane.x;
  if (!front || danger >= 3 || nearestY < 3) return bestX;
  // quiet moment: a boss standing in the field is worth more than the next block
  const elite = nearestElite(sim);
  return elite >= 0 ? sim.mx[elite] : sim.lane.x;
}

/**
 * A simple but sensible player: it keeps the squad under whatever is most urgent (close
 * monsters, falling power-ups, the front block). Used by `npm run validate:levels` to check
 * that a level can be won.
 */
export function runBot(
  level: StationaryLevel,
  seed: number,
  loadout: number | UpgradeLevels = 0,
  maxSeconds = 300,
  /** Called after every step (for debugging a run). */
  trace?: (sim: StationarySim) => void,
): BotResult {
  // a plain number is a validator tier; otherwise the exact upgrade levels the player owns
  const up = typeof loadout === 'number' ? tierUpgrades(loadout) : loadout;
  let blocks = 0;
  const sim = new StationarySim(
    level,
    mulberry32(seed),
    { blockBreak: () => blocks++ },
    {
      damageMul: upgradeMultiplier('damage', up.damage),
      rateMul: upgradeMultiplier('rate', up.rate),
      startBonus: startSoldiers(up.soldiers),
    },
  );
  // like a mouse the squad sits exactly on the target; the human part is how often it re-aims
  sim.snapSquad = true;
  const dt = 1 / 30;
  const steps = Math.ceil(maxSeconds / dt);
  let lowest = sim.count;
  for (let step = 0; step < steps; step++) {
    if (sim.phase === 'won' || sim.phase === 'lost') break;
    if (step % AIM_EVERY === 0) sim.targetX = botTarget(sim);
    sim.update(dt);
    trace?.(sim);
    lowest = Math.min(lowest, sim.count);
  }
  return {
    won: sim.phase === 'won',
    survivors: sim.phase === 'won' ? sim.count : 0,
    seconds: sim.time,
    lowest,
    coins: sim.coinsRaw,
    blocks,
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

export function analyzeStationary(
  level: StationaryLevel,
  runs = 5,
  tier: number | UpgradeLevels = 0,
): StationaryAnalysis {
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

export { MAX_TIER };

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
