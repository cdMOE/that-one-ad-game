/**
 * Permanent upgrades bought with coins. Pure data and math, so the game, the level
 * validator and the tests all agree on prices and effects.
 */

/**
 * Coins are inflated on purpose: every payout and every price is this many times bigger than
 * the "base" numbers, so a run feels like a shower of gold while buying power stays the same.
 */
export const COIN_SCALE = 20;

/** Share of the coin payout a level pays once it has been beaten. */
export const REPLAY_PAYOUT = 0.5;

/**
 * One-off coins for beating a level for the first time. `order` is the position of the level among
 * the shooter levels (0 = first). The bonus grows with the level so income keeps up with prices.
 */
export function firstClearBonus(order: number): number {
  return Math.round(150 * COIN_SCALE * Math.pow(1.5, Math.max(0, order)));
}

/**
 * Every shooter level pays this many times more per kill and per block than the one before. Prices
 * climb with every purchase (`costGrowth`), so with a flat payout the later levels would turn into
 * a grind of runs that buy nothing; this keeps every run good for at least one upgrade, also for a
 * player who never buys the coin bonus (at a quarter more per level, the casual campaign profile
 * bought something only every other run on the last levels).
 */
export const LEVEL_COIN_GROWTH = 1.4;

/** Payout factor of the shooter level at position `order` (0 = first). */
export function levelCoinFactor(order: number): number {
  return Math.pow(LEVEL_COIN_GROWTH, Math.max(0, order));
}

export const UPGRADE_KINDS = ['damage', 'rate', 'soldiers', 'coins'] as const;
export type UpgradeKind = (typeof UPGRADE_KINDS)[number];

export type UpgradeLevels = Record<UpgradeKind, number>;

/**
 * Every permanent upgrade has a cap, so the strongest possible squad is a known quantity.
 *
 * Prices are the dial for how long the campaign takes: `npm run simulate:campaign` shows the
 * runs per level. Every lost run buys one or two levels and every level is felt (the bonuses
 * compound, see `upgradeMultiplier`), so each retry gets visibly further: the first level takes
 * about ten runs, past the wall on its upgrade lane, then the horde, then the boss.
 */
export interface UpgradeInfo {
  title: string;
  /** Price of level 1. */
  baseCost: number;
  /**
   * A cheaper price for level 1, the first card the shop lights up. Damage and fire rate have one:
   * a typical first run pays for both, and even a run lost in the first seconds for one of them.
   */
  firstCost?: number;
  /** Every level costs this many times more than the one before. */
  costGrowth: number;
  /** Highest level that can be bought. */
  maxLevel: number;
  /** Bonus per level: a fraction for `percent` upgrades (0.2 = +20%), a head count for `count`. */
  perLevel: number;
  unit: 'percent' | 'count';
  blurb: string;
}

export const UPGRADES: Record<UpgradeKind, UpgradeInfo> = {
  damage: {
    title: 'Damage',
    baseCost: 150 * COIN_SCALE,
    firstCost: 35 * COIN_SCALE,
    costGrowth: 1.15,
    maxLevel: 25,
    perLevel: 0.12,
    unit: 'percent',
    blurb: 'more damage per bullet',
  },
  rate: {
    title: 'Fire rate',
    baseCost: 150 * COIN_SCALE,
    firstCost: 35 * COIN_SCALE,
    costGrowth: 1.15,
    maxLevel: 20,
    perLevel: 0.08,
    unit: 'percent',
    blurb: 'shots per second',
  },
  soldiers: {
    title: 'Soldiers',
    baseCost: 400 * COIN_SCALE,
    costGrowth: 2,
    maxLevel: 5,
    perLevel: 1,
    unit: 'count',
    blurb: 'extra soldiers at the start',
  },
  coins: {
    title: 'Coins',
    baseCost: 50 * COIN_SCALE,
    costGrowth: 1.5,
    maxLevel: 5,
    // a nice bonus, not a must: at +20% a level (x2.5 maxed) a player who skipped it fell so far
    // behind that a later level took fifteen times the runs
    perLevel: 0.1,
    unit: 'percent',
    blurb: 'coins per kill',
  },
};

export function noUpgrades(): UpgradeLevels {
  return { damage: 0, rate: 0, soldiers: 0, coins: 0 };
}

export function isMaxed(kind: UpgradeKind, level: number): boolean {
  return level >= UPGRADES[kind].maxLevel;
}

/** Price of the next level when `level` has already been bought (Infinity once maxed out). */
export function upgradeCost(kind: UpgradeKind, level: number): number {
  if (isMaxed(kind, level)) return Infinity;
  const u = UPGRADES[kind];
  if (level === 0 && u.firstCost !== undefined) return u.firstCost;
  return Math.round(u.baseCost * Math.pow(u.costGrowth, level));
}

/**
 * Multiplier for a percent upgrade at the given level (1 = no bonus). The bonuses compound: every
 * level adds `perLevel` on top of everything bought so far, so the tenth purchase is felt as much
 * as the first instead of fading into a few percent.
 */
export function upgradeMultiplier(kind: UpgradeKind, level: number): number {
  return Math.pow(1 + UPGRADES[kind].perLevel, level);
}

/** Extra soldiers the squad starts with. */
export function startSoldiers(level: number): number {
  return Math.round(UPGRADES.soldiers.perLevel * level);
}

/** Short text for what a level of an upgrade gives, e.g. `+40%` or `+2`. */
export function upgradeEffect(kind: UpgradeKind, level: number): string {
  const u = UPGRADES[kind];
  return u.unit === 'count'
    ? `+${Math.round(u.perLevel * level)}`
    : `+${Math.round((upgradeMultiplier(kind, level) - 1) * 100)}%`;
}

/** The highest tier the level validator tests: every upgrade at its cap. */
export const MAX_TIER = 10;

/**
 * Uniform upgrade tier used by the level validator: damage and fire rate at `tier`, and the
 * other upgrades in proportion, so tier `MAX_TIER` is the fully upgraded squad.
 */
export function tierUpgrades(tier: number): UpgradeLevels {
  const t = Math.max(0, Math.min(MAX_TIER, tier));
  return {
    damage: Math.round((t * UPGRADES.damage.maxLevel) / MAX_TIER),
    rate: Math.round((t * UPGRADES.rate.maxLevel) / MAX_TIER),
    soldiers: Math.round((t * UPGRADES.soldiers.maxLevel) / MAX_TIER),
    coins: 0,
  };
}
