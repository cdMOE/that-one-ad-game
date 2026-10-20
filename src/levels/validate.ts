import { GATE_OPS, type GateEffect, type GateOp } from '../core/rules';
import {
  LEVEL_MODES,
  MONSTER_KINDS,
  OBSTACLE_KINDS,
  UPGRADE_STATS,
  WEAPON_IDS,
  type ItemDef,
  type MonsterKind,
  type SpawnDef,
  type StationaryLevel,
  type LaneDef,
  type LaneElementDef,
  type UpgradeStat,
  type WeaponId,
  type BossDef,
  type EnemyDef,
  type GateRowDef,
  type Level,
  type ObstacleDef,
  type ObstacleKind,
  type RunnerLevel,
} from './schema';

export type ValidationResult = { ok: true; level: Level } | { ok: false; errors: string[] };

type Rec = Record<string, unknown>;

interface NumOpts {
  min?: number;
  max?: number;
  /** Strict lower bound. */
  above?: number;
  int?: boolean;
}

/**
 * Hand-rolled validation: a few helpers that collect every problem with a readable
 * path ("gates[2].options[0].op: ...") instead of failing on the first one. No
 * dependencies, so it also runs in the plain Node level-check script.
 */
class Reader {
  readonly errors: string[] = [];

  fail(path: string, msg: string): void {
    this.errors.push(`${path || '(root)'}: ${msg}`);
  }

  obj(v: unknown, path: string, allowed: readonly string[]): Rec | undefined {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      this.fail(path, 'expected an object');
      return undefined;
    }
    for (const key of Object.keys(v)) {
      if (!allowed.includes(key)) {
        this.fail(
          `${path}${path ? '.' : ''}${key}`,
          `unknown key (allowed: ${allowed.join(', ')})`,
        );
      }
    }
    return v as Rec;
  }

  arr(v: unknown, path: string, opts: { min?: number; max?: number } = {}): unknown[] | undefined {
    if (!Array.isArray(v)) {
      this.fail(path, 'expected an array');
      return undefined;
    }
    if (opts.min !== undefined && v.length < opts.min)
      this.fail(path, `needs at least ${opts.min} item(s)`);
    if (opts.max !== undefined && v.length > opts.max)
      this.fail(path, `allows at most ${opts.max} item(s)`);
    return v;
  }

  num(v: unknown, path: string, o: NumOpts = {}): number | undefined {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.fail(path, 'expected a number');
      return undefined;
    }
    if (o.int && !Number.isInteger(v)) this.fail(path, `expected an integer, got ${v}`);
    if (o.min !== undefined && v < o.min) this.fail(path, `must be >= ${o.min}, got ${v}`);
    if (o.max !== undefined && v > o.max) this.fail(path, `must be <= ${o.max}, got ${v}`);
    if (o.above !== undefined && v <= o.above) this.fail(path, `must be > ${o.above}, got ${v}`);
    return v;
  }

  str(v: unknown, path: string): string | undefined {
    if (typeof v !== 'string' || v.trim() === '') {
      this.fail(path, 'expected a non-empty string');
      return undefined;
    }
    return v;
  }

  oneOf<T extends string>(v: unknown, path: string, options: readonly T[]): T | undefined {
    if (typeof v !== 'string' || !options.includes(v as T)) {
      this.fail(path, `expected one of ${options.map((o) => JSON.stringify(o)).join(', ')}`);
      return undefined;
    }
    return v as T;
  }
}

function readGate(r: Reader, v: unknown, path: string): GateEffect | undefined {
  const o = r.obj(v, path, ['op', 'value']);
  if (!o) return undefined;
  const op = r.oneOf<GateOp>(o.op, `${path}.op`, GATE_OPS);
  const value = r.num(o.value, `${path}.value`, { above: 0 });
  if (op && value !== undefined) {
    if ((op === '+' || op === '-') && !Number.isInteger(value)) {
      r.fail(`${path}.value`, 'must be an integer for + and -');
    }
    return { op, value };
  }
  return undefined;
}

function readGateRows(r: Reader, v: unknown, path: string, length: number): GateRowDef[] {
  const rows: GateRowDef[] = [];
  (r.arr(v, path) ?? []).forEach((item, i) => {
    const p = `${path}[${i}]`;
    const o = r.obj(item, p, ['at', 'options']);
    if (!o) return;
    const at = r.num(o.at, `${p}.at`, { above: 0, max: length });
    const options: GateEffect[] = [];
    (r.arr(o.options, `${p}.options`, { min: 1, max: 3 }) ?? []).forEach((g, j) => {
      const gate = readGate(r, g, `${p}.options[${j}]`);
      if (gate) options.push(gate);
    });
    if (at !== undefined) rows.push({ at, options });
  });
  return rows;
}

function readEnemies(r: Reader, v: unknown, path: string, length: number): EnemyDef[] {
  const out: EnemyDef[] = [];
  (r.arr(v, path) ?? []).forEach((item, i) => {
    const p = `${path}[${i}]`;
    const o = r.obj(item, p, ['at', 'count', 'x']);
    if (!o) return;
    // Enemies must come before the boss/finish at `length`.
    const at = r.num(o.at, `${p}.at`, { above: 0, max: length - 1 });
    const count = r.num(o.count, `${p}.count`, { min: 1, int: true });
    const x = o.x === undefined ? 0 : r.num(o.x, `${p}.x`, { min: -1, max: 1 });
    if (at !== undefined && count !== undefined && x !== undefined) out.push({ at, count, x });
  });
  return out;
}

function readObstacles(r: Reader, v: unknown, path: string, length: number): ObstacleDef[] {
  const out: ObstacleDef[] = [];
  (r.arr(v, path) ?? []).forEach((item, i) => {
    const p = `${path}[${i}]`;
    const o = r.obj(item, p, ['at', 'kind', 'x', 'width', 'damage', 'sway']);
    if (!o) return;
    const at = r.num(o.at, `${p}.at`, { above: 0, max: length });
    const kind = r.oneOf<ObstacleKind>(o.kind, `${p}.kind`, OBSTACLE_KINDS);
    const x = r.num(o.x, `${p}.x`, { min: -1, max: 1 });
    const width = r.num(o.width, `${p}.width`, { min: 0.1, max: 1 });
    const damage = r.num(o.damage, `${p}.damage`, { min: 1, int: true });
    let sway: ObstacleDef['sway'];
    if (o.sway !== undefined) {
      const s = r.obj(o.sway, `${p}.sway`, ['amplitude', 'speed']);
      if (s) {
        const amplitude = r.num(s.amplitude, `${p}.sway.amplitude`, { above: 0, max: 1 });
        const speed = r.num(s.speed, `${p}.sway.speed`, { above: 0, max: 10 });
        if (amplitude !== undefined && speed !== undefined) sway = { amplitude, speed };
      }
    }
    if (
      at !== undefined &&
      kind !== undefined &&
      x !== undefined &&
      width !== undefined &&
      damage !== undefined
    ) {
      out.push({ at, kind, x, width, damage, ...(sway ? { sway } : {}) });
    }
  });
  return out;
}

function readBoss(r: Reader, v: unknown, path: string): BossDef | undefined {
  const o = r.obj(v, path, ['count', 'name']);
  if (!o) return undefined;
  const count = r.num(o.count, `${path}.count`, { min: 1, int: true });
  const name = o.name === undefined ? undefined : r.str(o.name, `${path}.name`);
  if (count === undefined) return undefined;
  return name ? { count, name } : { count };
}

const RUNNER_KEYS = [
  'id',
  'name',
  'mode',
  'startCount',
  'length',
  'speed',
  'gates',
  'enemies',
  'obstacles',
  'boss',
] as const;

function readRunner(r: Reader, o: Rec): RunnerLevel | undefined {
  r.obj(o, '', RUNNER_KEYS); // reports unknown keys
  const id = r.str(o.id, 'id');
  const name = r.str(o.name, 'name');
  const startCount = r.num(o.startCount, 'startCount', { min: 1, int: true });
  const length = r.num(o.length, 'length', { min: 20, max: 2000 });
  const speed = o.speed === undefined ? undefined : r.num(o.speed, 'speed', { min: 2, max: 14 });
  if (length === undefined) return undefined;
  const gates = readGateRows(r, o.gates ?? [], 'gates', length);
  const enemies = readEnemies(r, o.enemies ?? [], 'enemies', length);
  const obstacles = readObstacles(r, o.obstacles ?? [], 'obstacles', length);
  const boss = o.boss === undefined ? undefined : readBoss(r, o.boss, 'boss');
  if (id === undefined || name === undefined || startCount === undefined) return undefined;
  return {
    id,
    name,
    mode: 'runner',
    startCount,
    length,
    ...(speed !== undefined ? { speed } : {}),
    gates: gates.sort((a, b) => a.at - b.at),
    enemies: enemies.sort((a, b) => a.at - b.at),
    obstacles: obstacles.sort((a, b) => a.at - b.at),
    ...(boss ? { boss } : {}),
  };
}

const STATIONARY_KEYS = [
  'id',
  'name',
  'mode',
  'startCount',
  'weapon',
  'lanes',
  'monsters',
] as const;

function readSpawns(r: Reader, v: unknown, path: string): SpawnDef[] {
  const out: SpawnDef[] = [];
  (r.arr(v, path, { min: 1, max: 60 }) ?? []).forEach((item, i) => {
    const p = `${path}[${i}]`;
    const o = r.obj(item, p, ['kind', 'count', 'hp', 'interval', 'delay', 'x', 'spread']);
    if (!o) return;
    const kind = r.oneOf<MonsterKind>(o.kind, `${p}.kind`, MONSTER_KINDS);
    const count = r.num(o.count, `${p}.count`, { min: 1, max: 300, int: true });
    const hp = r.num(o.hp, `${p}.hp`, { above: 0, max: 1_000_000 });
    const interval = r.num(o.interval, `${p}.interval`, { min: 0.1, max: 30 });
    const delay = o.delay === undefined ? 0 : r.num(o.delay, `${p}.delay`, { min: 0, max: 120 });
    const x = o.x === undefined ? 0.6 : r.num(o.x, `${p}.x`, { min: -1, max: 1 });
    const spread =
      o.spread === undefined ? 0.25 : r.num(o.spread, `${p}.spread`, { min: 0, max: 1 });
    if (
      kind !== undefined &&
      count !== undefined &&
      hp !== undefined &&
      interval !== undefined &&
      delay !== undefined &&
      x !== undefined &&
      spread !== undefined
    ) {
      out.push({ kind, count, hp, interval, delay, x, spread });
    }
  });
  return out;
}

function readItem(r: Reader, v: unknown, path: string): ItemDef | undefined {
  if (typeof v !== 'object' || v === null) {
    r.fail(path, 'expected an object');
    return undefined;
  }
  const kind = r.oneOf('kind' in v ? (v as Rec).kind : undefined, `${path}.kind`, [
    'crowd',
    'upgrade',
    'weapon',
  ] as const);
  if (kind === 'crowd') {
    const o = r.obj(v, path, ['kind', 'op', 'value']);
    if (!o) return undefined;
    const gate = readGate(r, { op: o.op, value: o.value }, path);
    return gate ? { kind: 'crowd', ...gate } : undefined;
  }
  if (kind === 'upgrade') {
    const o = r.obj(v, path, ['kind', 'stat', 'value']);
    if (!o) return undefined;
    const stat = r.oneOf<UpgradeStat>(o.stat, `${path}.stat`, UPGRADE_STATS);
    const value = r.num(o.value, `${path}.value`, { above: 0, max: 10 });
    if (!stat || value === undefined) return undefined;
    if (stat === 'pellets' && !Number.isInteger(value)) {
      r.fail(`${path}.value`, 'pellets must be an integer');
    }
    return { kind: 'upgrade', stat, value };
  }
  if (kind === 'weapon') {
    const o = r.obj(v, path, ['kind', 'weapon']);
    if (!o) return undefined;
    const weapon = r.oneOf<WeaponId>(o.weapon, `${path}.weapon`, WEAPON_IDS);
    return weapon ? { kind: 'weapon', weapon } : undefined;
  }
  return undefined;
}

function readLanes(r: Reader, v: unknown, path: string): LaneDef[] {
  const out: LaneDef[] = [];
  (r.arr(v, path, { min: 1, max: 2 }) ?? []).forEach((item, i) => {
    const p = `${path}[${i}]`;
    const o = r.obj(item, p, ['x', 'width', 'elements']);
    if (!o) return;
    const x = r.num(o.x, `${p}.x`, { min: -1, max: 1 });
    const width = o.width === undefined ? 3.6 : r.num(o.width, `${p}.width`, { min: 1, max: 8 });
    const elements: LaneElementDef[] = [];
    (r.arr(o.elements, `${p}.elements`, { min: 1, max: 60 }) ?? []).forEach((el, j) => {
      const ep = `${p}.elements[${j}]`;
      if (typeof el !== 'object' || el === null) {
        r.fail(ep, 'expected an object');
        return;
      }
      const type = r.oneOf('type' in el ? (el as Rec).type : undefined, `${ep}.type`, [
        'block',
        'item',
      ] as const);
      if (type === 'block') {
        const b = r.obj(el, ep, ['type', 'hp', 'grow']);
        if (!b) return;
        const hp = r.num(b.hp, `${ep}.hp`, { min: 1, max: 1_000_000, int: true });
        const grow = b.grow === undefined ? 0 : r.num(b.grow, `${ep}.grow`, { min: 0, max: 1000 });
        if (hp !== undefined && grow !== undefined) elements.push({ type: 'block', hp, grow });
      } else if (type === 'item') {
        const it = r.obj(el, ep, ['type', 'item']);
        if (!it) return;
        const def = readItem(r, it.item, `${ep}.item`);
        if (def) elements.push({ type: 'item', item: def });
      }
    });
    if (x !== undefined && width !== undefined) out.push({ x, width, elements });
  });
  return out;
}

function readStationary(r: Reader, o: Rec): StationaryLevel | undefined {
  r.obj(o, '', STATIONARY_KEYS);
  const id = r.str(o.id, 'id');
  const name = r.str(o.name, 'name');
  const startCount = r.num(o.startCount, 'startCount', { min: 1, int: true });
  const weapon = r.oneOf<WeaponId>(o.weapon, 'weapon', WEAPON_IDS);
  const lanes = readLanes(r, o.lanes, 'lanes');
  const monsters = readSpawns(r, o.monsters, 'monsters');
  if (id === undefined || name === undefined || startCount === undefined || weapon === undefined) {
    return undefined;
  }
  return { id, name, mode: 'stationary', startCount, weapon, lanes, monsters };
}

/** Per-mode readers. Register new modes here (and in schema.ts / modes/index.ts). */
const MODE_READERS: Record<string, (r: Reader, o: Rec) => Level | undefined> = {
  runner: readRunner,
  stationary: readStationary,
};

/** Validates untrusted JSON and returns a typed level or a list of readable errors. */
export function validateLevel(data: unknown): ValidationResult {
  const r = new Reader();
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, errors: ['(root): expected an object'] };
  }
  const o = data as Rec;
  const mode = r.oneOf('mode' in o ? o.mode : undefined, 'mode', LEVEL_MODES);
  if (!mode) return { ok: false, errors: r.errors };
  const reader = MODE_READERS[mode];
  const level = reader?.(r, o);
  if (r.errors.length > 0 || !level) {
    return { ok: false, errors: r.errors.length > 0 ? r.errors : ['level could not be read'] };
  }
  return { ok: true, level };
}
