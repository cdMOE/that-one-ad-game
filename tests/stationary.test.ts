import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { gridSlotX, gridSlotY } from '../src/core/swarm';
import type { StationaryLevel } from '../src/levels/schema';
import { validateLevel } from '../src/levels/validate';
import { analyzeStationary, runBot } from '../src/modes/stationary/bot';
import { MAX_BULLETS, MAX_SHOOTERS, MONSTERS, StationarySim } from '../src/modes/stationary/sim';
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
  lane: { elements: [{ type: 'block', hp: 1000000 }] },
  monsters: [{ kind: 'grunt', count: 3, hp: 4, interval: 1 }],
};

function run(sim: StationarySim, seconds: number, steer?: (s: StationarySim) => void): void {
  for (let i = 0; i < seconds * 30 && sim.phase !== 'won' && sim.phase !== 'lost'; i++) {
    steer?.(sim);
    sim.update(1 / 30);
  }
}

/** Steers the squad under the lowest monster, or into the upgrade lane for its front element. */
function chase(s: StationarySim): void {
  let best = -1;
  let y = Infinity;
  for (let i = 0; i < s.malive.length; i++) {
    if (s.malive[i] && s.my[i] < y) {
      y = s.my[i];
      best = i;
    }
  }
  const front = s.lane.elements[0];
  if (best >= 0 && y < 3) s.targetX = s.mx[best];
  else if (front?.type === 'item') s.targetX = s.lane.x;
  else if (best >= 0 && y < 8) s.targetX = s.mx[best];
  else if (front) s.targetX = s.lane.x;
  else s.targetX = best >= 0 ? s.mx[best] : 0;
}

const withLane = (
  elements: StationaryLevel['lane']['elements'],
  extra: Partial<StationaryLevel> = {},
): StationaryLevel => ({ ...base, lane: { elements }, ...extra });

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
    expect(itemLabel({ kind: 'crowd', op: 'x', value: 2 }).title).toBe('\u00d72');
    expect(itemLabel({ kind: 'upgrade', stat: 'rate', value: 0.3 })).toEqual({
      title: '+30%',
      sub: 'FIRE RATE',
    });
    expect(itemLabel({ kind: 'weapon', weapon: 'shotgun' }).title).toBe('SHOTGUN');
  });
});

describe('StationarySim', () => {
  it('wins a simple level when the squad chases the monsters', () => {
    const sim = new StationarySim(withLane([{ type: 'block', hp: 5 }]), mulberry32(1));
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

  it('monsters never enter the upgrade lane, on either side', () => {
    for (const side of ['left', 'right'] as const) {
      const level: StationaryLevel = {
        ...base,
        lane: { side, elements: [{ type: 'block', hp: 1000000 }] },
        monsters: [
          { kind: 'grunt', count: 150, hp: 1000, interval: 0.05 },
          { kind: 'runner', count: 50, hp: 1000, interval: 0.1 },
          { kind: 'boss', count: 2, hp: 1000000, interval: 3 },
        ],
      };
      const sim = new StationarySim(level, mulberry32(9));
      const laneMin = sim.lane.x - sim.lane.width / 2;
      const laneMax = sim.lane.x + sim.lane.width / 2;
      for (let i = 0; i < 30 * 12; i++) {
        sim.targetX = 0;
        sim.update(1 / 30);
        for (let m = 0; m < sim.malive.length; m++) {
          if (!sim.malive[m]) continue;
          expect(sim.mx[m] < laneMin || sim.mx[m] > laneMax).toBe(true);
        }
        if (sim.phase === 'lost') break;
      }
    }
  });

  it('monsters march straight down their lane', () => {
    const sim = new StationarySim(base, mulberry32(2));
    const startX = new Map<number, number>();
    const lastY = new Map<number, number>();
    for (let i = 0; i < 60; i++) {
      sim.update(1 / 30);
      for (let m = 0; m < sim.malive.length; m++) {
        if (!sim.malive[m]) continue;
        // a slot that jumps back up has been reused by a new monster
        if ((lastY.get(m) ?? Infinity) < sim.my[m]) startX.delete(m);
        lastY.set(m, sim.my[m]);
        const first = startX.get(m) ?? sim.mx[m];
        startX.set(m, first);
        expect(sim.mx[m]).toBeCloseTo(first, 5);
      }
    }
  });

  it('loses when monsters wipe the squad out', () => {
    const level = withLane([{ type: 'block', hp: 1000000 }], {
      startCount: 2,
      monsters: [{ kind: 'boss', count: 1, hp: 100000, interval: 1 }],
    });
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 120);
    expect(sim.phase).toBe('lost');
    expect(sim.count).toBe(0);
  });

  it('minibosses bite harder than grunts and pay more', () => {
    const lostTo = (kind: 'grunt' | 'miniboss') => {
      const level = withLane([{ type: 'block', hp: 1000000 }], {
        startCount: 30,
        monsters: [{ kind, count: 1, hp: 1000000, interval: 1 }],
      });
      const sim = new StationarySim(level, mulberry32(1));
      sim.targetX = -5; // never shoots
      run(sim, 20);
      return 30 - sim.count;
    };
    expect(lostTo('miniboss')).toBeGreaterThan(lostTo('grunt'));
    expect(MONSTERS.miniboss.coins).toBeGreaterThan(MONSTERS.tank.coins);
    expect(MONSTERS.miniboss.radius).toBeGreaterThan(MONSTERS.tank.radius);
  });

  it('hits harder with a bigger squad, even beyond what can be drawn', () => {
    const killTime = (count: number) => {
      const level = withLane([{ type: 'block', hp: 3 }], {
        startCount: count,
        monsters: [{ kind: 'tank', count: 1, hp: 300, interval: 1, spread: 0 }],
      });
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

  it('copes with masses of monsters without dropping any spawn', () => {
    const level = withLane([{ type: 'block', hp: 1000000 }], {
      startCount: 700,
      monsters: [{ kind: 'grunt', count: 600, hp: 2, interval: 0.04 }],
    });
    const sim = new StationarySim(level, mulberry32(5));
    let peak = 0;
    for (let i = 0; i < 30 * 120 && sim.phase !== 'won' && sim.phase !== 'lost'; i++) {
      sim.targetX = sim.lane.x; // parked under the block: the horde reaches the bottom
      sim.update(1 / 30);
      peak = Math.max(peak, sim.monstersAlive);
    }
    expect(peak).toBeGreaterThan(60);
    // every monster either died or bit one soldier: none was lost to a full pool
    expect(sim.kills + (700 - sim.count)).toBe(600);
  });

  it('the lane shows its whole queue and holds the front block close to the squad', () => {
    const level = withLane([
      { type: 'block', hp: 40 },
      { type: 'item', item: { kind: 'crowd', op: '+', value: 1 } },
      { type: 'item', item: { kind: 'crowd', op: '+', value: 1 } },
      { type: 'block', hp: 80 },
      { type: 'item', item: { kind: 'weapon', weapon: 'shotgun' } },
    ]);
    const sim = new StationarySim(level, mulberry32(1));
    const ys = sim.lane.elements.map((e) => e.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1]); // ordered, visible
    run(sim, 0.8, (s) => (s.targetX = 5)); // squad on the monster side: the block just holds
    expect(sim.lane.elements[0].type).toBe('block');
    expect(sim.lane.elements[0].y).toBeCloseTo(4.4, 1);
  });

  it('breaking a block lets the power-ups behind it fall one after another, all catchable', () => {
    const level = withLane(
      [
        { type: 'block', hp: 6 },
        { type: 'item', item: { kind: 'crowd', op: '+', value: 2 } },
        { type: 'item', item: { kind: 'crowd', op: '+', value: 3 } },
      ],
      { startCount: 1, monsters: [] },
    );
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 60, chase);
    expect(sim.phase).toBe('won');
    expect(sim.count).toBe(6);
  });

  it('loses power-ups the squad does not catch', () => {
    const level = withLane([
      { type: 'block', hp: 6 },
      { type: 'item', item: { kind: 'crowd', op: '+', value: 25 } },
    ]);
    const sim = new StationarySim(level, mulberry32(1));
    let lost = 0;
    let broken = false;
    sim.hooks.itemLost = () => lost++;
    sim.hooks.blockBreak = () => (broken = true);
    run(sim, 60, (s) => {
      s.targetX = broken ? 5 : s.lane.x; // shoot the block, then leave for the monster side
    });
    expect(lost).toBe(1);
    expect(sim.count).toBeLessThanOrEqual(10);
  });

  it('applies upgrades and weapon switches from power-ups', () => {
    const level = withLane([
      { type: 'block', hp: 5 },
      { type: 'item', item: { kind: 'weapon', weapon: 'shotgun' } },
      { type: 'item', item: { kind: 'upgrade', stat: 'rate', value: 0.5 } },
    ]);
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 60, chase);
    expect(sim.weapon.id).toBe('shotgun');
    expect(sim.weapon.rateMul).toBeCloseTo(1.5);
  });

  it('blocks can grow hit points while they are in front', () => {
    const level = withLane([{ type: 'block', hp: 100, grow: 10 }]);
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 5, (s) => (s.targetX = 5)); // never shoots it
    expect(sim.lane.elements[0].hp).toBeGreaterThan(130);
  });

  it('is deterministic for a given seed', () => {
    expect(runBot(base, 42)).toEqual(runBot(base, 42));
  });
});

describe('coins', () => {
  it('drops coins for kills and for smashed blocks', () => {
    const level = withLane([{ type: 'block', hp: 5 }], {
      monsters: [{ kind: 'grunt', count: 2, hp: 1, interval: 1 }],
    });
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
    const level = withLane([{ type: 'block', hp: 1000000 }], {
      startCount: 3,
      monsters: [
        { kind: 'grunt', count: 3, hp: 1, interval: 0.5 },
        { kind: 'boss', count: 1, hp: 1e6, interval: 1, delay: 4 },
      ],
    });
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 120, chase);
    expect(sim.phase).toBe('lost');
    expect(sim.coinsRaw).toBeGreaterThan(0);
  });

  it('upgrades make the same squad stronger', () => {
    const killTime = (damageMul: number) => {
      const level = withLane([{ type: 'block', hp: 3 }], {
        monsters: [{ kind: 'tank', count: 1, hp: 200, interval: 1, spread: 0 }],
      });
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
    lane: {
      elements: [
        { type: 'block', hp: 8 },
        { type: 'item', item: { kind: 'crowd', op: '+', value: 1 } },
      ],
    },
    monsters: [{ kind: 'grunt', count: 2, hp: 3, interval: 1 }],
  };

  it('accepts a lane with blocks and power-ups, and minibosses', () => {
    expect(validateLevel(ok).ok).toBe(true);
    expect(
      validateLevel({
        ...ok,
        lane: { side: 'right', elements: ok.lane.elements },
        monsters: [{ kind: 'miniboss', count: 1, hp: 50, interval: 1, x: 0.5, spread: 0.2 }],
      }).ok,
    ).toBe(true);
  });

  it('reports bad weapon, kind, element type and item with paths', () => {
    const r = validateLevel({
      ...ok,
      weapon: 'bazooka',
      lane: {
        elements: [
          { type: 'crate', hp: 3 },
          { type: 'item', item: { kind: 'magic' } },
        ],
      },
      monsters: [{ kind: 'dragon', count: 2, hp: 3, interval: 1 }],
    });
    expect(r.ok).toBe(false);
    const text = r.ok ? '' : r.errors.join('\n');
    expect(text).toContain('weapon');
    expect(text).toContain('monsters[0].kind');
    expect(text).toContain('lane.elements[0].type');
    expect(text).toContain('lane.elements[1].item.kind');
  });

  it('rejects the old lanes/waves formats and a bad side', () => {
    expect(validateLevel({ ...ok, lanes: [] }).ok).toBe(false);
    expect(validateLevel({ ...ok, waves: [] }).ok).toBe(false);
    expect(validateLevel({ ...ok, lane: { side: 'middle', elements: ok.lane.elements } }).ok).toBe(
      false,
    );
  });

  it('requires lane elements and at least one monster stream', () => {
    expect(validateLevel({ ...ok, lane: { elements: [] } }).ok).toBe(false);
    expect(validateLevel({ ...ok, monsters: [] }).ok).toBe(false);
  });
});

describe('bot analysis', () => {
  it('wins an easy level in every run', () => {
    const a = analyzeStationary(withLane([{ type: 'block', hp: 5 }]));
    expect(a.winRate).toBe(1);
    expect(a.bestSurvivors).toBeGreaterThan(0);
  });
});
