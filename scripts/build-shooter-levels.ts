import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import type { LaneElementDef, SpawnDef, StationaryLevel, SummonDef } from '../src/levels/schema';
import { validateLevel } from '../src/levels/validate';

// Writes the five shooter level files (src/levels/11-15) from one template plus a flavour and a
// toughness per level. All five share the shape that keeps a level a slope instead of a cliff (see
// the README): a lane that is a ladder of small steps with the minigun early, an end phase of
// pulses with breathers, tanks between the pulses and the boss as the one wall at the end.
// Tune the numbers in LEVELS, run this, then check with `npm run simulate:campaign`.
// Run with: npm run build:shooter-levels

/** How one level differs from the template. All health numbers are in first-level units. */
interface LevelSpec {
  file: string;
  id: string;
  name: string;
  /** Toughness: every health number of the template (lane, monsters, elites) times this. */
  k: number;
  side: 'left' | 'right';
  /** The lane up to and including the rifle and what follows it, before the ladder. */
  opening: string;
  /** Monsters of the opening and middle phase, relative to the template (more, each softer). */
  crowd?: number;
  /** Health of the end-phase pulses, first and last, before `k`. */
  pulseHp?: [number, number];
  /** Runners come down this spot of the monster lane (-1..1) instead of all over it. */
  runnersAt?: number;
  /** Health of the miniboss in the opening (default 300), before `k`. */
  miniboss?: number;
  /** Extra factor on the boss's health. */
  boss?: number;
  /** The horde the boss calls, before `k` on its health. */
  summons: SummonDef;
  /** Extra monsters (health already in first-level units, times `k` like the rest). */
  extra?: SpawnDef[];
}

const LEVELS: LevelSpec[] = [
  {
    file: '11-first-blood',
    id: 'stationary-01',
    name: 'First Blood',
    k: 1.25,
    side: 'left',
    opening: 'B4 +2 B30 +2 B100 rifle +3',
    summons: { kind: 'grunt', hp: 20, count: 32, columns: 8, at: [0.75, 0.5, 0.25] },
  },
  {
    file: '12-heavy-crates',
    id: 'stationary-02',
    name: 'Heavy Crates',
    k: 3.969,
    boss: 0.6,
    side: 'left',
    // the x2 right after the rifle and tanks all through, one by one; a breather, so the miniboss
    // in the opening is a light one
    opening: 'B8 +2 B60 +2 B230 rifle x2',
    miniboss: 100,
    summons: { kind: 'tank', hp: 40, count: 4, columns: 4, at: [0.66, 0.33] },
    extra: [tank(2, 30, 2, 30, -0.3), tank(3, 55, 2.5, 40, -0.3)],
  },
  {
    file: '13-growing-pains',
    id: 'stationary-03',
    name: 'Growing Pains',
    k: 8.9,
    boss: 0.75,
    side: 'right',
    // runners down the far flank, and a second miniboss that calls them
    opening: 'B10 +2 B80 +2 B310 rifle +3',
    runnersAt: 0.8,
    summons: { kind: 'grunt', hp: 20, count: 32, columns: 8, at: [0.75, 0.5, 0.25] },
    extra: [
      {
        kind: 'miniboss',
        count: 1,
        hp: 1500,
        interval: 1,
        delay: 48,
        x: 0,
        spread: 0.3,
        summons: { kind: 'runner', hp: 4, count: 12, columns: 6, at: [0.5] },
      },
    ],
  },
  {
    file: '14-flood',
    id: 'stationary-04',
    name: 'The Flood',
    k: 18.817,
    boss: 0.4,
    side: 'left',
    // nearly twice as many monsters, each softer: a flood that melts, and a short boss fight
    opening: 'B12 +3 B100 rifle x2',
    crowd: 1.8,
    pulseHp: [3, 4],
    summons: { kind: 'grunt', hp: 12, count: 24, columns: 8, at: [0.75, 0.5, 0.25] },
  },
  {
    file: '15-big-boss',
    id: 'stationary-05',
    name: 'Big Boss',
    k: 42,
    side: 'right',
    // a second miniboss early in the end phase, then the chapter boss
    opening: 'B15 +2 B120 +2 B400 rifle +3',
    boss: 0.8,
    summons: { kind: 'grunt', hp: 20, count: 24, columns: 8, at: [0.75, 0.5, 0.25] },
    extra: [{ kind: 'miniboss', count: 1, hp: 400, interval: 1, delay: 58, x: -0.4, spread: 0.3 }],
  },
];

/**
 * The lane after the opening: the minigun early (the power fantasy every run gets, not the wall),
 * then small steps of soldiers and fire rate behind blocks that get thicker the deeper they sit.
 * No late x2: one gate that doubles the squad decides a run on its own.
 */
const LADDER =
  'B400 minigun +3 B900 +3 B1500 +3 B2200 r+0.15 B3000 +3 B4000 +4 B5200 r+0.15 B6600 +4 B8200 +4 ' +
  'B10000 r+0.15 B12500 +5 B15500 +5 B19000 +6 B24000 +8 B32000 +10';

/** The highest block the level schema allows; that far down the lane no run gets anyway. */
const MAX_BLOCK = 1_000_000;

/** Rounds to two significant digits, so the files read like designed numbers. */
function nice(x: number): number {
  if (x < 20) return Math.max(1, Math.round(x));
  const p = Math.pow(10, Math.floor(Math.log10(x)) - 1);
  return Math.round(x / p) * p;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Lane tokens: `B<hp>` block, `rifle`/`minigun`, `+N`/`xN` soldiers, `r+V` fire rate. */
function lane(tokens: string, scale: (hp: number) => number): LaneElementDef[] {
  return tokens
    .trim()
    .split(/\s+/)
    .map((t): LaneElementDef => {
      if (t.startsWith('B')) return { type: 'block', hp: scale(Number(t.slice(1))) };
      if (t === 'rifle' || t === 'minigun') {
        return { type: 'item', item: { kind: 'weapon', weapon: t } };
      }
      if (t.startsWith('r+')) {
        return { type: 'item', item: { kind: 'upgrade', stat: 'rate', value: Number(t.slice(2)) } };
      }
      if (t.startsWith('+') || t.startsWith('x')) {
        const op = t.startsWith('+') ? '+' : 'x';
        return { type: 'item', item: { kind: 'crowd', op, value: Number(t.slice(1)) } };
      }
      throw new Error(`unknown lane token "${t}"`);
    });
}

function grunt(
  count: number,
  hp: number,
  interval: number,
  delay: number,
  columns: number,
  spread: number,
  x: number,
): SpawnDef {
  return { kind: 'grunt', count, hp, interval, delay, columns, spread, x };
}

function runner(count: number, hp: number, interval: number, delay: number, x: number): SpawnDef {
  return { kind: 'runner', count, hp, interval, delay, columns: 3, spread: 0.6, x };
}

function tank(count: number, hp: number, interval: number, delay: number, x = 0.3): SpawnDef {
  return { kind: 'tank', count, hp, interval, delay, x, spread: 0.6 };
}

/** The opening and the middle of a level, until the end phase at 50 s (game time). */
function opening(crowd: number): SpawnDef[] {
  const n = (count: number) => Math.round(count * crowd);
  // more monsters come closer together, so the phase keeps its length
  const iv = (interval: number) => round2(interval / Math.sqrt(crowd));
  return [
    grunt(n(6), 1, iv(1.8), 5, 2, 0.34, 0),
    grunt(n(6), 1, iv(1.75), 13, 2, 0.34, -0.59),
    runner(6, 1, 3.5, 15, 0.29),
    grunt(n(9), 1, iv(1.66), 21, 3, 0.51, 0.44),
    grunt(n(9), 1, iv(1.66), 21.64, 3, 0.51, -0.44),
    runner(6, 1, 3.33, 23, -0.22),
    grunt(n(16), 1, iv(1.55), 29, 4, 0.69, 0),
    grunt(n(16), 1, iv(1.55), 29.57, 4, 0.69, 0),
    runner(6, 1, 3.1, 31, 0),
    grunt(n(20), 2, iv(1.41), 37, 5, 0.86, -0.13),
    grunt(n(20), 2, iv(1.41), 37.5, 5, 0.86, 0.13),
    runner(6, 1, 2.83, 39, 0.07),
    grunt(n(30), 2, iv(1.26), 45, 6, 1, 0),
    grunt(n(30), 2, iv(1.26), 45.45, 6, 1, 0),
    runner(6, 1, 2.52, 47, 0),
    tank(3, 70, 1.5, 46),
  ];
}

/**
 * The end phase: short, dense pulses of the horde with a breather after each, so a squad that
 * falls a little behind loses a few soldiers and catches up instead of being overrun in two
 * seconds. Eight pulses of three rows, 0.6 s apart, 3 s of breather.
 */
function pulses([hp0, hp1]: [number, number]): SpawnDef[] {
  const out: SpawnDef[] = [];
  const count = 8;
  const rows = 3;
  const interval = 0.6;
  let t = 50;
  for (let i = 0; i < count; i++) {
    const hp = hp0 + ((hp1 - hp0) * i) / (count - 1);
    out.push(grunt(rows * 3, hp, interval, round2(t), 3, 0.5, -0.5));
    out.push(grunt(rows * 3, hp, interval, round2(t + 0.3), 3, 0.5, 0.5));
    if (i % 2 === 1) out.push(runner(3, 1, 0.6, round2(t + 1), 0));
    t += rows * interval + 3;
  }
  return out;
}

function build(spec: LevelSpec): StationaryLevel {
  const hp = (x: number) => nice(x * spec.k);
  const template: SpawnDef[] = [
    ...opening(spec.crowd ?? 1),
    ...pulses(spec.pulseHp ?? [5, 7]),
    // tanks come between the pulses, not with the boss: the boss is the one wall at the end
    tank(3, 195, 1.5, 57),
    tank(3, 300, 1.4, 66),
    ...(spec.extra ?? []),
    {
      kind: 'miniboss',
      count: 1,
      hp: spec.miniboss ?? 300,
      interval: 1,
      delay: 24.8,
      x: -0.4,
      spread: 0.3,
    },
  ];
  const monsters = template.map((m) => {
    const scaled: SpawnDef = { ...m, hp: hp(m.hp) };
    if (m.summons) scaled.summons = { ...m.summons, hp: hp(m.summons.hp) };
    if (m.kind === 'runner' && spec.runnersAt !== undefined) {
      scaled.x = spec.runnersAt;
      scaled.spread = 0.25;
    }
    return scaled;
  });
  monsters.push({
    kind: 'boss',
    count: 1,
    hp: nice(5000 * spec.k * (spec.boss ?? 1)),
    interval: 1,
    delay: 77,
    x: 0.4,
    spread: 0.3,
    summons: { ...spec.summons, hp: hp(spec.summons.hp) },
  });
  return {
    id: spec.id,
    name: spec.name,
    mode: 'stationary',
    startCount: 1,
    weapon: 'pistol',
    lane: {
      side: spec.side,
      elements: [
        ...lane(spec.opening, (x) => x),
        ...lane(LADDER, (x) => Math.min(MAX_BLOCK, nice(x * spec.k))),
      ],
    },
    monsters,
  };
}

const dir = join(import.meta.dirname, '..', 'src', 'levels');
const options = { ...(await resolveConfig(dir)), parser: 'json' };
for (const spec of LEVELS) {
  const level = build(spec);
  const result = validateLevel(level);
  if (!result.ok) throw new Error(`${spec.file}: ${result.errors.join('; ')}`);
  const path = join(dir, `${spec.file}.json`);
  writeFileSync(path, await format(JSON.stringify(level), options));
  console.log(`wrote ${path}`);
}
