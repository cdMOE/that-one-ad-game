import { GATE_OPS, type GateEffect, type GateOp } from '../core/rules';
import {
  LEVEL_MODES,
  MONSTER_KINDS,
  OBSTACLE_KINDS,
  SPAWN_SIDES,
  UPGRADE_STATS,
  WEAPON_IDS,
  type ChoiceDef,
  type MonsterKind,
  type SpawnDef,
  type SpawnSide,
  type StationaryLevel,
  type StationaryObstacleDef,
  type UpgradeStat,
  type WaveDef,
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

const STATIONARY_KEYS = ['id', 'name', 'mode', 'startCount', 'weapon', 'waves'] as const;

function readSpawns(r: Reader, v: unknown, path: string): SpawnDef[] {
  const out: SpawnDef[] = [];
  (r.arr(v, path, { min: 1, max: 20 }) ?? []).forEach((item, i) => {
    const p = `${path}[${i}]`;
    const o = r.obj(item, p, ['kind', 'count', 'hp', 'from', 'interval', 'delay']);
    if (!o) return;
    const kind = r.oneOf<MonsterKind>(o.kind, `${p}.kind`, MONSTER_KINDS);
    const count = r.num(o.count, `${p}.count`, { min: 1, max: 300, int: true });
    const hp = r.num(o.hp, `${p}.hp`, { above: 0, max: 1_000_000 });
    const from = r.oneOf<SpawnSide>(o.from, `${p}.from`, SPAWN_SIDES);
    const interval = r.num(o.interval, `${p}.interval`, { min: 0.1, max: 30 });
    const delay = o.delay === undefined ? 0 : r.num(o.delay, `${p}.delay`, { min: 0, max: 120 });
    if (
      kind !== undefined &&
      count !== undefined &&
      hp !== undefined &&
      from !== undefined &&
      interval !== undefined &&
      delay !== undefined
    ) {
      out.push({ kind, count, hp, from, interval, delay });
    }
  });
  return out;
}

function readStationaryObstacles(r: Reader, v: unknown, path: string): StationaryObstacleDef[] {
  const out: StationaryObstacleDef[] = [];
  (r.arr(v, path, { max: 6 }) ?? []).forEach((item, i) => {
    const p = `${path}[${i}]`;
    const o = r.obj(item, p, ['x', 'y', 'hp', 'width', 'required', 'reward', 'drift', 'damage']);
    if (!o) return;
    const x = r.num(o.x, `${p}.x`, { min: -1, max: 1 });
    const y = r.num(o.y, `${p}.y`, { min: 3, max: 16 });
    const hp = r.num(o.hp, `${p}.hp`, { min: 1, max: 1_000_000, int: true });
    const width = o.width === undefined ? 2.4 : r.num(o.width, `${p}.width`, { min: 1, max: 6 });
    const drift = o.drift === undefined ? 0 : r.num(o.drift, `${p}.drift`, { min: 0, max: 2 });
    const damage =
      o.damage === undefined ? 5 : r.num(o.damage, `${p}.damage`, { min: 1, int: true });
    if (o.required !== undefined && typeof o.required !== 'boolean') {
      r.fail(`${p}.required`, 'expected true or false');
    }
    const reward = o.reward === undefined ? undefined : readGate(r, o.reward, `${p}.reward`);
    if (
      x !== undefined &&
      y !== undefined &&
      hp !== undefined &&
      width !== undefined &&
      drift !== undefined &&
      damage !== undefined
    ) {
      out.push({
        x,
        y,
        hp,
        width,
        required: o.required !== false,
        drift,
        damage,
        ...(reward ? { reward } : {}),
      });
    }
  });
  return out;
}

function readChoices(r: Reader, v: unknown, path: string): ChoiceDef[] {
  const out: ChoiceDef[] = [];
  (r.arr(v, path, { min: 2, max: 3 }) ?? []).forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (typeof item !== 'object' || item === null) {
      r.fail(p, 'expected an object');
      return;
    }
    const kind = r.oneOf('kind' in item ? (item as Rec).kind : undefined, `${p}.kind`, [
      'crowd',
      'upgrade',
      'weapon',
    ] as const);
    if (kind === 'crowd') {
      const o = r.obj(item, p, ['kind', 'op', 'value']);
      if (!o) return;
      const gate = readGate(r, { op: o.op, value: o.value }, p);
      if (gate) out.push({ kind: 'crowd', ...gate });
    } else if (kind === 'upgrade') {
      const o = r.obj(item, p, ['kind', 'stat', 'value']);
      if (!o) return;
      const stat = r.oneOf<UpgradeStat>(o.stat, `${p}.stat`, UPGRADE_STATS);
      const value = r.num(o.value, `${p}.value`, { above: 0, max: 10 });
      if (stat && value !== undefined) {
        if (stat === 'pellets' && !Number.isInteger(value))
          r.fail(`${p}.value`, 'pellets must be an integer');
        out.push({ kind: 'upgrade', stat, value });
      }
    } else if (kind === 'weapon') {
      const o = r.obj(item, p, ['kind', 'weapon']);
      if (!o) return;
      const weapon = r.oneOf<WeaponId>(o.weapon, `${p}.weapon`, WEAPON_IDS);
      if (weapon) out.push({ kind: 'weapon', weapon });
    }
  });
  return out;
}

function readStationary(r: Reader, o: Rec): StationaryLevel | undefined {
  r.obj(o, '', STATIONARY_KEYS);
  const id = r.str(o.id, 'id');
  const name = r.str(o.name, 'name');
  const startCount = r.num(o.startCount, 'startCount', { min: 1, int: true });
  const weapon = r.oneOf<WeaponId>(o.weapon, 'weapon', WEAPON_IDS);
  const waves: WaveDef[] = [];
  (r.arr(o.waves, 'waves', { min: 1, max: 30 }) ?? []).forEach((item, i) => {
    const p = `waves[${i}]`;
    const w = r.obj(item, p, ['monsters', 'obstacles', 'choices']);
    if (!w) return;
    const monsters = readSpawns(r, w.monsters, `${p}.monsters`);
    const obstacles =
      w.obstacles === undefined ? [] : readStationaryObstacles(r, w.obstacles, `${p}.obstacles`);
    const choices = w.choices === undefined ? [] : readChoices(r, w.choices, `${p}.choices`);
    waves.push({ monsters, obstacles, choices });
  });
  if (id === undefined || name === undefined || startCount === undefined || weapon === undefined) {
    return undefined;
  }
  return { id, name, mode: 'stationary', startCount, weapon, waves };
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
