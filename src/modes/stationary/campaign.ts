import {
  UPGRADE_KINDS,
  firstClearBonus,
  levelCoinFactor,
  noUpgrades,
  startSoldiers,
  upgradeCost,
  upgradeMultiplier,
  type UpgradeKind,
  type UpgradeLevels,
} from '../../core/shop';
import type { StationaryLevel } from '../../levels/schema';
import { CASUAL, GOOD, runBot, type BotResult, type Pilot } from './bot';
import { GAME_SPEED } from './sim';

/**
 * How a player buys upgrades between runs:
 * - `cheapest`: always the cheapest upgrade still available, never the coin bonus (it only speeds
 *   the campaign up, and a careful player buys it late).
 * - `player`: what the user did in their playtest (it buys what they bought after 15 of their 17
 *   runs): round after round along the cards, one level of each it can afford per round, the
 *   soldiers card first (an extra soldier is the biggest jump in power), then the coin bonus, then
 *   damage and fire rate, the one behind first.
 */
export type BuyPolicy = 'cheapest' | 'player';

/** A kind of player the campaign is played and checked for: their hand and how they shop. */
export interface Profile {
  pilot: Pilot;
  buy: BuyPolicy;
}

/**
 * The two players the campaign is measured against. `good` is the user (a strong player who knows
 * the game), calibrated against their logged playtest; `casual` plays now and then and should need
 * about twice the runs.
 */
export const PROFILES = {
  good: { pilot: GOOD, buy: 'player' },
  casual: { pilot: CASUAL, buy: 'cheapest' },
} as const satisfies Record<string, Profile>;

export type ProfileName = keyof typeof PROFILES;

/** How many campaign runs a shooter level is meant to take, and what it is there for. */
export interface CampaignTarget {
  /** Runs (lowest and highest) each profile needs, losing and buying its way through. */
  runs: Readonly<Record<ProfileName, readonly [number, number]>>;
  role: string;
  /**
   * Profiles this level has not been tuned for yet: the campaign still plays it, the test skips
   * its check for them.
   */
  pending?: readonly ProfileName[];
}

/**
 * The difficulty curve of the campaign, by level id. It rises in waves, not in a line: a breather
 * after every wall, so a level that just felt hard is followed by one that shows off the upgrades.
 * `good` holds the runs agreed for a strong player; the `casual` ranges are still the ones the
 * levels were built for before the good profile existed (about twice the good ones), until the
 * levels are retuned for both. The unit tests hold every level to its range for every profile that
 * is not `pending`, so a change anywhere (shop, weapons, a level) that shifts the curve fails there
 * instead of in a playtest.
 */
export const CAMPAIGN: Readonly<Record<string, CampaignTarget>> = {
  'stationary-01': {
    runs: { good: [4, 6], casual: [7, 13] },
    role: 'tutorial: wall, horde, boss, a little further each run',
    pending: ['good'],
  },
  'stationary-02': {
    runs: { good: [2, 4], casual: [3, 5] },
    role: 'breather: the upgrades bought show',
  },
  'stationary-03': {
    runs: { good: [6, 8], casual: [9, 12] },
    role: 'the first real wall',
  },
  'stationary-04': {
    runs: { good: [2, 3], casual: [3, 4] },
    role: 'power fantasy: a flood that melts',
    pending: ['good'],
  },
  'stationary-05': {
    runs: { good: [8, 10], casual: [12, 15] },
    role: 'chapter boss',
    pending: ['good'],
  },
};

/**
 * Most runs in a row that may buy nothing: the core loop promises that losing pays for the next
 * upgrade, so a longer dry stretch is a grind, whatever the run count says.
 */
export const MAX_DRY = 2;

/**
 * Firepower of the squad at the start of a run, relative to a squad without any upgrades: the
 * number the lane and the bosses of the next level have to be measured against.
 */
export function squadPower(up: UpgradeLevels, level: StationaryLevel): number {
  const n = level.startCount;
  return (
    upgradeMultiplier('damage', up.damage) *
    upgradeMultiplier('rate', up.rate) *
    ((n + startSoldiers(up.soldiers)) / n)
  );
}

/** One run of the campaign, as it happened. */
export interface CampaignRun {
  /** Position of the level among the shooter levels (0 = first). */
  order: number;
  /** 1 for the first run of the level. */
  run: number;
  result: BotResult;
  /** Upgrades the run was played with, and what they were after its coins were spent. */
  before: UpgradeLevels;
  after: UpgradeLevels;
}

/** How one level of the campaign went. */
export interface LevelCampaign {
  level: StationaryLevel;
  runs: number;
  won: boolean;
  /** `squadPower` on the first run. */
  entry: number;
  /** Coins actually paid per run (the level's payout factor included). */
  coinsPerRun: number;
  /** Longest stretch of runs in a row that bought nothing. */
  dry: number;
  /** Playing time in real minutes. */
  minutes: number;
  /** Seconds from the start (or the last reward) to the next reward on the lane, every run. */
  gaps: number[];
  /** How far each run got (0..1, 1 = won). */
  reached: number[];
  /** Share of the winning run the upgrade lane lasted (see `LANE_LASTS`); null if not won. */
  laneShare: number | null;
  /** Upgrades owned after the level. */
  upgrades: UpgradeLevels;
}

/** Spends the wallet on upgrades the way `policy` says; returns what is left. */
export function spend(up: UpgradeLevels, coins: number, policy: BuyPolicy): number {
  const price = (k: UpgradeKind) => upgradeCost(k, up[k]);
  if (policy === 'cheapest') {
    for (;;) {
      // the coin bonus is left out: it only speeds a run up and a careful player buys it late
      const pick = UPGRADE_KINDS.filter((k) => k !== 'coins' && price(k) <= coins).sort(
        (a, b) => price(a) - price(b),
      )[0];
      if (pick === undefined) return coins;
      coins -= price(pick);
      up[pick]++;
    }
  }
  // round after round along the cards, one level of each it can afford per round
  for (let bought = true; bought;) {
    bought = false;
    // damage and fire rate cost the same at the same level, so the cheaper one is the one behind;
    // level with each other, the user went for fire rate first
    const turn = price('damage') < price('rate') ? 'damage' : 'rate';
    for (const k of ['soldiers', 'coins', turn, turn === 'rate' ? 'damage' : 'rate'] as const) {
      if (price(k) > coins) continue;
      coins -= price(k);
      up[k]++;
      bought = true;
    }
  }
  return coins;
}

/**
 * Plays the shooter levels in order with ONE shared wallet and permanent upgrades, like a player
 * working through the campaign: lose, bank the coins, buy upgrades (see `BuyPolicy`), retry. A
 * level not won within `maxRuns` is left behind and the next one is played with what was bought so
 * far. `npm run simulate:campaign` prints this, and the unit tests check it against `CAMPAIGN`.
 */
export function playCampaign(
  levels: readonly StationaryLevel[],
  {
    profile = PROFILES.casual,
    maxRuns = 400,
    onRun,
  }: { profile?: Profile; maxRuns?: number; onRun?: (run: CampaignRun) => void } = {},
): LevelCampaign[] {
  const { pilot, buy } = profile;
  const up = noUpgrades();
  let coins = 0;
  let seed = 1;
  const out: LevelCampaign[] = [];
  for (const [order, level] of levels.entries()) {
    const entry = squadPower(up, level);
    let runs = 0;
    let won = false;
    let earned = 0;
    let dry = 0;
    let sinceBuy = 0;
    let seconds = 0;
    const gaps: number[] = [];
    const reached: number[] = [];
    let laneShare: number | null = null;
    while (!won && runs < maxRuns) {
      const r = runBot(level, seed++ * 7919, up, { pilot });
      runs++;
      seconds += r.seconds / GAME_SPEED;
      r.itemTimes.forEach((t, i) => gaps.push(t - (i > 0 ? r.itemTimes[i - 1] : 0)));
      reached.push(r.won ? 1 : r.progress);
      // later levels pay more per kill and per block (see LEVEL_COIN_GROWTH), the coin bonus on top
      const paid = r.coins * levelCoinFactor(order) * upgradeMultiplier('coins', up.coins);
      coins += paid;
      earned += paid;
      won = r.won;
      if (won) {
        coins += firstClearBonus(order);
        laneShare = r.laneShare;
      }
      const before = { ...up };
      coins = spend(up, coins, buy);
      // a run that buys nothing (also because everything is maxed out) extends the dry stretch
      if (UPGRADE_KINDS.some((k) => up[k] > before[k])) sinceBuy = 0;
      else dry = Math.max(dry, ++sinceBuy);
      onRun?.({ order, run: runs, result: r, before, after: { ...up } });
    }
    out.push({
      level,
      runs,
      won,
      entry,
      coinsPerRun: earned / runs,
      dry,
      minutes: seconds / 60,
      gaps,
      reached,
      laneShare,
      upgrades: { ...up },
    });
  }
  return out;
}
