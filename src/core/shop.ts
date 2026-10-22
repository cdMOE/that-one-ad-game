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

export const UPGRADE_KINDS = ['damage', 'rate', 'soldiers', 'coins'] as const;
export type UpgradeKind = (typeof UPGRADE_KINDS)[number];

export type UpgradeLevels = Record<UpgradeKind, number>;

/**
 * Every permanent upgrade has a cap, so the strongest possible squad is a known quantity.
 *
 * Prices are the dial for how long the campaign takes: `npm run simulate:campaign` shows the
 * runs per level. Damage and fire rate come in many small steps that start cheap and get steeper,
 * like the ad shooters: the first runs buy several levels each and the squad gets stronger fast,
 * later every run still buys one or two, and the levels (each one a wall of bosses) take a few more
 * runs each. The strongest squad is no stronger than before; it just takes longer to get there.
 */
export interface UpgradeInfo {
  title: string;
  /** Price of level 1. */
  baseCost: number;
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
    baseCost: 50 * COIN_SCALE,
    costGrowth: 1.15,
    maxLevel: 30,
    perLevel: 0.08,
    unit: 'percent',
    blurb: 'more damage per bullet',
  },
  rate: {
    title: 'Fire rate',
    baseCost: 50 * COIN_SCALE,
    costGrowth: 1.15,
    maxLevel: 25,
    perLevel: 0.05,
    unit: 'percent',
    blurb: 'shots per second',
  },
  soldiers: {
    title: 'Soldiers',
    baseCost: 120 * COIN_SCALE,
    costGrowth: 1.9,
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
    perLevel: 0.25,
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

/**
 * The first levels of every upgrade are on sale: a quarter, a half, three quarters of the price,
 * then full price from this level on. So even a botched first run buys something, and the second
 * run is visibly stronger, without making the rest of the price curve any cheaper.
 */
const INTRO_LEVELS = 4;

/** Price of the next level when `level` has already been bought (Infinity once maxed out). */
export function upgradeCost(kind: UpgradeKind, level: number): number {
  if (isMaxed(kind, level)) return Infinity;
  const u = UPGRADES[kind];
  const intro = Math.min(1, (level + 1) / INTRO_LEVELS);
  return Math.round(u.baseCost * Math.pow(u.costGrowth, level) * intro);
}

/** Multiplier for a percent upgrade at the given level (1 = no bonus). */
export function upgradeMultiplier(kind: UpgradeKind, level: number): number {
  return 1 + UPGRADES[kind].perLevel * level;
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
    : `+${Math.round(u.perLevel * level * 100)}%`;
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
