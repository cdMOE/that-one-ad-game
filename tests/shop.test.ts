import { describe, expect, it } from 'vitest';
import {
  COIN_SCALE,
  firstClearBonus,
  isMaxed,
  MAX_TIER,
  noUpgrades,
  startSoldiers,
  tierUpgrades,
  upgradeCost,
  upgradeEffect,
  upgradeMultiplier,
  UPGRADE_KINDS,
  UPGRADES,
} from '../src/core/shop';

describe('shop', () => {
  it('makes every level more expensive than the one before', () => {
    for (const kind of UPGRADE_KINDS) {
      let prev = 0;
      for (let level = 0; level < UPGRADES[kind].maxLevel; level++) {
        const cost = upgradeCost(kind, level);
        expect(cost).toBeGreaterThan(prev);
        prev = cost;
      }
    }
  });

  it('comes in many steps: the first run buys damage and fire rate, the campaign fills them all', () => {
    expect(UPGRADES.damage.maxLevel).toBeGreaterThanOrEqual(20);
    expect(UPGRADES.rate.maxLevel).toBeGreaterThanOrEqual(20);
    // a weak first run of the first level (~4000 coins) lights up both cards
    let wallet = 4000;
    let bought = 0;
    const levels = { damage: 0, rate: 0 };
    for (;;) {
      const kind =
        upgradeCost('damage', levels.damage) <= upgradeCost('rate', levels.rate)
          ? 'damage'
          : 'rate';
      const cost = upgradeCost(kind, levels[kind]);
      if (cost > wallet) break;
      wallet -= cost;
      levels[kind]++;
      bought++;
    }
    expect(levels).toEqual({ damage: 1, rate: 1 });
    expect(bought).toBe(2);
  });

  it('starts cheap and gets steeper, but never explodes', () => {
    expect(upgradeCost('damage', 0)).toBeLessThanOrEqual(100 * COIN_SCALE);
    const last = UPGRADES.damage.maxLevel - 1;
    expect(upgradeCost('damage', last)).toBeGreaterThan(upgradeCost('damage', 0) * 15);
    // the whole price list of an upgrade stays within reach of a long campaign
    for (const kind of UPGRADE_KINDS) {
      expect(upgradeCost(kind, UPGRADES[kind].maxLevel - 1)).toBeLessThan(150_000);
    }
  });

  it('pays a first-clear bonus that grows with the level', () => {
    expect(firstClearBonus(0)).toBeGreaterThanOrEqual(upgradeCost('damage', 0));
    for (let order = 1; order < 6; order++) {
      expect(firstClearBonus(order)).toBeGreaterThan(firstClearBonus(order - 1));
    }
  });

  it('keeps the coin upgrade worth buying: level 1 pays back in a handful of runs', () => {
    const typicalRun = 2000;
    const gain = typicalRun * UPGRADES.coins.perLevel;
    expect(upgradeCost('coins', 0) / gain).toBeLessThanOrEqual(5);
  });

  it('has no bonus at level 0 and a bonus that compounds per level', () => {
    expect(upgradeMultiplier('damage', 0)).toBe(1);
    expect(upgradeMultiplier('damage', 2)).toBeCloseTo(1.12 * 1.12);
    expect(upgradeMultiplier('coins', 2)).toBeCloseTo(1.44);
    // every level is worth as much as the one before: the tenth purchase is felt like the first
    const step = (level: number) =>
      upgradeMultiplier('damage', level + 1) / upgradeMultiplier('damage', level);
    expect(step(10)).toBeCloseTo(step(0));
  });

  it('describes tiers and empty upgrades', () => {
    expect(noUpgrades()).toEqual({ damage: 0, rate: 0, soldiers: 0, coins: 0 });
    expect(tierUpgrades(3)).toEqual({ damage: 8, rate: 6, soldiers: 2, coins: 0 });
  });

  it('caps every upgrade: the last level can be bought, the one after cannot', () => {
    for (const kind of UPGRADE_KINDS) {
      const max = UPGRADES[kind].maxLevel;
      expect(isMaxed(kind, max - 1)).toBe(false);
      expect(Number.isFinite(upgradeCost(kind, max - 1))).toBe(true);
      expect(isMaxed(kind, max)).toBe(true);
      expect(upgradeCost(kind, max)).toBe(Infinity);
    }
  });

  it('gives whole soldiers for the soldiers upgrade and a fully upgraded squad at the top tier', () => {
    expect(startSoldiers(3)).toBe(3);
    expect(upgradeEffect('soldiers', 2)).toBe('+2');
    expect(upgradeEffect('damage', 3)).toBe('+40%');
    const top = tierUpgrades(MAX_TIER);
    for (const kind of ['damage', 'rate', 'soldiers'] as const) {
      expect(top[kind]).toBe(UPGRADES[kind].maxLevel);
    }
  });
});
