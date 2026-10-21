import { describe, expect, it, vi } from 'vitest';
import { loadSave, resetSave, writeSave, type SaveData } from '../src/core/storage';
import { COIN_SCALE } from '../src/core/shop';

describe('resetSave', () => {
  it('erases levels, coins and upgrades in place but keeps the sound setting', () => {
    const upgrades = { damage: 4, rate: 3, soldiers: 1, coins: 2 };
    const save: SaveData = {
      completed: { 'runner-01': { stars: 3, best: 12 } },
      muted: true,
      coins: 800,
      upgrades,
    };
    resetSave(save);
    expect(save.completed).toEqual({});
    expect(save.coins).toBe(0);
    expect(save.upgrades).toBe(upgrades); // the running game keeps pointing at the same object
    expect(upgrades).toEqual({ damage: 0, rate: 0, soldiers: 0, coins: 0 });
    expect(save.muted).toBe(true);
  });
});

describe('coin inflation', () => {
  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };

  it('converts a save from before the inflation and leaves a current one alone', () => {
    vi.stubGlobal('localStorage', fake);
    store.set('that-one-ad-game:v2', JSON.stringify({ coins: 150, upgrades: { damage: 2 } }));
    const old = loadSave();
    expect(old.coins).toBe(150 * COIN_SCALE);
    writeSave(old);
    expect(loadSave().coins).toBe(150 * COIN_SCALE); // saved with the scale: not converted twice
    vi.unstubAllGlobals();
  });
});
