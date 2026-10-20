import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import type { StationaryLevel } from '../src/levels/schema';
import { validateLevel } from '../src/levels/validate';
import { analyzeStationary, runBot } from '../src/modes/stationary/bot';
import { StationarySim } from '../src/modes/stationary/sim';
import {
  applyUpgrade,
  choiceLabel,
  effectiveWeapon,
  newWeaponState,
} from '../src/modes/stationary/weapons';

const base: StationaryLevel = {
  id: 's',
  name: 'S',
  mode: 'stationary',
  startCount: 10,
  weapon: 'rifle',
  waves: [{ monsters: [{ kind: 'grunt', count: 3, hp: 4, from: 'right', interval: 1 }] }],
};

function run(sim: StationarySim, seconds: number): void {
  for (let i = 0; i < seconds * 30 && sim.phase !== 'won' && sim.phase !== 'lost'; i++) {
    sim.update(1 / 30);
  }
}

describe('weapons', () => {
  it('scales upgrades additively', () => {
    const w = newWeaponState('pistol');
    applyUpgrade(w, 'rate', 0.5);
    applyUpgrade(w, 'damage', 0.25);
    applyUpgrade(w, 'pellets', 2);
    const e = effectiveWeapon(w);
    expect(e.rate).toBeCloseTo(4.5);
    expect(e.damage).toBeCloseTo(0.625);
    expect(e.pellets).toBe(3);
  });

  it('labels choices', () => {
    expect(choiceLabel({ kind: 'crowd', op: 'x', value: 2 }).title).toBe('×2');
    expect(choiceLabel({ kind: 'upgrade', stat: 'rate', value: 0.3 })).toEqual({
      title: '+30%',
      sub: 'FIRE RATE',
    });
    expect(choiceLabel({ kind: 'weapon', weapon: 'shotgun' }).title).toBe('SHOTGUN');
  });
});

describe('StationarySim', () => {
  it('wins a simple level and keeps the squad alive', () => {
    const sim = new StationarySim(base, mulberry32(1));
    run(sim, 60);
    expect(sim.phase).toBe('won');
    expect(sim.count).toBeGreaterThan(0);
    expect(sim.kills).toBe(3);
  });

  it('loses when monsters wipe the squad out', () => {
    const level: StationaryLevel = {
      ...base,
      startCount: 2,
      waves: [{ monsters: [{ kind: 'boss', count: 1, hp: 100000, from: 'top', interval: 1 }] }],
    };
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 120);
    expect(sim.phase).toBe('lost');
    expect(sim.count).toBe(0);
  });

  it('hits harder with a bigger squad', () => {
    const killTime = (count: number) => {
      const level: StationaryLevel = {
        ...base,
        startCount: count,
        waves: [{ monsters: [{ kind: 'tank', count: 1, hp: 60, from: 'top', interval: 1 }] }],
      };
      const sim = new StationarySim(level, mulberry32(3));
      run(sim, 90);
      return sim.phase === 'won' ? sim.time : Infinity;
    };
    expect(killTime(40)).toBeLessThan(killTime(8));
  });

  it('only clears a wave once required blocks are destroyed', () => {
    const level: StationaryLevel = {
      ...base,
      waves: [
        {
          monsters: [{ kind: 'grunt', count: 1, hp: 1, from: 'right', interval: 1 }],
          obstacles: [{ x: -0.5, y: 8, hp: 200, width: 2.4, required: true, drift: 0, damage: 5 }],
        },
      ],
    };
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 3);
    expect(sim.phase).toBe('fighting'); // monster is dead, block still stands
    expect(sim.obstacles[0].alive).toBe(true);
    run(sim, 60); // idle auto-aim falls back to the block
    expect(sim.phase).toBe('won');
  });

  it('pays out a block reward', () => {
    const level: StationaryLevel = {
      ...base,
      waves: [
        {
          monsters: [{ kind: 'grunt', count: 1, hp: 1, from: 'right', interval: 1 }],
          obstacles: [
            {
              x: 0,
              y: 7,
              hp: 5,
              width: 2.4,
              required: true,
              drift: 0,
              damage: 5,
              reward: { op: '+', value: 25 },
            },
          ],
        },
      ],
    };
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 30);
    expect(sim.phase).toBe('won');
    expect(sim.count).toBe(35);
  });

  it('offers cards between waves and applies the pick', () => {
    const level: StationaryLevel = {
      ...base,
      waves: [
        {
          monsters: [{ kind: 'grunt', count: 1, hp: 1, from: 'right', interval: 1 }],
          choices: [
            { kind: 'crowd', op: '+', value: 10 },
            { kind: 'weapon', weapon: 'shotgun' },
          ],
        },
        { monsters: [{ kind: 'grunt', count: 1, hp: 1, from: 'right', interval: 1 }] },
      ],
    };
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 30);
    expect(sim.phase).toBe('choosing');
    expect(sim.choiceList).toHaveLength(2);
    sim.choose(1);
    expect(sim.weapon.id).toBe('shotgun');
    expect(sim.phase).toBe('gap');
    run(sim, 30);
    expect(sim.phase).toBe('won');
  });

  it('a drifting block that reaches the squad costs units', () => {
    const level: StationaryLevel = {
      ...base,
      waves: [
        {
          monsters: [{ kind: 'grunt', count: 1, hp: 1, from: 'right', interval: 1 }],
          obstacles: [{ x: 0, y: 4, hp: 100000, width: 2.4, required: true, drift: 2, damage: 6 }],
        },
      ],
    };
    const sim = new StationarySim(level, mulberry32(1));
    run(sim, 30);
    expect(sim.phase).toBe('won');
    expect(sim.count).toBe(4);
  });

  it('is deterministic for a given seed', () => {
    const a = runBot(base, 42);
    const b = runBot(base, 42);
    expect(a).toEqual(b);
  });
});

describe('stationary level validation', () => {
  const ok = {
    id: 's',
    name: 'S',
    mode: 'stationary',
    startCount: 10,
    weapon: 'pistol',
    waves: [{ monsters: [{ kind: 'grunt', count: 2, hp: 3, from: 'left', interval: 1 }] }],
  };

  it('accepts a minimal stationary level', () => {
    expect(validateLevel(ok).ok).toBe(true);
  });

  it('reports bad weapon, spawn side and choice kind with paths', () => {
    const r = validateLevel({
      ...ok,
      weapon: 'bazooka',
      waves: [
        {
          monsters: [{ kind: 'grunt', count: 2, hp: 3, from: 'down', interval: 1 }],
          choices: [{ kind: 'magic' }, { kind: 'crowd', op: '+', value: 1 }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    const text = r.ok ? '' : r.errors.join('\n');
    expect(text).toContain('weapon');
    expect(text).toContain('waves[0].monsters[0].from');
    expect(text).toContain('waves[0].choices[0].kind');
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
