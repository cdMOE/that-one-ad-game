import { mulberry32 } from '../../core/rng';
import {
  MAX_TIER,
  startSoldiers,
  tierUpgrades,
  upgradeMultiplier,
  type UpgradeLevels,
} from '../../core/shop';
import type { StationaryLevel } from '../../levels/schema';
import {
  ARENA,
  GAME_SPEED,
  MAX_MONSTERS,
  MONSTERS,
  MONSTER_KIND_BY_INDEX,
  StationarySim,
} from './sim';

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
  /** How far the run got (the progress bar the player sees: 1 = won). */
  progress: number;
  /**
   * Share of the run's time the upgrade lane still had something on it (1 = never ran dry). Low
   * on a won run means the end was played with nothing left to go for.
   */
  laneShare: number;
  /** When each lane block broke, in real seconds (what the player's clock says). */
  blockTimes: number[];
  /** When each power-up was caught, in real seconds: the rhythm of the rewards. */
  itemTimes: number[];
  /**
   * Health left (0..1) of the block the run was working on when it ended, or null when the lane
   * had none left: how close the next reward was.
   */
  blockLeft: number | null;
  /** Health left (0..1) of the boss a lost run did not get past, null if none was on the field. */
  bossLeft: number | null;
}

/**
 * Where the bot wants the squad. Monsters come down in masses, so it stands under the
 * densest column of monsters whenever they are close; otherwise it goes to the upgrade
 * lane to shoot the front block or catch the falling power-up.
 */
/** How the bot plays: how quick and how precise its hand is. */
export interface Pilot {
  /** It re-aims every this many steps (1 = every ~33 ms); higher is slower than a mouse hand. */
  aimEvery: number;
  /** How far into an announced strike it notices it (a person needs a moment as well). */
  reaction: number;
  /** Aiming error in world units, drawn fresh on every re-aim (0 = dead on). */
  wobble: number;
}

/** The validator's bot: quicker and more precise than most people. */
export const SHARP: Pilot = { aimEvery: 1, reaction: 0.25, wobble: 0 };
/**
 * Closer to a person: re-aims five times a second, notices a strike late and is a little off
 * target. The campaign is tuned for how many runs this one needs, not the sharp bot.
 */
export const HUMAN: Pilot = { aimEvery: 6, reaction: 0.45, wobble: 0.5 };

/** Where to stand to be out of every lit-up strike zone, or null when it is not in danger. */
function dodgeTarget(sim: StationarySim, reaction: number): number | null {
  const reach = sim.halfWidth() + 0.3;
  const limit = 6 - sim.halfWidth();
  const zones = sim.attacks.filter((a) => a.t >= reaction);
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

/**
 * Index of the elite closest to the squad, or -1 when none is on the field. One still walking in
 * beyond `spawnTop` does not count yet: chasing it that early leaves the crowd unattended.
 */
function nearestElite(sim: StationarySim): number {
  let best = -1;
  for (let i = 0; i < MAX_MONSTERS; i++) {
    if (!sim.malive[i] || !MONSTERS[MONSTER_KIND_BY_INDEX[sim.mkind[i]]].elite) continue;
    if (sim.my[i] > ARENA.spawnTop) continue;
    if (best < 0 || sim.my[i] < sim.my[best]) best = i;
  }
  return best;
}

function botTarget(sim: StationarySim, pilot: Pilot): number {
  const dodge = dodgeTarget(sim, pilot.reaction);
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
  {
    maxSeconds = 300,
    trace,
    pilot = SHARP,
  }: {
    maxSeconds?: number;
    /** Called after every step (for debugging a run). */
    trace?: (sim: StationarySim) => void;
    pilot?: Pilot;
  } = {},
): BotResult {
  // a plain number is a validator tier; otherwise the exact upgrade levels the player owns
  const up = typeof loadout === 'number' ? tierUpgrades(loadout) : loadout;
  let blocks = 0;
  let laneDry = -1;
  const blockTimes: number[] = [];
  const itemTimes: number[] = [];
  // its own stream, so the aiming error leaves the level's random spawns as they are
  const hand = mulberry32(seed ^ 0x5bd1e995);
  const sim = new StationarySim(
    level,
    mulberry32(seed),
    {
      blockBreak: () => {
        blocks++;
        blockTimes.push(sim.time / GAME_SPEED);
      },
      itemCollected: () => itemTimes.push(sim.time / GAME_SPEED),
    },
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
    if (step % pilot.aimEvery === 0) {
      sim.targetX = botTarget(sim, pilot) + (hand() * 2 - 1) * pilot.wobble;
    }
    sim.update(dt);
    trace?.(sim);
    lowest = Math.min(lowest, sim.count);
    if (laneDry < 0 && sim.lane.elements.length === 0) laneDry = sim.time;
  }
  const front = sim.lane.elements.find((e) => e.type === 'block');
  return {
    won: sim.phase === 'won',
    survivors: sim.phase === 'won' ? sim.count : 0,
    seconds: sim.time,
    lowest,
    coins: sim.coinsRaw,
    blocks,
    progress: sim.progress,
    laneShare: laneDry < 0 ? 1 : laneDry / Math.max(sim.time, 1e-6),
    blockTimes,
    itemTimes,
    blockLeft: front?.type === 'block' ? Math.max(0, front.hp / front.maxHp) : null,
    bossLeft: sim.wallLeft,
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
  /** Median of how far the runs got (1 = won). */
  medianProgress: number;
  /** Median `laneShare` of the won runs (0 when none was won). */
  medianLaneShare: number;
}

function median(values: number[]): number {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
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
  const progress: number[] = [];
  const lane: number[] = [];
  for (let seed = 1; seed <= runs; seed++) {
    const r = runBot(level, seed * 7919, tier);
    coins += r.coins;
    progress.push(r.progress);
    if (r.won) lane.push(r.laneShare);
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
    medianProgress: median(progress),
    medianLaneShare: median(lane),
  };
}

export { MAX_TIER };

/**
 * The one bar every stationary level is measured against, by `npm run validate:levels` and by
 * the unit tests alike: a level "can be won" at a tier when the bot wins this share of
 * `VALIDATION_RUNS` runs there.
 */
export const WIN_RATE_TARGET = 0.6;
/** Bot runs per tier. Five runs said little about a level the bot wins half the time. */
export const VALIDATION_RUNS = 20;

/**
 * The first shooter level teaches the loop of the game: lose, keep the coins, buy upgrades, get
 * further, win. Without upgrades the bot loses every run somewhere in `firstRun` (share of the
 * level, median), at the wall on the upgrade lane, and it wins the level by `maxTier`. Played as a
 * campaign (lose, buy the cheapest upgrade, retry) it takes `runs` runs: past the wall, then the
 * horde, then the boss, every run a little further. The unit tests also check that the first run
 * pays for the first damage and fire-rate upgrade, so the second run is visibly stronger.
 */
export const TUTORIAL = { firstRun: [0.25, 0.5], maxTier: 3, runs: [7, 13] } as const;

/**
 * At the tier a level is first won, the upgrade lane must still have something on it for this
 * share of the run (median of the won runs). Otherwise the run that finally wins ends with
 * nothing left to go for, which feels like watching instead of playing.
 */
export const LANE_LASTS = 0.85;

/**
 * Lowest uniform upgrade tier at which the bot reaches `WIN_RATE_TARGET`, or -1 if even the
 * maximum tier is not enough. This is the "how far into the shop do I have to be" number.
 * The win rate grows with the tier, so the tiers are bisected instead of tried one by one.
 */
export function minimumTier(
  level: StationaryLevel,
  runs = VALIDATION_RUNS,
): { tier: number; analysis: StationaryAnalysis } {
  const top = analyzeStationary(level, runs, MAX_TIER);
  if (top.winRate < WIN_RATE_TARGET) return { tier: -1, analysis: top };
  let lo = 0;
  let hi = MAX_TIER;
  let best = top;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const a = analyzeStationary(level, runs, mid);
    if (a.winRate >= WIN_RATE_TARGET) {
      hi = mid;
      best = a;
    } else {
      lo = mid + 1;
    }
  }
  return { tier: hi, analysis: best };
}
