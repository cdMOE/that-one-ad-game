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
import { HUMAN, runBot, type BotResult, type Pilot } from './bot';
import { GAME_SPEED } from './sim';

/** How many campaign runs a shooter level is meant to take, and what it is there for. */
export interface CampaignTarget {
  /** Runs (lowest and highest) the `HUMAN` pilot needs, losing and buying its way through. */
  runs: readonly [number, number];
  role: string;
  /** Not rebuilt for its target yet: the campaign still plays it, the test skips its check. */
  pending?: boolean;
}

/**
 * The difficulty curve of the campaign, by level id. It rises in waves, not in a line: a breather
 * after every wall, so a level that just felt hard is followed by one that shows off the upgrades.
 * The counts are for the `HUMAN` pilot; people need about half (3-5 runs where it needs 8 on the
 * first level). The unit tests hold every level that is not `pending` to its range, so a change
 * anywhere (shop, weapons, a level) that shifts the curve fails there instead of in a playtest.
 */
export const CAMPAIGN: Readonly<Record<string, CampaignTarget>> = {
  'stationary-01': {
    runs: [7, 13],
    role: 'tutorial: wall, horde, boss, a little further each run',
  },
  'stationary-02': { runs: [3, 5], role: 'breather: the upgrades bought show' },
  'stationary-03': { runs: [9, 12], role: 'the first real wall' },
  'stationary-04': { runs: [3, 4], role: 'power fantasy: a flood that melts' },
  'stationary-05': { runs: [12, 15], role: 'chapter boss' },
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

// the coin bonus is left out on purpose: it only speeds a run up and a careful player buys it late
const BUYABLE: UpgradeKind[] = UPGRADE_KINDS.filter((k) => k !== 'coins');

/**
 * Plays the shooter levels in order with ONE shared wallet and permanent upgrades, like a player
 * working through the campaign: lose, bank the coins, buy the cheapest upgrade, retry. A level not
 * won within `maxRuns` is left behind and the next one is played with what was bought so far.
 * `npm run simulate:campaign` prints this, and the unit tests check it against `CAMPAIGN`.
 */
export function playCampaign(
  levels: readonly StationaryLevel[],
  {
    pilot = HUMAN,
    maxRuns = 400,
    onRun,
  }: { pilot?: Pilot; maxRuns?: number; onRun?: (run: CampaignRun) => void } = {},
): LevelCampaign[] {
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
      // later levels pay more per kill and per block (see LEVEL_COIN_GROWTH)
      const paid = r.coins * levelCoinFactor(order);
      coins += paid;
      earned += paid;
      won = r.won;
      if (won) {
        coins += firstClearBonus(order);
        laneShare = r.laneShare;
      }
      const before = { ...up };
      // spend: always the cheapest upgrade that is still available
      for (;;) {
        const options = BUYABLE.map((k) => ({ k, cost: upgradeCost(k, up[k]) }))
          .filter((o) => Number.isFinite(o.cost) && o.cost <= coins)
          .sort((a, b) => a.cost - b.cost);
        if (options.length === 0) break;
        coins -= options[0].cost;
        up[options[0].k]++;
      }
      // a run that buys nothing (also because everything is maxed out) extends the dry stretch
      if (BUYABLE.some((k) => up[k] > before[k])) sinceBuy = 0;
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
