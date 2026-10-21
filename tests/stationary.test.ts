import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { gridSlotX, gridSlotY } from '../src/core/swarm';
import type { StationaryLevel } from '../src/levels/schema';
import { validateLevel } from '../src/levels/validate';
import { analyzeStationary, runBot } from '../src/modes/stationary/bot';
import {
  ARENA,
  BODY_SCALE,
  BULLET_RANGE,
  ELITE_BODY_SCALE,
  GAME_SPEED,
  LANE_HOLD_Y,
  MAX_BULLETS,
  MAX_SHOOTERS,
  MONSTERS,
  MONSTER_KIND_BY_INDEX,
  SOLDIER_SPACING,
  StationarySim,
} from '../src/modes/stationary/sim';
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

/** Steers under the nearest monster (or the middle when none is left). */
function towardsNearest(s: StationarySim): void {
  let best = -1;
  for (let i = 0; i < s.malive.length; i++) {
    if (s.malive[i] && (best < 0 || s.my[i] < s.my[best])) best = i;
  }
  s.targetX = best >= 0 ? s.mx[best] : 0;
}

function elitesOnField(s: StationarySim): number {
  let n = 0;
  for (let i = 0; i < s.malive.length; i++) {
    if (s.malive[i] && MONSTERS[MONSTER_KIND_BY_INDEX[s.mkind[i]]].elite) n++;
  }
  return n;
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
    expect(itemLabel({ kind: 'weapon', weapon: 'minigun' }).title).toBe('MINIGUN');
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

  it('elites stop at their hold line and never bite', () => {
    const level = withLane([{ type: 'block', hp: 1000000 }], {
      startCount: 30,
      monsters: [{ kind: 'miniboss', count: 1, hp: 1000000, interval: 1 }],
    });
    const sim = new StationarySim(level, mulberry32(1));
    sim.targetX = -5; // parked in the upgrade lane: out of reach of its strikes
    run(sim, 60);
    const e = MONSTERS.miniboss.elite!;
    expect(sim.phase).toBe('fighting');
    expect(sim.monstersAlive).toBe(1);
    const i = sim.malive.findIndex((v) => v === 1);
    expect(sim.my[i]).toBeCloseTo(e.holdY, 3);
    expect(sim.count).toBe(30);
    expect(MONSTERS.miniboss.coins).toBeGreaterThan(MONSTERS.tank.coins);
    expect(MONSTERS.miniboss.radius).toBeGreaterThan(MONSTERS.tank.radius);
  });

  it('an elite aims at the squad (or not, by chance) and the strike can be dodged', () => {
    const play = (dodge: boolean) => {
      const level = withLane([{ type: 'block', hp: 1000000 }], {
        startCount: 20,
        monsters: [{ kind: 'boss', count: 1, hp: 1000000, interval: 1, x: 0.5, spread: 0 }],
      });
      const sim = new StationarySim(level, () => 0); // rng 0: every volley is aimed
      const strikes: Array<{ hit: boolean; lost: number }> = [];
      sim.hooks.strike = (_x, _h, hit, lost) => strikes.push({ hit, lost });
      let announcedAt = NaN;
      sim.targetX = 3;
      for (let i = 0; i < 30 * 60 && strikes.length === 0; i++) {
        if (sim.attacks.length > 0 && Number.isNaN(announcedAt)) {
          announcedAt = sim.attacks[0].x;
          if (dodge) sim.targetX = sim.monsterMinX - 2; // slide away into the lane
        }
        sim.update(1 / 30);
      }
      return { strike: strikes[0], announcedAt, sim };
    };
    const stay = play(false);
    expect(stay.announcedAt).toBeCloseTo(3, 0); // aimed where the squad stood
    expect(stay.strike.hit).toBe(true);
    expect(stay.strike.lost).toBe(Math.ceil(20 * MONSTERS.boss.elite!.damage));
    expect(stay.sim.count).toBe(20 - stay.strike.lost);
    const dodged = play(true);
    expect(dodged.strike.hit).toBe(false);
    expect(dodged.sim.count).toBe(20);
  });

  it('a volley that is not aimed lands at random, and its zones leave a gap to dodge into', () => {
    const volley = (rng: () => number, squadX: number) => {
      const level = withLane([{ type: 'block', hp: 1000000 }], {
        startCount: 20,
        monsters: [{ kind: 'boss', count: 1, hp: 1000000, interval: 1, x: 0.5, spread: 0 }],
      });
      const sim = new StationarySim(level, rng);
      sim.targetX = squadX;
      sim.snapSquad = true;
      for (let i = 0; i < 30 * 60 && sim.attacks.length === 0; i++) sim.update(1 / 30);
      return sim;
    };
    // rng just under 1: never aimed, and the random zones sit at the far edge of the field
    const far = volley(() => 0.99, 3);
    expect(far.attacks.length).toBeGreaterThan(0);
    expect(far.attacks.every((a) => Math.abs(a.x - far.squadX) > 1)).toBe(true);

    for (let seed = 1; seed <= 200; seed++) {
      const sim = volley(mulberry32(seed), -1 + (seed % 5));
      const zones = sim.attacks;
      expect(zones.length).toBeGreaterThanOrEqual(1);
      expect(zones.length).toBeLessThanOrEqual(MONSTERS.boss.elite!.zones);
      const spans = zones.map((a) => [a.lo, a.hi]).sort((a, b) => a[0] - b[0]);
      let cursor = -ARENA.halfWidth; // the upgrade lane counts as free room
      let widest = 0;
      for (const [lo, hi] of spans) {
        widest = Math.max(widest, lo - cursor);
        cursor = Math.max(cursor, hi);
      }
      widest = Math.max(widest, ARENA.halfWidth - cursor);
      expect(widest).toBeGreaterThanOrEqual(2 * sim.halfWidth());
    }
  });

  it('a volley costs the squad once, even when it stands in two zones', () => {
    const level = withLane([{ type: 'block', hp: 1000000 }], {
      startCount: 20,
      monsters: [{ kind: 'boss', count: 1, hp: 1000000, interval: 1, x: 0.5, spread: 0 }],
    });
    const sim = new StationarySim(level, mulberry32(3));
    const lost: number[] = [];
    let landed = 0;
    sim.hooks.strike = (_x, _h, _hit, l) => {
      landed++;
      lost.push(l);
    };
    sim.targetX = (sim.monsterMinX + sim.monsterMaxX) / 2;
    sim.snapSquad = true;
    for (let i = 0; i < 30 * 60 && landed === 0; i++) sim.update(1 / 30);
    expect(landed).toBeGreaterThanOrEqual(1);
    expect(lost.reduce((a, b) => a + b, 0)).toBe(20 - sim.count);
    expect(lost.filter((l) => l > 0).length).toBeLessThanOrEqual(1);
  });

  it('bullets stop short of the far end of the field', () => {
    const level = withLane([{ type: 'block', hp: 1000000 }], {
      startCount: 1,
      monsters: [{ kind: 'grunt', count: 1, hp: 1e6, interval: 1, delay: 1000 }],
    });
    const sim = new StationarySim(level, mulberry32(1));
    sim.targetX = 3;
    let highest = 0;
    for (let i = 0; i < 30 * 6; i++) {
      sim.update(1 / 30);
      for (let b = 0; b < MAX_BULLETS; b++)
        if (sim.blife[b] > 0) highest = Math.max(highest, sim.by[b]);
    }
    expect(highest).toBeGreaterThan(BULLET_RANGE - 1); // they do fly a long way...
    expect(highest).toBeLessThan(0.5 + BULLET_RANGE + 0.5); // ...but not out to the spawn line
    expect(highest).toBeLessThan(ARENA.spawnTop);
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

  it('a formation marches in as ranks, one full row after another', () => {
    const level = withLane([{ type: 'block', hp: 1000000 }], {
      monsters: [{ kind: 'grunt', count: 24, hp: 1e6, interval: 0.5, delay: 1, columns: 6 }],
    });
    const sim = new StationarySim(level, mulberry32(3));
    run(sim, 1.4); // 1 s of gap, then the first row appears
    const rows = () => {
      const xs = new Set<number>();
      let n = 0;
      for (let i = 0; i < sim.malive.length; i++) {
        if (!sim.malive[i]) continue;
        n++;
        xs.add(Math.round(sim.mx[i]));
        // they stay in their own lane the whole way down
        expect(sim.mx[i]).toBeGreaterThanOrEqual(sim.monsterMinX);
        expect(sim.mx[i]).toBeLessThanOrEqual(sim.monsterMaxX);
      }
      return { n, columns: xs.size };
    };
    expect(rows().n).toBe(6);
    expect(rows().columns).toBeGreaterThanOrEqual(5); // side by side across the lane
    run(sim, 1);
    expect(rows().n).toBeGreaterThanOrEqual(18); // the next ranks followed without a break
  });

  it('a block never drops below the hold line, so it cannot jump back up', () => {
    const level = withLane(
      [
        { type: 'item', item: { kind: 'crowd', op: '+', value: 1 } },
        { type: 'item', item: { kind: 'crowd', op: '+', value: 1 } },
        { type: 'block', hp: 1000000 },
      ],
      { monsters: [{ kind: 'grunt', count: 1, hp: 1, interval: 1, delay: 500 }] },
    );
    const sim = new StationarySim(level, mulberry32(1));
    sim.targetX = sim.lane.x; // catch both power-ups
    let lowest = Infinity;
    for (let i = 0; i < 30 * 8; i++) {
      sim.update(1 / 30);
      for (const e of sim.lane.elements) if (e.type === 'block') lowest = Math.min(lowest, e.y);
    }
    expect(sim.count).toBe(12); // both +1 power-ups were collected...
    expect(lowest).toBeGreaterThanOrEqual(LANE_HOLD_Y - 1e-6); // ...and the block never came closer
  });

  it('monsters are slow enough to react to and big enough to hit', () => {
    const speeds = Object.values(MONSTERS).map((m) => m.speed * GAME_SPEED);
    // nothing crosses the field in under 3.5 seconds
    expect(Math.max(...speeds)).toBeLessThan(16.3 / 3.5);
    // the fastest monster is at most twice as fast as the slowest ordinary one
    expect(MONSTERS.runner.speed).toBeLessThanOrEqual(MONSTERS.grunt.speed * 2);
    // a grunt is at least a full soldier-spacing wide on screen, so a bullet lane can hit it
    expect(MONSTERS.grunt.radius * 2).toBeGreaterThan(SOLDIER_SPACING * 2);
    expect(MONSTERS.runner.radius * 2).toBeGreaterThan(SOLDIER_SPACING * 1.5);
  });

  it('the lane shows its whole queue and holds the front block close to the squad', () => {
    const level = withLane([
      { type: 'block', hp: 40 },
      { type: 'item', item: { kind: 'crowd', op: '+', value: 1 } },
      { type: 'item', item: { kind: 'crowd', op: '+', value: 1 } },
      { type: 'block', hp: 80 },
      { type: 'item', item: { kind: 'weapon', weapon: 'minigun' } },
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
      // a monster that only appears much later keeps the level open while the lane is worked
      { startCount: 1, monsters: [{ kind: 'grunt', count: 1, hp: 1, interval: 1, delay: 500 }] },
    );
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 30, chase);
    expect(sim.lane.elements.length).toBe(0);
    expect(sim.count).toBe(6);
  });

  it('is won as soon as the last monster is gone, even with blocks and power-ups left on the lane', () => {
    const level = withLane(
      [
        { type: 'block', hp: 1000000 },
        { type: 'item', item: { kind: 'crowd', op: '+', value: 2 } },
      ],
      { monsters: [{ kind: 'grunt', count: 3, hp: 1, interval: 0.5 }] },
    );
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 30, (s) => {
      s.targetX = s.monsterMinX + 2;
    });
    expect(sim.phase).toBe('won');
    expect(sim.lane.elements.length).toBe(2);
    expect(sim.progress).toBe(1);
  });

  it('loses power-ups the squad does not catch', () => {
    const level = withLane(
      [
        { type: 'block', hp: 6 },
        { type: 'item', item: { kind: 'crowd', op: '+', value: 25 } },
      ],
      {
        monsters: [
          { kind: 'grunt', count: 3, hp: 4, interval: 1 },
          { kind: 'grunt', count: 1, hp: 1, interval: 1, delay: 500 },
        ],
      },
    );
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
      { type: 'item', item: { kind: 'weapon', weapon: 'minigun' } },
      { type: 'item', item: { kind: 'upgrade', stat: 'rate', value: 0.5 } },
    ]);
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 60, chase);
    expect(sim.weapon.id).toBe('minigun');
    expect(sim.weapon.rateMul).toBeCloseTo(1.5);
  });

  it('blocks can grow hit points while they are in front', () => {
    const level = withLane([{ type: 'block', hp: 100, grow: 10 }], {
      monsters: [{ kind: 'grunt', count: 1, hp: 1, interval: 1, delay: 500 }],
    });
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 5, (s) => (s.targetX = 5)); // never shoots it
    expect(sim.lane.elements[0].hp).toBeGreaterThan(130);
  });

  it('remembers the biggest squad of the run, also after bites (stars compare against it)', () => {
    const level = withLane(
      [
        { type: 'block', hp: 5 },
        { type: 'item', item: { kind: 'crowd', op: '+', value: 5 } },
      ],
      { monsters: [{ kind: 'grunt', count: 3, hp: 1000, interval: 0.5, delay: 4 }] },
    );
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 60, (s) => (s.targetX = s.lane.x)); // catch the power-up, then let the grunts bite
    expect(sim.peak).toBe(15);
    expect(sim.count).toBe(12);
  });

  it('is deterministic for a given seed', () => {
    expect(runBot(base, 42)).toEqual(runBot(base, 42));
  });
});

describe('elite arrival', () => {
  /** Plays until `done` says so and returns the sim time, or Infinity if it never did. */
  const timeUntil = (sim: StationarySim, limit: number, done: (s: StationarySim) => boolean) => {
    for (let i = 0; i < limit * 30 && sim.phase !== 'won' && sim.phase !== 'lost'; i++) {
      towardsNearest(sim);
      sim.update(1 / 30);
      if (done(sim)) return sim.time;
    }
    return Infinity;
  };

  it('sends every elite at its scheduled time, whatever else is on the field', () => {
    const level = withLane([{ type: 'block', hp: 1000000 }], {
      startCount: 500,
      monsters: [
        { kind: 'grunt', count: 20, hp: 1e6, interval: 1 },
        { kind: 'miniboss', count: 1, hp: 1e6, interval: 1, delay: 6, x: -0.5, spread: 0 },
        { kind: 'miniboss', count: 1, hp: 1e6, interval: 1, delay: 12, x: 0.5, spread: 0 },
        { kind: 'boss', count: 1, hp: 1e6, interval: 1, delay: 18, spread: 0 },
      ],
    });
    const sim = new StationarySim(level, mulberry32(1));
    const at: number[] = [];
    for (let n = 1; n <= 3; n++) {
      at.push(timeUntil(sim, 40, (s) => elitesOnField(s) >= n));
    }
    // the first two are still alive (1e6 hp) when the next one arrives: nobody waits for anybody
    expect(elitesOnField(sim)).toBe(3);
    for (const [k, due] of [6, 12, 18].entries()) {
      expect(at[k]).toBeGreaterThanOrEqual(due);
      expect(at[k]).toBeLessThan(due + 1);
    }
  });

  it('is on time even when the monster pool is full of ordinary monsters', () => {
    const level = withLane([{ type: 'block', hp: 1000000 }], {
      startCount: 5000,
      monsters: [
        { kind: 'grunt', count: 3000, hp: 1e6, interval: 0.01, spread: 0 },
        { kind: 'boss', count: 1, hp: 1e6, interval: 1, delay: 15 },
      ],
    });
    const sim = new StationarySim(level, mulberry32(1));
    sim.targetX = -5;
    const seen = timeUntil(sim, 40, (s) => elitesOnField(s) > 0);
    expect(sim.monstersAlive).toBeGreaterThan(400); // the pool really is nearly full
    expect(seen).toBeLessThan(16);
  });
});

describe('bodies', () => {
  const field = (sim: StationarySim) => {
    const out: { x: number; y: number; kind: number }[] = [];
    for (let i = 0; i < sim.malive.length; i++) {
      if (sim.malive[i]) out.push({ x: sim.mx[i], y: sim.my[i], kind: sim.mkind[i] });
    }
    return out;
  };

  it('a horde slides around a boss instead of walking through it', () => {
    const level = withLane([{ type: 'block', hp: 1000000 }], {
      startCount: 500,
      monsters: [
        { kind: 'boss', count: 1, hp: 1e6, interval: 1, x: 0, spread: 0 },
        { kind: 'grunt', count: 40, hp: 1e6, interval: 0.5, delay: 6, x: 0, spread: 0.1 },
      ],
    });
    const sim = new StationarySim(level, mulberry32(1));
    sim.targetX = -5; // out of the way, in the upgrade lane
    const reach = MONSTERS.boss.radius * ELITE_BODY_SCALE + MONSTERS.grunt.radius * BODY_SCALE;
    let closest = Infinity;
    let passedLeft = 0;
    let passedRight = 0;
    const bossHold = MONSTERS.boss.elite!.holdY;
    for (let i = 0; i < 30 * 30 && (sim.phase === 'fighting' || sim.phase === 'gap'); i++) {
      sim.update(1 / 30);
      const all = field(sim);
      const boss = all.find((m) => m.kind === 4);
      if (!boss) continue;
      for (const m of all) {
        if (m.kind === 4) continue;
        closest = Math.min(closest, Math.hypot(m.x - boss.x, m.y - boss.y));
        if (m.y < bossHold - reach) {
          if (m.x < boss.x) passedLeft++;
          else passedRight++;
        }
      }
    }
    expect(closest).toBeGreaterThanOrEqual(reach - 0.05);
    // the stream is split: monsters reach the squad on both sides of the boss
    expect(passedLeft).toBeGreaterThan(0);
    expect(passedRight).toBeGreaterThan(0);
  });

  it('a boss in the way soaks up the bullets meant for what stands behind it', () => {
    const level = withLane([{ type: 'block', hp: 1000000 }], {
      startCount: 20,
      monsters: [
        { kind: 'boss', count: 1, hp: 1e6, interval: 1, x: 0, spread: 0 },
        { kind: 'grunt', count: 1, hp: 3, interval: 1, delay: 5, x: 0, spread: 0 },
      ],
    });
    const sim = new StationarySim(level, mulberry32(1));
    const mid = (sim.monsterMinX + sim.monsterMaxX) / 2;
    sim.snapSquad = true;
    sim.targetX = mid;
    run(sim, 12);
    // the grunt marched into the boss and is being steered around it; the boss took the hits
    const bossIndex = field(sim).findIndex((m) => m.kind === 4);
    expect(bossIndex).toBeGreaterThanOrEqual(0);
    expect(sim.mhp[sim.malive.findIndex((v, i) => v === 1 && sim.mkind[i] === 4)]).toBeLessThan(
      1e6,
    );
  });

  it('elites always come down the middle, one behind the other', () => {
    const level = withLane([{ type: 'block', hp: 1000000 }], {
      startCount: 500,
      monsters: [
        { kind: 'boss', count: 1, hp: 1e9, interval: 1, x: 0.9, spread: 0 },
        { kind: 'miniboss', count: 1, hp: 1e9, interval: 1, delay: 0, x: -0.9, spread: 0 },
        { kind: 'miniboss', count: 1, hp: 1e9, interval: 1, delay: 0, x: 0.5, spread: 0 },
      ],
    });
    const sim = new StationarySim(level, mulberry32(1));
    sim.targetX = -5;
    run(sim, 25);
    const mid = (sim.monsterMinX + sim.monsterMaxX) / 2;
    const elites = field(sim).filter((m) => m.kind >= 3);
    expect(elites).toHaveLength(3);
    for (const e of elites) expect(e.x).toBeCloseTo(mid, 3);
    // a column: nobody overlaps and the first one holds at its own line
    elites.sort((a, b) => a.y - b.y);
    for (let k = 1; k < elites.length; k++) {
      const r = (m: { kind: number }) =>
        m.kind === 4 ? MONSTERS.boss.radius : MONSTERS.miniboss.radius;
      expect(elites[k].y - elites[k - 1].y).toBeGreaterThanOrEqual(
        r(elites[k]) + r(elites[k - 1]) - 0.01,
      );
    }
  });

  it('an elite steps up when the one in front of it falls', () => {
    const level = withLane([{ type: 'block', hp: 1000000 }], {
      startCount: 500,
      monsters: [
        { kind: 'miniboss', count: 1, hp: 1, interval: 1, delay: 0 },
        { kind: 'boss', count: 1, hp: 1e9, interval: 1, delay: 0 },
      ],
    });
    const sim = new StationarySim(level, mulberry32(1));
    const mid = (sim.monsterMinX + sim.monsterMaxX) / 2;
    sim.snapSquad = true;
    sim.targetX = -5;
    run(sim, 8);
    const bossY = () => field(sim).find((m) => m.kind === 4)!.y;
    const before = bossY();
    expect(before).toBeGreaterThan(MONSTERS.boss.elite!.holdY + 1);
    sim.targetX = mid; // now shoot the miniboss down
    run(sim, 20);
    expect(field(sim).some((m) => m.kind === 3)).toBe(false);
    expect(bossY()).toBeCloseTo(MONSTERS.boss.elite!.holdY, 1);
  });

  it('nothing gets stuck on the elites: every grunt and tank still reaches the squad', () => {
    for (const seed of [1, 2, 3]) {
      const level = withLane([{ type: 'block', hp: 1000000 }], {
        startCount: 100000,
        monsters: [
          { kind: 'boss', count: 1, hp: 1e9, interval: 1, x: 0.9, spread: 0 },
          { kind: 'miniboss', count: 2, hp: 1e9, interval: 1, delay: 1, x: -0.9, spread: 0 },
          { kind: 'grunt', count: 60, hp: 1e9, interval: 0.5, delay: 6, columns: 4 },
          { kind: 'runner', count: 12, hp: 1e9, interval: 1, delay: 7, columns: 3 },
          { kind: 'tank', count: 6, hp: 1e9, interval: 3, delay: 8, x: 0.3, spread: 0.6 },
        ],
      });
      const sim = new StationarySim(level, mulberry32(seed));
      sim.targetX = -5; // out of the way: whatever is left alive is stuck, not shot
      run(sim, 70);
      expect(field(sim).filter((m) => m.kind < 3)).toHaveLength(0);
    }
  });

  it('ordinary monsters do not stack on top of each other', () => {
    const level = withLane([{ type: 'block', hp: 1000000 }], {
      startCount: 500,
      monsters: [
        { kind: 'grunt', count: 24, hp: 1e6, interval: 0.4, columns: 6, spread: 0.3 },
        { kind: 'grunt', count: 24, hp: 1e6, interval: 0.4, columns: 6, spread: 0.3 },
      ],
    });
    const sim = new StationarySim(level, mulberry32(1));
    sim.targetX = -5;
    run(sim, 3.5);
    const all = field(sim);
    expect(all.length).toBeGreaterThan(20);
    let closest = Infinity;
    for (let a = 0; a < all.length; a++) {
      for (let b = a + 1; b < all.length; b++) {
        closest = Math.min(closest, Math.hypot(all[a].x - all[b].x, all[a].y - all[b].y));
      }
    }
    expect(closest).toBeGreaterThan(0.45); // soft bodies: a little give, but no ghosts
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
    run(sim, 120, towardsNearest); // the grunts die, then the boss's strikes wear the squad down
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
