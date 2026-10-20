import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { gridSlotX, gridSlotY } from '../src/core/swarm';
import type { StationaryLevel } from '../src/levels/schema';
import { validateLevel } from '../src/levels/validate';
import { analyzeStationary, runBot } from '../src/modes/stationary/bot';
import { MAX_BULLETS, MAX_SHOOTERS, StationarySim } from '../src/modes/stationary/sim';
import {
  applyUpgrade,
  effectiveWeapon,
  itemLabel,
  newWeaponState,
} from '../src/modes/stationary/weapons';

const base: StationaryLevel = {
  id: 's',
  name: 'S',
  mode: 'stationary',
  startCount: 10,
  weapon: 'rifle',
  waves: [{ monsters: [{ kind: 'grunt', count: 3, hp: 4, interval: 1, x: 0 }] }],
};

function run(sim: StationarySim, seconds: number, steer?: (s: StationarySim) => void): void {
  for (let i = 0; i < seconds * 30 && sim.phase !== 'won' && sim.phase !== 'lost'; i++) {
    steer?.(sim);
    sim.update(1 / 30);
  }
}

/** Steers the squad under the lowest monster, or under the block / item. */
function chase(s: StationarySim): void {
  let best = -1;
  let y = Infinity;
  for (let i = 0; i < s.malive.length; i++) {
    if (s.malive[i] && s.my[i] < y) {
      y = s.my[i];
      best = i;
    }
  }
  const item = s.items[0];
  const block = s.obstacles.find((o) => o.alive);
  s.targetX =
    best >= 0 && y < 8 ? s.mx[best] : item ? item.x : block ? block.x : best >= 0 ? s.mx[best] : 0;
}

describe('grid formation', () => {
  it('centres each row and puts later rows behind', () => {
    // 10 units in 4 columns: rows of 4, 4, 2
    expect(gridSlotX(0, 10, 4)).toBe(-1.5);
    expect(gridSlotX(3, 10, 4)).toBe(1.5);
    expect(gridSlotX(8, 10, 4)).toBe(-0.5); // partial last row is centred
    expect(gridSlotX(9, 10, 4)).toBe(0.5);
    expect(gridSlotY(0, 4)).toBe(0);
    expect(gridSlotY(9, 4)).toBe(-2);
  });
});

describe('weapons', () => {
  it('scales upgrades additively', () => {
    const w = newWeaponState('pistol');
    applyUpgrade(w, 'rate', 0.5);
    applyUpgrade(w, 'damage', 0.25);
    applyUpgrade(w, 'pellets', 2);
    const e = effectiveWeapon(w);
    expect(e.rate).toBeCloseTo(3.3);
    expect(e.damage).toBeCloseTo(1.25);
    expect(e.pellets).toBe(3);
  });

  it('labels power-ups', () => {
    expect(itemLabel({ kind: 'crowd', op: 'x', value: 2 }).title).toBe('×2');
    expect(itemLabel({ kind: 'upgrade', stat: 'rate', value: 0.3 })).toEqual({
      title: '+30%',
      sub: 'FIRE RATE',
    });
    expect(itemLabel({ kind: 'weapon', weapon: 'shotgun' }).title).toBe('SHOTGUN');
  });
});

describe('StationarySim', () => {
  it('wins a simple level when the squad chases the monsters', () => {
    const sim = new StationarySim(base, mulberry32(1));
    run(sim, 60, chase);
    expect(sim.phase).toBe('won');
    expect(sim.kills).toBe(3);
    expect(sim.count).toBeGreaterThan(0);
  });

  it('only hits what is above the squad: a bullet flies straight', () => {
    const sim = new StationarySim(base, mulberry32(1));
    sim.targetX = -4;
    run(sim, 3); // squad parks on the left, the lane is on the right x=0 -> nothing is hit
    expect(sim.kills).toBe(0);
  });

  it('bullets keep part of the squad speed', () => {
    const sim = new StationarySim(base, mulberry32(1));
    let sideways = 0;
    for (let i = 0; i < 80; i++) {
      sim.targetX = Math.floor(i / 10) % 2 === 0 ? 5 : -5; // keep sweeping
      sim.update(1 / 30);
      for (let b = 0; b < MAX_BULLETS; b++) {
        if (sim.blife[b] > 0 && sim.bvx[b] > 3) sideways++;
      }
    }
    expect(sideways).toBeGreaterThan(0);
  });

  it('loses when monsters wipe the squad out', () => {
    const level: StationaryLevel = {
      ...base,
      startCount: 2,
      waves: [{ monsters: [{ kind: 'boss', count: 1, hp: 100000, interval: 1, x: 0 }] }],
    };
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 120);
    expect(sim.phase).toBe('lost');
    expect(sim.count).toBe(0);
  });

  it('hits harder with a bigger squad, even beyond what can be drawn', () => {
    const killTime = (count: number) => {
      const level: StationaryLevel = {
        ...base,
        startCount: count,
        waves: [{ monsters: [{ kind: 'tank', count: 1, hp: 300, interval: 1, x: 0, spread: 0 }] }],
      };
      const sim = new StationarySim(level, mulberry32(3));
      run(sim, 90, chase);
      return sim.phase === 'won' ? sim.time : Infinity;
    };
    expect(killTime(40)).toBeLessThan(killTime(8));
    expect(killTime(400)).toBeLessThan(killTime(40));
    expect(new StationarySim({ ...base, startCount: 400 }, mulberry32(1)).shooters).toBe(
      MAX_SHOOTERS,
    );
  });

  it('a block stops bullets, drops its power-up when broken and the squad can catch it', () => {
    const level: StationaryLevel = {
      ...base,
      waves: [
        {
          monsters: [{ kind: 'grunt', count: 1, hp: 1, interval: 1, x: 0 }],
          obstacles: [
            {
              x: 0,
              y: 8,
              hp: 30,
              width: 4.2,
              grow: 0,
              item: { kind: 'crowd', op: '+', value: 25 },
            },
          ],
        },
      ],
    };
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 3, (s) => (s.targetX = 0));
    expect(sim.phase).toBe('fighting'); // the block is still standing
    run(sim, 60, chase);
    expect(sim.phase).toBe('won');
    expect(sim.count).toBe(35);
  });

  it('loses the power-up when the squad does not catch it', () => {
    const level: StationaryLevel = {
      ...base,
      waves: [
        {
          monsters: [{ kind: 'grunt', count: 1, hp: 1, interval: 1, x: 0 }],
          obstacles: [
            {
              x: 0.7,
              y: 8,
              hp: 10,
              width: 3,
              grow: 0,
              item: { kind: 'crowd', op: '+', value: 25 },
            },
          ],
        },
      ],
    };
    const sim = new StationarySim(level, mulberry32(1));
    let lost = 0;
    sim.hooks.itemLost = () => lost++;
    let broken = false;
    sim.hooks.obstacleBreak = () => (broken = true);
    run(sim, 60, (s) => {
      // shoot the block, then hide on the far left while the item falls
      s.targetX = broken ? -5 : 4.2;
    });
    expect(lost).toBe(1);
    expect(sim.count).toBeLessThanOrEqual(10);
  });

  it('applies upgrades and weapon switches from items', () => {
    const level: StationaryLevel = {
      ...base,
      waves: [
        {
          monsters: [{ kind: 'grunt', count: 1, hp: 1, interval: 1, x: 0 }],
          obstacles: [
            { x: 0, y: 6, hp: 5, width: 4.2, grow: 0, item: { kind: 'weapon', weapon: 'shotgun' } },
          ],
        },
      ],
    };
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 60, chase);
    expect(sim.weapon.id).toBe('shotgun');
  });

  it('blocks can grow hit points over time', () => {
    const level: StationaryLevel = {
      ...base,
      waves: [
        {
          monsters: [{ kind: 'grunt', count: 1, hp: 1, interval: 1, x: 0 }],
          obstacles: [{ x: 0.9, y: 8, hp: 100, width: 3, grow: 10 }],
        },
      ],
    };
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 5, (s) => (s.targetX = -5)); // never shoots it
    expect(sim.obstacles[0].hp).toBeGreaterThan(130);
  });

  it('is deterministic for a given seed', () => {
    expect(runBot(base, 42)).toEqual(runBot(base, 42));
  });
});

describe('stationary level validation', () => {
  const ok = {
    id: 's',
    name: 'S',
    mode: 'stationary',
    startCount: 10,
    weapon: 'pistol',
    waves: [{ monsters: [{ kind: 'grunt', count: 2, hp: 3, interval: 1 }] }],
  };

  it('accepts a minimal stationary level', () => {
    expect(validateLevel(ok).ok).toBe(true);
  });

  it('accepts a block with a power-up', () => {
    const r = validateLevel({
      ...ok,
      waves: [
        {
          monsters: [{ kind: 'grunt', count: 2, hp: 3, interval: 1, x: 0.5 }],
          obstacles: [
            { x: -0.5, y: 8, hp: 40, item: { kind: 'upgrade', stat: 'rate', value: 0.3 } },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('reports bad weapon, kind and item with paths', () => {
    const r = validateLevel({
      ...ok,
      weapon: 'bazooka',
      waves: [
        {
          monsters: [{ kind: 'dragon', count: 2, hp: 3, interval: 1 }],
          obstacles: [{ x: 0, y: 8, hp: 5, item: { kind: 'magic' } }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    const text = r.ok ? '' : r.errors.join('\n');
    expect(text).toContain('weapon');
    expect(text).toContain('waves[0].monsters[0].kind');
    expect(text).toContain('waves[0].obstacles[0].item.kind');
  });

  it('rejects the old per-side spawns and unknown keys', () => {
    const r = validateLevel({
      ...ok,
      waves: [{ monsters: [{ kind: 'grunt', count: 2, hp: 3, interval: 1, from: 'left' }] }],
    });
    expect(r.ok).toBe(false);
  });

  it('requires at least one wave and one monster stream', () => {
    expect(validateLevel({ ...ok, waves: [] }).ok).toBe(false);
    expect(validateLevel({ ...ok, waves: [{ monsters: [] }] }).ok).toBe(false);
  });
});

describe('bot analysis', () => {
  it('wins an easy level in every run', () => {
    const a = analyzeStationary(base);
    expect(a.winRate).toBe(1);
    expect(a.bestSurvivors).toBeGreaterThan(0);
  });
});
