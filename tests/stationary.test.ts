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
  lanes: [],
  monsters: [{ kind: 'grunt', count: 3, hp: 4, interval: 1, x: 0 }],
};

function run(sim: StationarySim, seconds: number, steer?: (s: StationarySim) => void): void {
  for (let i = 0; i < seconds * 30 && sim.phase !== 'won' && sim.phase !== 'lost'; i++) {
    steer?.(sim);
    sim.update(1 / 30);
  }
}

/** Steers the squad under the lowest monster, or under the front of the lane. */
function chase(s: StationarySim): void {
  let best = -1;
  let y = Infinity;
  for (let i = 0; i < s.malive.length; i++) {
    if (s.malive[i] && s.my[i] < y) {
      y = s.my[i];
      best = i;
    }
  }
  const lane = s.lanes.find((l) => l.elements.length > 0);
  const front = lane?.elements[0];
  s.targetX =
    best >= 0 && y < 3
      ? s.mx[best]
      : lane && front?.type === 'item'
        ? lane.x
        : best >= 0 && y < 8
          ? s.mx[best]
          : lane
            ? lane.x
            : best >= 0
              ? s.mx[best]
              : 0;
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

const item = (def: StationaryLevel['lanes'][number]['elements'][number]) => def;

describe('StationarySim', () => {
  it('wins a simple level when the squad chases the monsters', () => {
    const sim = new StationarySim(base, mulberry32(1));
    run(sim, 60, chase);
    expect(sim.phase).toBe('won');
    expect(sim.kills).toBe(3);
    expect(sim.count).toBeGreaterThan(0);
  });

  it('bullets fly dead straight from the soldier that fired them', () => {
    const sim = new StationarySim(base, mulberry32(1));
    let checked = 0;
    for (let i = 0; i < 80; i++) {
      sim.targetX = Math.floor(i / 10) % 2 === 0 ? 5 : -5; // sweeping must not bend bullets
      sim.update(1 / 30);
      for (let b = 0; b < MAX_BULLETS; b++) {
        if (sim.blife[b] > 0) {
          expect(sim.bvx[b]).toBeCloseTo(0, 5);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('loses when monsters wipe the squad out', () => {
    const level: StationaryLevel = {
      ...base,
      startCount: 2,
      monsters: [{ kind: 'boss', count: 1, hp: 100000, interval: 1, x: 0 }],
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
        monsters: [{ kind: 'tank', count: 1, hp: 300, interval: 1, x: 0, spread: 0 }],
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

  it('handles masses of monsters', () => {
    const level: StationaryLevel = {
      ...base,
      startCount: 20,
      monsters: [{ kind: 'grunt', count: 200, hp: 1, interval: 0.1, x: 0.3, spread: 0.6 }],
    };
    const sim = new StationarySim(level, mulberry32(5));
    run(sim, 120, chase);
    expect(sim.kills + (20 - sim.count)).toBeGreaterThan(150);
  });

  it('a lane shows its whole queue, holds the front block close to the squad', () => {
    const level: StationaryLevel = {
      ...base,
      monsters: [{ kind: 'grunt', count: 1, hp: 1, interval: 1, x: 0.9 }],
      lanes: [
        {
          x: 0,
          width: 3.6,
          elements: [
            item({ type: 'block', hp: 40 }),
            item({ type: 'item', item: { kind: 'crowd', op: '+', value: 1 } }),
            item({ type: 'item', item: { kind: 'crowd', op: '+', value: 1 } }),
            item({ type: 'block', hp: 80 }),
            item({ type: 'item', item: { kind: 'weapon', weapon: 'shotgun' } }),
          ],
        },
      ],
    };
    const sim = new StationarySim(level, mulberry32(1));
    const ys = sim.lanes[0].elements.map((e) => e.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1]); // ordered, visible
    run(sim, 0.8, (s) => (s.targetX = -5)); // squad away: the block just holds
    expect(sim.lanes[0].elements[0].type).toBe('block');
    expect(sim.lanes[0].elements[0].y).toBeCloseTo(4.4, 1);
  });

  it('breaking a block lets the power-ups behind it fall one after another, all catchable', () => {
    const level: StationaryLevel = {
      ...base,
      startCount: 1,
      monsters: [{ kind: 'grunt', count: 1, hp: 1, interval: 1, x: 0.9 }],
      lanes: [
        {
          x: 0,
          width: 3.6,
          elements: [
            item({ type: 'block', hp: 6 }),
            item({ type: 'item', item: { kind: 'crowd', op: '+', value: 2 } }),
            item({ type: 'item', item: { kind: 'crowd', op: '+', value: 3 } }),
          ],
        },
      ],
    };
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 60, chase);
    expect(sim.phase).toBe('won');
    expect(sim.count).toBe(6);
  });

  it('loses power-ups the squad does not catch', () => {
    const level: StationaryLevel = {
      ...base,
      monsters: [{ kind: 'grunt', count: 1, hp: 1, interval: 1, x: 0.9 }],
      lanes: [
        {
          x: 0.7,
          width: 3,
          elements: [
            item({ type: 'block', hp: 6 }),
            item({ type: 'item', item: { kind: 'crowd', op: '+', value: 25 } }),
          ],
        },
      ],
    };
    const sim = new StationarySim(level, mulberry32(1));
    let lost = 0;
    let broken = false;
    sim.hooks.itemLost = () => lost++;
    sim.hooks.blockBreak = () => (broken = true);
    run(sim, 60, (s) => {
      s.targetX = broken ? -5 : 4.2; // shoot the block, then hide on the far left
    });
    expect(lost).toBe(1);
    expect(sim.count).toBeLessThanOrEqual(10);
  });

  it('applies upgrades and weapon switches from power-ups', () => {
    const level: StationaryLevel = {
      ...base,
      lanes: [
        {
          x: 0,
          elements: [
            item({ type: 'block', hp: 5 }),
            item({ type: 'item', item: { kind: 'weapon', weapon: 'shotgun' } }),
            item({ type: 'item', item: { kind: 'upgrade', stat: 'rate', value: 0.5 } }),
          ],
        },
      ],
    };
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 60, chase);
    expect(sim.weapon.id).toBe('shotgun');
    expect(sim.weapon.rateMul).toBeCloseTo(1.5);
  });

  it('blocks can grow hit points while they are in front', () => {
    const level: StationaryLevel = {
      ...base,
      lanes: [{ x: 0.9, elements: [item({ type: 'block', hp: 100, grow: 10 })] }],
    };
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 5, (s) => (s.targetX = -5)); // never shoots it
    expect(sim.lanes[0].elements[0].hp).toBeGreaterThan(130);
  });

  it('is deterministic for a given seed', () => {
    expect(runBot(base, 42)).toEqual(runBot(base, 42));
  });
});

describe('coins', () => {
  it('drops coins for kills and for smashed blocks', () => {
    const level: StationaryLevel = {
      ...base,
      monsters: [{ kind: 'grunt', count: 2, hp: 1, interval: 1, x: 0 }],
      lanes: [{ x: 0.9, width: 3, elements: [item({ type: 'block', hp: 5 })] }],
    };
    const sim = new StationarySim(level, mulberry32(1));
    const drops: number[] = [];
    sim.hooks.coin = (_x, _y, amount) => drops.push(amount);
    run(sim, 60, chase);
    expect(sim.phase).toBe('won');
    expect(drops.length).toBe(3); // two monsters and one block
    expect(sim.coinsRaw).toBe(drops.reduce((a, b) => a + b, 0));
    expect(sim.coinsRaw).toBeGreaterThan(0);
  });

  it('keeps coins from a lost run', () => {
    const level: StationaryLevel = {
      ...base,
      startCount: 3,
      monsters: [
        { kind: 'grunt', count: 3, hp: 1, interval: 0.5, x: 0 },
        { kind: 'boss', count: 1, hp: 1e6, interval: 1, delay: 4, x: 0 },
      ],
    };
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 120, chase);
    expect(sim.phase).toBe('lost');
    expect(sim.coinsRaw).toBeGreaterThan(0);
  });

  it('upgrades make the same squad stronger', () => {
    const killTime = (damageMul: number) => {
      const level: StationaryLevel = {
        ...base,
        monsters: [{ kind: 'tank', count: 1, hp: 200, interval: 1, x: 0, spread: 0 }],
      };
      const sim = new StationarySim(level, mulberry32(3), {}, { damageMul, rateMul: 1 });
      run(sim, 90, chase);
      return sim.phase === 'won' ? sim.time : Infinity;
    };
    expect(killTime(3)).toBeLessThan(killTime(1));
  });
});

describe('stationary level validation', () => {
  const ok = {
    id: 's',
    name: 'S',
    mode: 'stationary',
    startCount: 1,
    weapon: 'pistol',
    lanes: [
      {
        x: -0.5,
        elements: [
          { type: 'block', hp: 8 },
          { type: 'item', item: { kind: 'crowd', op: '+', value: 1 } },
        ],
      },
    ],
    monsters: [{ kind: 'grunt', count: 2, hp: 3, interval: 1 }],
  };

  it('accepts a lane with blocks and power-ups', () => {
    expect(validateLevel(ok).ok).toBe(true);
  });

  it('reports bad weapon, kind, element type and item with paths', () => {
    const r = validateLevel({
      ...ok,
      weapon: 'bazooka',
      lanes: [
        {
          x: 0,
          elements: [
            { type: 'crate', hp: 3 },
            { type: 'item', item: { kind: 'magic' } },
          ],
        },
      ],
      monsters: [{ kind: 'dragon', count: 2, hp: 3, interval: 1 }],
    });
    expect(r.ok).toBe(false);
    const text = r.ok ? '' : r.errors.join('\n');
    expect(text).toContain('weapon');
    expect(text).toContain('monsters[0].kind');
    expect(text).toContain('lanes[0].elements[0].type');
    expect(text).toContain('lanes[0].elements[1].item.kind');
  });

  it('rejects the old wave format and unknown keys', () => {
    expect(validateLevel({ ...ok, waves: [] }).ok).toBe(false);
  });

  it('requires a lane with elements and at least one monster stream', () => {
    expect(validateLevel({ ...ok, lanes: [] }).ok).toBe(false);
    expect(validateLevel({ ...ok, lanes: [{ x: 0, elements: [] }] }).ok).toBe(false);
    expect(validateLevel({ ...ok, monsters: [] }).ok).toBe(false);
  });
});

describe('bot analysis', () => {
  it('wins an easy level in every run', () => {
    const a = analyzeStationary(base);
    expect(a.winRate).toBe(1);
    expect(a.bestSurvivors).toBeGreaterThan(0);
  });
});
