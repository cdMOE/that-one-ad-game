import { applyGate, clampCount, type GateEffect } from '../../core/rules';
import { formationSpacing, visibleFor } from '../../core/swarm';
import type { ChoiceDef, MonsterKind, SpawnSide, StationaryLevel } from '../../levels/schema';
import { applyUpgrade, effectiveWeapon, newWeaponState, type WeaponState } from './weapons';

/**
 * Headless simulation of the stationary shooter. It has no DOM, canvas or sound, so the
 * same code runs in the game, in unit tests and in the level-validation bot. The view
 * (stationary.ts) only reads its state and reacts to the hooks.
 *
 * World: the squad stands at (0, 0); y grows "up" the screen. Monsters walk straight
 * at the squad from the left, right or top edge.
 */

export const ARENA = { halfWidth: 6, spawnX: 7.2, spawnTop: 19, muzzle: 0.9 };

export interface MonsterStats {
  speed: number;
  radius: number;
  /** Squad units lost when it reaches the squad. */
  bite: number;
}

export const MONSTERS: Record<MonsterKind, MonsterStats> = {
  grunt: { speed: 1.7, radius: 0.45, bite: 1 },
  runner: { speed: 3.4, radius: 0.34, bite: 1 },
  tank: { speed: 0.9, radius: 0.8, bite: 4 },
  boss: { speed: 0.55, radius: 1.7, bite: 25 },
};
export const MONSTER_KIND_INDEX: Record<MonsterKind, number> = {
  grunt: 0,
  runner: 1,
  tank: 2,
  boss: 3,
};
export const MONSTER_KIND_BY_INDEX: MonsterKind[] = ['grunt', 'runner', 'tank', 'boss'];

export const MAX_MONSTERS = 160;
export const MAX_BULLETS = 320;
const BULLET_LIFE = 1.4;
const OBSTACLE_HEIGHT = 1.3;

export type SimPhase = 'gap' | 'fighting' | 'choosing' | 'won' | 'lost';

export interface ObstacleState {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  width: number;
  height: number;
  required: boolean;
  reward?: GateEffect;
  drift: number;
  damage: number;
  alive: boolean;
  /** 1 right after a hit, decays in the view. */
  flash: number;
}

export interface SimHooks {
  volley?(x: number, y: number, angle: number): void;
  hit?(x: number, y: number): void;
  kill?(x: number, y: number, kind: MonsterKind, radius: number): void;
  bite?(x: number, y: number, lost: number): void;
  obstacleHit?(o: ObstacleState): void;
  /** `delta` is the squad change from the reward (0 if none). */
  obstacleBreak?(o: ObstacleState, delta: number, crashed: boolean): void;
  waveStart?(index: number, total: number): void;
  waveClear?(): void;
  choices?(choices: ChoiceDef[]): void;
  chosen?(choice: ChoiceDef): void;
  ended?(won: boolean): void;
}

interface Spawn {
  t: number;
  kind: MonsterKind;
  hp: number;
  from: SpawnSide;
}

/** Closest approach of a bullet's segment to a circle; returns the segment parameter or -1. */
function segmentCircle(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  r: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((cx - x0) * dx + (cy - y0) * dy) / len2));
  const px = x0 + dx * u - cx;
  const py = y0 + dy * u - cy;
  return px * px + py * py <= r * r ? u : -1;
}

export class StationarySim {
  count: number;
  readonly weapon: WeaponState;
  phase: SimPhase = 'gap';
  waveIndex = -1;
  time = 0;
  /** Manual aim target (world coords). When null the squad auto-aims. */
  aim: { x: number; y: number } | null = null;
  /** Current barrel angle in radians (0 = right, PI/2 = up the screen). */
  aimAngle = Math.PI / 2;
  choiceList: ChoiceDef[] = [];
  obstacles: ObstacleState[] = [];
  kills = 0;

  // monsters (structure of arrays, fixed capacity)
  readonly mx = new Float32Array(MAX_MONSTERS);
  readonly my = new Float32Array(MAX_MONSTERS);
  readonly mhp = new Float32Array(MAX_MONSTERS);
  readonly mmax = new Float32Array(MAX_MONSTERS);
  readonly mkind = new Uint8Array(MAX_MONSTERS);
  readonly malive = new Uint8Array(MAX_MONSTERS);
  // bullets (ring buffer)
  readonly bx = new Float32Array(MAX_BULLETS);
  readonly by = new Float32Array(MAX_BULLETS);
  readonly bvx = new Float32Array(MAX_BULLETS);
  readonly bvy = new Float32Array(MAX_BULLETS);
  readonly bdmg = new Float32Array(MAX_BULLETS);
  readonly blife = new Float32Array(MAX_BULLETS);

  private bulletHead = 0;
  private gapTimer = 0.8;
  private waveTime = 0;
  private queue: Spawn[] = [];
  private queueIndex = 0;
  private waveTotal = 1;
  private waveDone = 0;
  private fireAcc = 0;

  constructor(
    readonly level: StationaryLevel,
    private readonly rng: () => number,
    readonly hooks: SimHooks = {},
  ) {
    this.count = level.startCount;
    this.weapon = newWeaponState(level.weapon);
  }

  get progress(): number {
    if (this.phase === 'won') return 1;
    const wave = Math.max(0, this.waveIndex);
    const within = Math.min(1, this.waveDone / this.waveTotal);
    return Math.min(1, (wave + within) / this.level.waves.length);
  }

  /** Radius of the squad's formation, used for contact checks. */
  playerRadius(): number {
    const n = visibleFor(this.count);
    return n === 0 ? 0 : formationSpacing(n, 2.6) * Math.sqrt(n);
  }

  get monstersAlive(): number {
    let n = 0;
    for (let i = 0; i < MAX_MONSTERS; i++) n += this.malive[i];
    return n;
  }

  update(dt: number): void {
    if (this.phase === 'won' || this.phase === 'lost') return;
    this.time += dt;
    this.updateBullets(dt);
    for (const o of this.obstacles) o.flash = Math.max(0, o.flash - dt * 6);
    if (this.phase === 'gap') {
      this.gapTimer -= dt;
      if (this.gapTimer <= 0) this.startWave(this.waveIndex + 1);
    } else if (this.phase === 'fighting') {
      this.updateFight(dt);
    }
  }

  /** Picks one of the offered cards (index into `choiceList`). */
  choose(i: number): void {
    if (this.phase !== 'choosing') return;
    const c = this.choiceList[i];
    if (!c) return;
    if (c.kind === 'crowd') this.count = applyGate(this.count, c);
    else if (c.kind === 'upgrade') applyUpgrade(this.weapon, c.stat, c.value);
    else this.weapon.id = c.weapon;
    this.hooks.chosen?.(c);
    this.phase = 'gap';
    this.gapTimer = 0.9;
  }

  // ---- waves --------------------------------------------------------------

  private startWave(n: number): void {
    if (n >= this.level.waves.length) {
      this.end(true);
      return;
    }
    const wave = this.level.waves[n];
    this.waveIndex = n;
    this.waveTime = 0;
    this.queue = [];
    this.queueIndex = 0;
    let total = 0;
    for (const s of wave.monsters) {
      for (let i = 0; i < s.count; i++) {
        this.queue.push({
          t: (s.delay ?? 0) + i * s.interval,
          kind: s.kind,
          hp: s.hp,
          from: s.from,
        });
      }
      total += s.count;
    }
    this.queue.sort((a, b) => a.t - b.t);
    this.obstacles = (wave.obstacles ?? []).map((o) => ({
      x: o.x * ARENA.halfWidth * 0.8,
      y: o.y,
      hp: o.hp,
      maxHp: o.hp,
      width: o.width ?? 2.4,
      height: OBSTACLE_HEIGHT,
      required: o.required !== false,
      ...(o.reward ? { reward: o.reward } : {}),
      drift: o.drift ?? 0,
      damage: o.damage ?? 5,
      alive: true,
      flash: 0,
    }));
    total += this.obstacles.filter((o) => o.required).length;
    this.waveTotal = Math.max(1, total);
    this.waveDone = 0;
    this.phase = 'fighting';
    this.hooks.waveStart?.(n, this.level.waves.length);
  }

  private clearWave(): void {
    this.obstacles = [];
    this.hooks.waveClear?.();
    const wave = this.level.waves[this.waveIndex];
    if (this.waveIndex + 1 >= this.level.waves.length) {
      this.end(true);
    } else if (wave.choices && wave.choices.length > 0) {
      this.phase = 'choosing';
      this.choiceList = wave.choices;
      this.hooks.choices?.(wave.choices);
    } else {
      this.phase = 'gap';
      this.gapTimer = 1;
    }
  }

  private end(won: boolean): void {
    this.phase = won ? 'won' : 'lost';
    this.hooks.ended?.(won);
  }

  // ---- fighting -----------------------------------------------------------

  private spawn(s: Spawn): void {
    let slot = -1;
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (!this.malive[i]) {
        slot = i;
        break;
      }
    }
    if (slot < 0) return; // pool full: drop the spawn rather than allocate
    let x: number;
    let y: number;
    if (s.from === 'right') {
      x = ARENA.spawnX;
      y = 1.5 + this.rng() * 10;
    } else if (s.from === 'left') {
      x = -ARENA.spawnX;
      y = 1.5 + this.rng() * 10;
    } else {
      x = (this.rng() * 2 - 1) * 4.6;
      y = ARENA.spawnTop;
    }
    this.mx[slot] = x;
    this.my[slot] = y;
    this.mhp[slot] = s.hp;
    this.mmax[slot] = s.hp;
    this.mkind[slot] = MONSTER_KIND_INDEX[s.kind];
    this.malive[slot] = 1;
  }

  private updateFight(dt: number): void {
    this.waveTime += dt;
    while (this.queueIndex < this.queue.length && this.queue[this.queueIndex].t <= this.waveTime) {
      this.spawn(this.queue[this.queueIndex++]);
    }

    const pr = this.playerRadius();
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (!this.malive[i]) continue;
      const stats = MONSTERS[MONSTER_KIND_BY_INDEX[this.mkind[i]]];
      const x = this.mx[i];
      const y = this.my[i];
      const d = Math.hypot(x, y);
      if (d < pr * 0.8 + stats.radius) {
        this.malive[i] = 0;
        this.waveDone++;
        this.count = clampCount(this.count - stats.bite);
        this.hooks.bite?.(x, y, stats.bite);
        if (this.count <= 0) {
          this.end(false);
          return;
        }
        continue;
      }
      const step = Math.min(d, stats.speed * dt);
      this.mx[i] = x - (x / d) * step;
      this.my[i] = y - (y / d) * step;
    }

    for (const o of this.obstacles) {
      if (!o.alive || o.drift <= 0) continue;
      o.y -= o.drift * dt;
      if (o.y - o.height / 2 < pr * 0.8) {
        o.alive = false;
        this.count = clampCount(this.count - o.damage);
        if (o.required) this.waveDone++;
        this.hooks.obstacleBreak?.(o, -o.damage, true);
        if (this.count <= 0) {
          this.end(false);
          return;
        }
      }
    }

    this.fire(dt);

    if (
      this.queueIndex >= this.queue.length &&
      this.monstersAlive === 0 &&
      !this.obstacles.some((o) => o.alive && o.required)
    ) {
      this.clearWave();
    }
  }

  /** Nearest visible monster; else the nearest required obstacle; else null. */
  autoTarget(): { x: number; y: number } | null {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (!this.malive[i]) continue;
      const x = this.mx[i];
      const y = this.my[i];
      if (Math.abs(x) > 6.4 || y > 18) continue; // not on screen yet
      const d = Math.hypot(x, y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) return { x: this.mx[best], y: this.my[best] };
    let target: ObstacleState | null = null;
    for (const o of this.obstacles) {
      if (!o.alive) continue;
      if (!target || (o.required && !target.required) || o.y < target.y) target = o;
    }
    return target ? { x: target.x, y: target.y } : null;
  }

  /** Distance of the nearest monster that is already on screen (Infinity if none). */
  nearestMonsterDistance(): number {
    let best = Infinity;
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (!this.malive[i]) continue;
      best = Math.min(best, Math.hypot(this.mx[i], this.my[i]));
    }
    return best;
  }

  private fire(dt: number): void {
    const w = effectiveWeapon(this.weapon);
    const target = this.aim ?? this.autoTarget();
    if (target) {
      const want = Math.atan2(target.y, target.x);
      let diff = want - this.aimAngle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.aimAngle += diff * Math.min(1, 16 * dt);
    }
    this.fireAcc = Math.min(this.fireAcc + w.rate * dt, 2);
    if (!target) {
      this.fireAcc = Math.min(this.fireAcc, 1);
      return;
    }
    while (this.fireAcc >= 1) {
      this.fireAcc -= 1;
      const pellets = Math.max(1, w.pellets);
      const damage = (w.total * this.count) / pellets;
      for (let p = 0; p < pellets; p++) {
        const fan = pellets > 1 ? (p / (pellets - 1) - 0.5) * w.spread : 0;
        const a = this.aimAngle + fan + (this.rng() - 0.5) * w.jitter;
        const i = this.bulletHead;
        this.bulletHead = (this.bulletHead + 1) % MAX_BULLETS;
        this.bx[i] = Math.cos(a) * ARENA.muzzle;
        this.by[i] = Math.sin(a) * ARENA.muzzle;
        this.bvx[i] = Math.cos(a) * w.speed;
        this.bvy[i] = Math.sin(a) * w.speed;
        this.bdmg[i] = damage;
        this.blife[i] = BULLET_LIFE;
      }
      this.hooks.volley?.(
        Math.cos(this.aimAngle) * ARENA.muzzle,
        Math.sin(this.aimAngle) * ARENA.muzzle,
        this.aimAngle,
      );
    }
  }

  private updateBullets(dt: number): void {
    for (let i = 0; i < MAX_BULLETS; i++) {
      if (this.blife[i] <= 0) continue;
      this.blife[i] -= dt;
      const x0 = this.bx[i];
      const y0 = this.by[i];
      const x1 = x0 + this.bvx[i] * dt;
      const y1 = y0 + this.bvy[i] * dt;
      this.bx[i] = x1;
      this.by[i] = y1;
      if (Math.abs(x1) > 9 || y1 > 22 || y1 < -6) {
        this.blife[i] = 0;
        continue;
      }
      if (this.collide(i, x0, y0, x1, y1)) this.blife[i] = 0;
    }
  }

  /** Applies a bullet's damage to the first thing its path touches. Returns true if it hit. */
  private collide(i: number, x0: number, y0: number, x1: number, y1: number): boolean {
    let bestT = 2;
    let monster = -1;
    for (let m = 0; m < MAX_MONSTERS; m++) {
      if (!this.malive[m]) continue;
      const r = MONSTERS[MONSTER_KIND_BY_INDEX[this.mkind[m]]].radius + 0.12;
      const t = segmentCircle(x0, y0, x1, y1, this.mx[m], this.my[m], r);
      if (t >= 0 && t < bestT) {
        bestT = t;
        monster = m;
      }
    }
    let obstacle: ObstacleState | null = null;
    for (const o of this.obstacles) {
      if (!o.alive) continue;
      for (let k = 1; k <= 4; k++) {
        const t = k / 4;
        const px = x0 + (x1 - x0) * t;
        const py = y0 + (y1 - y0) * t;
        if (Math.abs(px - o.x) <= o.width / 2 && Math.abs(py - o.y) <= o.height / 2) {
          if (t < bestT) {
            bestT = t;
            obstacle = o;
            monster = -1;
          }
          break;
        }
      }
    }
    const dmg = this.bdmg[i];
    if (obstacle) {
      obstacle.hp -= dmg;
      obstacle.flash = 1;
      this.hooks.obstacleHit?.(obstacle);
      if (obstacle.hp <= 0) {
        obstacle.alive = false;
        if (obstacle.required) this.waveDone++;
        const before = this.count;
        if (obstacle.reward) this.count = applyGate(this.count, obstacle.reward);
        this.hooks.obstacleBreak?.(obstacle, this.count - before, false);
      }
      return true;
    }
    if (monster >= 0) {
      const kind = MONSTER_KIND_BY_INDEX[this.mkind[monster]];
      this.mhp[monster] -= dmg;
      if (this.mhp[monster] <= 0) {
        this.malive[monster] = 0;
        this.waveDone++;
        this.kills++;
        this.hooks.kill?.(this.mx[monster], this.my[monster], kind, MONSTERS[kind].radius);
      } else {
        this.hooks.hit?.(this.mx[monster], this.my[monster]);
      }
      return true;
    }
    return false;
  }
}
