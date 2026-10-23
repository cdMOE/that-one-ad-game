import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import type {
  LaneElementDef,
  SpawnDef,
  StationaryLevel,
  SummonDef,
  WeaponId,
} from '../src/levels/schema';
import { validateLevel } from '../src/levels/validate';

// Writes the five shooter level files (src/levels/11-15) from one template plus a face and a
// toughness per level. All five share the shape that keeps a level a slope instead of a cliff (see
// the README): a lane that is a ladder of small steps with the minigun early, an end phase of
// pulses with breathers and the boss as the one wall at the end. Each level has its own face on
// top: its own lane (what it rewards, in its own order), its own pace and one new thing.
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
  /** The weapon the squad starts with (default the pistol). */
  weapon?: WeaponId;
  /** The lane up to and including the rifle and what follows it, health as written. */
  opening: string;
  /** The rest of the lane, the level's own ladder of rewards; block health times `k`. */
  ladder: string;
  /**
   * Pace: the whole timeline (the crowd, the end phase, the tanks and the elites) is this much
   * longer, as dense as ever (default 1: the boss reaches its line at about 52 s).
   */
  tempo?: number;
  /** Monsters of the opening and middle phase, relative to the template (more, each softer). */
  crowd?: number;
  /** Health of the end-phase pulses, first and last, before `k`. */
  pulseHp?: [number, number];
  /** The end-phase pulses come one side at a time, left, right, left: a flood that sloshes. */
  sway?: boolean;
  /** Runners come down this spot of the monster lane (-1..1) instead of all over it. */
  runnersAt?: number;
  /** Health of the miniboss in the opening (default 300), before `k`; null for none. */
  miniboss?: number | null;
  /** Extra factor on the boss's health. */
  boss?: number;
  /** The horde the boss calls, before `k` on its health. */
  summons: SummonDef;
  /** Extra monsters (health in first-level units times `k`, delay stretched by `tempo`). */
  extra?: SpawnDef[];
}

const LEVELS: LevelSpec[] = [
  {
    // the core loop, and the fixed point of the calibration: the rifle, the minigun, small steps
    file: '11-first-blood',
    id: 'stationary-01',
    name: 'First Blood',
    k: 1.25,
    side: 'left',
    opening: 'B4 +2 B30 +2 B100 rifle +3',
    ladder:
      'B400 minigun +3 B900 +3 B1500 +3 B2200 r+0.15 B3000 +3 B4000 +4 B5200 r+0.15 B6600 +4 B8200 +5',
    summons: { kind: 'grunt', hp: 20, count: 32, columns: 8, at: [0.75, 0.5, 0.25] },
  },
  {
    // heavy crates: few, thick blocks with big rewards, and SPREAD: the shots fan out, the tanks
    // that come in pairs all through the level fall to it. No miniboss: the breather after the
    // tutorial, the tank pairs are its small walls
    file: '12-heavy-crates',
    id: 'stationary-02',
    name: 'Heavy Crates',
    k: 3.969,
    boss: 1.6,
    side: 'left',
    tempo: 0.95,
    opening: 'B8 +2 B60 +2 B230 rifle x2',
    ladder: 'B350 minigun +3 B1400 s+1 B3000 +5 B5500 r+0.15 B9000 +6 B14000 +8 B21000 +10',
    miniboss: null,
    summons: { kind: 'tank', hp: 40, count: 4, columns: 4, at: [0.66, 0.33] },
    extra: [tank(2, 30, 1.5, 20, -0.3), tank(2, 45, 1.5, 32, 0.3), tank(2, 60, 1.5, 42, -0.3)],
  },
  {
    // growing pains: every block after the minigun grows while it stands in front, so a squad that
    // only ever shoots the horde finds the next reward further away; the rewards are DAMAGE (the
    // minigun itself never sits behind a growing block: missing it would decide the run). Runners down the far
    // flank, a second miniboss that calls them, and the longest level
    file: '13-growing-pains',
    id: 'stationary-03',
    name: 'Growing Pains',
    k: 8.2,
    boss: 0.75,
    side: 'right',
    tempo: 1.15,
    opening: 'B10 +2 B80 +2 B310 rifle +3',
    ladder:
      'B400 minigun +3 G900 d+0.25 G1500 +3 G2200 d+0.25 G3000 +4 G4000 r+0.15 G5200 +4 G6600 +5 G8200 +6',
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
    // the flood: armed from the start, rewards raining down every few seconds, nearly twice as
    // many monsters, each softer, sloshing from side to side; no miniboss, a short boss fight
    file: '14-flood',
    id: 'stationary-04',
    name: 'The Flood',
    k: 29,
    boss: 0.35,
    side: 'left',
    weapon: 'rifle',
    tempo: 0.95,
    opening: 'B12 +3 B60 minigun x2',
    ladder:
      'B120 +2 B200 +2 B320 +3 B500 +3 B750 r+0.15 B1100 +3 B1600 +4 B2300 +4 B3200 r+0.15 B4500 +5 B6200 +6',
    crowd: 1.8,
    pulseHp: [3, 4],
    sway: true,
    miniboss: null,
    summons: { kind: 'grunt', hp: 12, count: 24, columns: 8, at: [0.75, 0.5, 0.25] },
  },
  {
    // the chapter boss: two minibosses guard it, it calls every kind of monster at once, and the
    // prize at the end of the lane is the LASER, within reach of a strong run
    file: '15-big-boss',
    id: 'stationary-05',
    name: 'Big Boss',
    k: 42,
    side: 'right',
    tempo: 1.1,
    opening: 'B15 +2 B120 +2 B400 rifle +3',
    ladder:
      'B400 minigun +3 B900 +3 B1500 d+0.25 B2200 laser B3000 r+0.15 B4000 +5 B5500 +6 B7500 +8',
    boss: 0.8,
    summons: {
      kind: 'grunt',
      hp: 20,
      count: 16,
      columns: 8,
      at: [0.75, 0.5, 0.25],
      mix: [
        { kind: 'runner', hp: 12, count: 8 },
        { kind: 'tank', hp: 150, count: 2 },
      ],
    },
    extra: [{ kind: 'miniboss', count: 1, hp: 400, interval: 1, delay: 58, x: -0.4, spread: 0.3 }],
  },
];

/** The highest block the level schema allows; that far down the lane no run gets anyway. */
const MAX_BLOCK = 1_000_000;
/** A growing block (`G` token) gains this share of its health every second it stands in front. */
const GROW_SHARE = 0.03;

/** Rounds to two significant digits, so the files read like designed numbers. */
function nice(x: number): number {
  if (x < 20) return Math.max(1, Math.round(x));
  const p = Math.pow(10, Math.floor(Math.log10(x)) - 1);
  return Math.round(x / p) * p;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Lane tokens: `B<hp>` block, `G<hp>` a block that grows while in front, `rifle`/`minigun`/`laser`,
 * `+N`/`xN` soldiers, `r+V` fire rate, `d+V` damage, `s+N` spread (pellets).
 */
function lane(tokens: string, scale: (hp: number) => number): LaneElementDef[] {
  return tokens
    .trim()
    .split(/\s+/)
    .map((t): LaneElementDef => {
      if (t.startsWith('B')) return { type: 'block', hp: scale(Number(t.slice(1))) };
      if (t.startsWith('G')) {
        const hp = scale(Number(t.slice(1)));
        return { type: 'block', hp, grow: nice(hp * GROW_SHARE) };
      }
      if (t === 'rifle' || t === 'minigun' || t === 'laser') {
        return { type: 'item', item: { kind: 'weapon', weapon: t } };
      }
      const upgrade = { 'r+': 'rate', 'd+': 'damage', 's+': 'pellets' } as const;
      const stat = upgrade[t.slice(0, 2) as keyof typeof upgrade];
      if (stat) return { type: 'item', item: { kind: 'upgrade', stat, value: Number(t.slice(2)) } };
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

/**
 * The opening and the middle of a level, until the end phase at 50 s (game time), `tempo` times as
 * long: every group comes `tempo` times later and as many more, at the same pace.
 */
function opening(crowd: number, tempo: number): SpawnDef[] {
  const n = (count: number) => Math.max(1, Math.round(count * crowd * tempo));
  // more monsters come closer together, so the phase keeps its length
  const iv = (interval: number) => round2(interval / Math.sqrt(crowd));
  const at = (delay: number) => round2(delay * tempo);
  const r = (count: number) => Math.max(1, Math.round(count * tempo));
  return [
    grunt(n(6), 1, iv(1.8), at(5), 2, 0.34, 0),
    grunt(n(6), 1, iv(1.75), at(13), 2, 0.34, -0.59),
    runner(r(6), 1, 3.5, at(15), 0.29),
    grunt(n(9), 1, iv(1.66), at(21), 3, 0.51, 0.44),
    grunt(n(9), 1, iv(1.66), at(21.64), 3, 0.51, -0.44),
    runner(r(6), 1, 3.33, at(23), -0.22),
    grunt(n(16), 1, iv(1.55), at(29), 4, 0.69, 0),
    grunt(n(16), 1, iv(1.55), at(29.57), 4, 0.69, 0),
    runner(r(6), 1, 3.1, at(31), 0),
    grunt(n(20), 2, iv(1.41), at(37), 5, 0.86, -0.13),
    grunt(n(20), 2, iv(1.41), at(37.5), 5, 0.86, 0.13),
    runner(r(6), 1, 2.83, at(39), 0.07),
    grunt(n(30), 2, iv(1.26), at(45), 6, 1, 0),
    grunt(n(30), 2, iv(1.26), at(45.45), 6, 1, 0),
    runner(r(6), 1, 2.52, at(47), 0),
    tank(3, 70, 1.5, at(46)),
  ];
}

/**
 * The end phase: short, dense pulses of the horde with a breather after each, so a squad that
 * falls a little behind loses a few soldiers and catches up instead of being overrun in two
 * seconds. Eight pulses of three rows, 0.6 s apart, 3 s of breather (`tempo` times as many, from
 * `tempo` times later). With `sway` each pulse comes down one side, the next one the other.
 */
function pulses([hp0, hp1]: [number, number], tempo: number, sway: boolean): SpawnDef[] {
  const out: SpawnDef[] = [];
  const count = Math.max(2, Math.round(8 * tempo));
  const rows = 3;
  const interval = 0.6;
  let t = 50 * tempo;
  for (let i = 0; i < count; i++) {
    const hp = hp0 + ((hp1 - hp0) * i) / (count - 1);
    if (sway) {
      out.push(grunt(rows * 6, hp, interval, round2(t), 6, 0.55, i % 2 === 0 ? -0.45 : 0.45));
    } else {
      out.push(grunt(rows * 3, hp, interval, round2(t), 3, 0.5, -0.5));
      out.push(grunt(rows * 3, hp, interval, round2(t + 0.3), 3, 0.5, 0.5));
    }
    if (i % 2 === 1) out.push(runner(3, 1, 0.6, round2(t + 1), 0));
    t += rows * interval + 3;
  }
  return out;
}

function build(spec: LevelSpec): StationaryLevel {
  const hp = (x: number) => nice(x * spec.k);
  const tempo = spec.tempo ?? 1;
  const at = (delay: number) => round2(delay * tempo);
  const miniboss = spec.miniboss === undefined ? 300 : spec.miniboss;
  const template: SpawnDef[] = [
    ...opening(spec.crowd ?? 1, tempo),
    ...pulses(spec.pulseHp ?? [5, 7], tempo, spec.sway ?? false),
    // tanks come between the pulses, not with the boss: the boss is the one wall at the end
    tank(3, 195, 1.5, at(57)),
    tank(3, 300, 1.4, at(66)),
    ...(spec.extra ?? []).map((m) => ({ ...m, delay: at(m.delay ?? 0) })),
    ...(miniboss === null
      ? []
      : [
          {
            kind: 'miniboss' as const,
            count: 1,
            hp: miniboss,
            interval: 1,
            delay: at(24.8),
            x: -0.4,
            spread: 0.3,
          },
        ]),
  ];
  const summons = (s: SummonDef): SummonDef => ({
    ...s,
    hp: hp(s.hp),
    ...(s.mix ? { mix: s.mix.map((p) => ({ ...p, hp: hp(p.hp) })) } : {}),
  });
  const monsters = template.map((m) => {
    const scaled: SpawnDef = { ...m, hp: hp(m.hp) };
    if (m.summons) scaled.summons = summons(m.summons);
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
    delay: at(77),
    x: 0.4,
    spread: 0.3,
    summons: summons(spec.summons),
  });
  return {
    id: spec.id,
    name: spec.name,
    mode: 'stationary',
    startCount: 1,
    weapon: spec.weapon ?? 'pistol',
    lane: {
      side: spec.side,
      elements: [
        ...lane(spec.opening, (x) => x),
        ...lane(spec.ladder, (x) => Math.min(MAX_BLOCK, nice(x * spec.k))),
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
