import { describe, expect, it } from 'vitest';
import {
  noUpgrades,
  tierUpgrades,
  upgradeCost,
  upgradeMultiplier,
  UPGRADE_KINDS,
} from '../src/core/shop';

describe('shop', () => {
  it('makes every level more expensive than the one before', () => {
    for (const kind of UPGRADE_KINDS) {
      let prev = 0;
      for (let level = 0; level < 15; level++) {
        const cost = upgradeCost(kind, level);
        expect(cost).toBeGreaterThan(prev);
        prev = cost;
      }
    }
  });

  it('starts cheap and gets steep', () => {
    expect(upgradeCost('damage', 0)).toBeLessThanOrEqual(35);
    expect(upgradeCost('damage', 10)).toBeGreaterThan(upgradeCost('damage', 0) * 30);
  });

  it('has no bonus at level 0 and a linear bonus per level', () => {
    expect(upgradeMultiplier('damage', 0)).toBe(1);
    expect(upgradeMultiplier('damage', 5)).toBeCloseTo(1.6);
    expect(upgradeMultiplier('coins', 2)).toBeCloseTo(1.4);
  });

  it('describes tiers and empty upgrades', () => {
    expect(noUpgrades()).toEqual({ damage: 0, rate: 0, coins: 0 });
    expect(tierUpgrades(3)).toEqual({ damage: 3, rate: 3, coins: 0 });
  });
});
