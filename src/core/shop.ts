/**
 * Permanent upgrades bought with coins. Pure data and math, so the game, the level
 * validator and the tests all agree on prices and effects.
 */

export const UPGRADE_KINDS = ['damage', 'rate', 'coins'] as const;
export type UpgradeKind = (typeof UPGRADE_KINDS)[number];

export type UpgradeLevels = Record<UpgradeKind, number>;

export const MAX_UPGRADE_LEVEL = 30;

interface UpgradeInfo {
  title: string;
  /** Price of level 1. */
  baseCost: number;
  /** Every level costs this many times more than the one before. */
  costGrowth: number;
  /** Bonus per level, as a fraction (0.12 = +12%). */
  perLevel: number;
  blurb: string;
}

export const UPGRADES: Record<UpgradeKind, UpgradeInfo> = {
  damage: {
    title: 'Damage',
    baseCost: 20,
    costGrowth: 1.5,
    perLevel: 0.12,
    blurb: 'more damage per bullet',
  },
  rate: {
    title: 'Fire rate',
    baseCost: 20,
    costGrowth: 1.5,
    perLevel: 0.08,
    blurb: 'shots per second',
  },
  coins: {
    title: 'Coin bonus',
    baseCost: 30,
    costGrowth: 1.55,
    perLevel: 0.2,
    blurb: 'coins per kill',
  },
};

export function noUpgrades(): UpgradeLevels {
  return { damage: 0, rate: 0, coins: 0 };
}

/** Price of the next level when `level` has already been bought. */
export function upgradeCost(kind: UpgradeKind, level: number): number {
  const u = UPGRADES[kind];
  return Math.round(u.baseCost * Math.pow(u.costGrowth, level));
}

/** Multiplier for a stat at the given level (1 = no bonus). */
export function upgradeMultiplier(kind: UpgradeKind, level: number): number {
  return 1 + UPGRADES[kind].perLevel * level;
}

/** Uniform upgrade tier used by the level validator: the same level in damage and rate. */
export function tierUpgrades(tier: number): UpgradeLevels {
  return { damage: tier, rate: tier, coins: 0 };
}
