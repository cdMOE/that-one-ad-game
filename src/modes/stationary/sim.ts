import { applyGate, clampCount } from '../../core/rules';
import { gridSlotX, gridSlotY } from '../../core/swarm';
import type { ItemDef, MonsterKind, StationaryLevel } from '../../levels/schema';
import { applyUpgrade, effectiveWeapon, newWeaponState, type WeaponState } from './weapons';

/**
 * Headless simulation of the stationary shooter. It has no DOM, canvas or sound, so the
 * same code runs in the game, in unit tests and in the level-validation bot. The view
 * (stationary.ts) only reads its state and reacts to the hooks.
 *
 * World: the squad is a phalanx at the bottom that slides left and right; y grows "up"
 * the screen. Every soldier fires its own bullet straight ahead and the bullet keeps part
 * of the soldier's sideways speed, so moving the squad sweeps the fire across the field.
 * Monsters walk down from the top towards the squad; blocks with a hit-point counter stop
 * bullets and hide power-ups that fall towards the squad once the block breaks.
 */

export const ARENA = { halfWidth: 6, spawnTop: 19 };
/** Distance between neighbouring soldiers; also the size of the formation grid. */
export const SOLDIER_SPACING = 0.46;
export const GRID_COLS = 8;
/** At most this many soldiers are simulated and drawn; bigger squads hit harder per bullet. */
export const MAX_SHOOTERS = 40;
/** How much of the squad's sideways speed a bullet inherits. */
export const BULLET_INHERIT = 0.8;
const SQUAD_MAX_SPEED = 13;
const ITEM_FALL_SPEED = 2.4;
const OBSTACLE_HEIGHT = 1.3;
/** Coins for smashing a block. */
const BLOCK_COINS = 15;
const BULLET_LIFE = 1.3;

export interface MonsterStats {
  speed: number;
  radius: number;
  /** Squad soldiers lost when it reaches the squad. */
  bite: number;
  /** Coins dropped when it dies (before the coin-bonus upgrade). */
  coins: number;
}

export const MONSTERS: Record<MonsterKind, MonsterStats> = {
  grunt: { speed: 2.3, radius: 0.45, bite: 1, coins: 3 },
  runner: { speed: 4.2, radius: 0.34, bite: 1, coins: 4 },
  tank: { speed: 1.3, radius: 0.8, bite: 4, coins: 15 },
  boss: { speed: 0.8, radius: 1.7, bite: 20, coins: 150 },
};
export const MONSTER_KIND_BY_INDEX: MonsterKind[] = ['grunt', 'runner', 'tank', 'boss'];
const MONSTER_KIND_INDEX: Record<MonsterKind, number> = { grunt: 0, runner: 1, tank: 2, boss: 3 };

export const MAX_MONSTERS = 120;
export const MAX_BULLETS = 700;

export type SimPhase = 'gap' | 'fighting' | 'won' | 'lost';

export interface ObstacleState {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  width: number;
  height: number;
  grow: number;
  item?: ItemDef;
  alive: boolean;
  /** 1 right after a hit, decays in the view. */
  flash: number;
}

/** A power-up on its way down to the squad. */
export interface ItemState {
  x: number;
  y: number;
  def: ItemDef;
}

export interface SimHooks {
  /** A soldier fired; (x, y) is the muzzle position. Called once per bullet batch. */
  shot?(x: number, y: number): void;
  hit?(x: number, y: number): void;
  kill?(x: number, y: number, kind: MonsterKind, radius: number): void;
  /** Coins dropped at a position (raw amount, before the coin-bonus upgrade). */
  coin?(x: number, y: number, amount: number): void;
  bite?(x: number, y: number, lost: number): void;
  obstacleHit?(x: number, y: number): void;
  obstacleBreak?(o: ObstacleState): void;
  itemCollected?(item: ItemState, delta: number): void;
  itemLost?(item: ItemState): void;
  waveStart?(index: number, total: number): void;
  waveClear?(): void;
  ended?(won: boolean): void;
}

interface Spawn {
  t: number;
  kind: MonsterKind;
  hp: number;
  x: number;
  spread: number;
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

/** Permanent-upgrade multipliers applied to the starting weapon. */
export interface SimOptions {
  damageMul: number;
  rateMul: number;
}

export class StationarySim {
  count: number;
  readonly weapon: WeaponState;
  phase: SimPhase = 'gap';
  waveIndex = -1;
  time = 0;
  kills = 0;
  /** Coins earned so far, before the coin-bonus upgrade. */
  coinsRaw = 0;

  /** Where the player wants the squad (world x). The squad slides there. */
  targetX = 0;
  squadX = 0;
  squadVx = 0;

  obstacles: ObstacleState[] = [];
  items: ItemState[] = [];

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

  private readonly fireAcc = new Float32Array(MAX_SHOOTERS);
  private readonly liveMonsters = new Int16Array(MAX_MONSTERS);
  private liveCount = 0;
  private bulletHead = 0;
  private gapTimer = 0.4;
  private waveTime = 0;
  private queue: Spawn[] = [];
  private queueIndex = 0;
  private waveTotal = 1;
  private waveDone = 0;

  constructor(
    readonly level: StationaryLevel,
    private readonly rng: () => number,
    readonly hooks: SimHooks = {},
    options: SimOptions = { damageMul: 1, rateMul: 1 },
  ) {
    this.count = level.startCount;
    this.weapon = newWeaponState(level.weapon);
    this.weapon.damageMul = options.damageMul;
    this.weapon.rateMul = options.rateMul;
    for (let i = 0; i < MAX_SHOOTERS; i++) this.fireAcc[i] = (i * 0.618) % 1; // stagger the guns
  }

  get progress(): number {
    if (this.phase === 'won') return 1;
    const wave = Math.max(0, this.waveIndex);
    const within = Math.min(1, this.waveDone / this.waveTotal);
    return Math.min(1, (wave + within) / this.level.waves.length);
  }

  /** Number of soldiers that are simulated and drawn (and fire). */
  get shooters(): number {
    return Math.min(this.count, MAX_SHOOTERS);
  }

  get cols(): number {
    return Math.max(1, Math.min(GRID_COLS, this.shooters));
  }

  /** Half the width of the formation, used to keep it inside the arena. */
  halfWidth(): number {
    return ((this.cols - 1) / 2) * SOLDIER_SPACING + 0.35;
  }

  /** World position of soldier `i` (0 = front row). */
  soldierX(i: number): number {
    return this.squadX + gridSlotX(i, this.shooters, this.cols) * SOLDIER_SPACING;
  }

  soldierY(i: number): number {
    return gridSlotY(i, this.cols) * SOLDIER_SPACING;
  }

  get monstersAlive(): number {
    let n = 0;
    for (let i = 0; i < MAX_MONSTERS; i++) n += this.malive[i];
    return n;
  }

  update(dt: number): void {
    if (this.phase === 'won' || this.phase === 'lost') return;
    this.time += dt;
    this.moveSquad(dt);
    this.updateBullets(dt);
    for (const o of this.obstacles) o.flash = Math.max(0, o.flash - dt * 6);
    if (this.phase === 'gap') {
      this.gapTimer -= dt;
      if (this.gapTimer <= 0) this.startWave(this.waveIndex + 1);
    } else {
      this.updateFight(dt);
    }
  }

  private moveSquad(dt: number): void {
    const limit = ARENA.halfWidth - this.halfWidth();
    const want = Math.max(-limit, Math.min(limit, this.targetX));
    const dx = want - this.squadX;
    const step = Math.max(
      -SQUAD_MAX_SPEED * dt,
      Math.min(SQUAD_MAX_SPEED * dt, dx * Math.min(1, 16 * dt)),
    );
    this.squadX += step;
    this.squadVx = dt > 0 ? step / dt : 0;
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
          x: s.x ?? 0.6,
          spread: s.spread ?? 0.25,
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
      width: o.width ?? 4.2,
      height: OBSTACLE_HEIGHT,
      grow: o.grow ?? 0,
      ...(o.item ? { item: o.item } : {}),
      alive: true,
      flash: 0,
    }));
    total += this.obstacles.length;
    this.items = [];
    this.waveTotal = Math.max(1, total);
    this.waveDone = 0;
    this.phase = 'fighting';
    this.hooks.waveStart?.(n, this.level.waves.length);
  }

  private clearWave(): void {
    this.hooks.waveClear?.();
    if (this.waveIndex + 1 >= this.level.waves.length) {
      this.end(true);
    } else {
      this.phase = 'gap';
      this.gapTimer = 0.5;
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
    const lane = s.x * ARENA.halfWidth + (this.rng() * 2 - 1) * s.spread * ARENA.halfWidth;
    this.mx[slot] = Math.max(-ARENA.halfWidth + 0.5, Math.min(ARENA.halfWidth - 0.5, lane));
    this.my[slot] = ARENA.spawnTop;
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

    // monsters walk straight at the squad
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (!this.malive[i]) continue;
      const stats = MONSTERS[MONSTER_KIND_BY_INDEX[this.mkind[i]]];
      const x = this.mx[i];
      const y = this.my[i];
      if (y <= 0.5 + stats.radius * 0.6) {
        this.malive[i] = 0;
        this.waveDone++;
        this.count = clampCount(this.count - stats.bite);
        this.hooks.bite?.(x, Math.max(0, y), stats.bite);
        if (this.count <= 0) {
          this.end(false);
          return;
        }
        continue;
      }
      const tx = this.squadX - x;
      const ty = -y;
      const d = Math.hypot(tx, ty);
      const step = Math.min(d, stats.speed * dt);
      this.mx[i] = x + (tx / d) * step;
      this.my[i] = y + (ty / d) * step;
    }

    for (const o of this.obstacles) {
      if (o.alive && o.grow > 0) {
        o.hp += o.grow * dt;
        o.maxHp = Math.max(o.maxHp, o.hp);
      }
    }

    this.updateItems(dt);
    this.fire(dt);

    if (
      this.queueIndex >= this.queue.length &&
      this.monstersAlive === 0 &&
      this.items.length === 0 &&
      !this.obstacles.some((o) => o.alive)
    ) {
      this.clearWave();
    }
  }

  private updateItems(dt: number): void {
    const hw = this.halfWidth();
    for (let k = this.items.length - 1; k >= 0; k--) {
      const item = this.items[k];
      item.y -= ITEM_FALL_SPEED * dt;
      if (item.y <= 1 && Math.abs(item.x - this.squadX) <= hw + 0.7) {
        this.items.splice(k, 1);
        const before = this.count;
        this.applyItem(item.def);
        this.hooks.itemCollected?.(item, this.count - before);
      } else if (item.y < -1.5) {
        this.items.splice(k, 1);
        this.hooks.itemLost?.(item);
      }
    }
  }

  private applyItem(def: ItemDef): void {
    if (def.kind === 'crowd') this.count = applyGate(this.count, def);
    else if (def.kind === 'upgrade') applyUpgrade(this.weapon, def.stat, def.value);
    else this.weapon.id = def.weapon;
  }

  /** Every soldier fires on its own clock; bullets keep part of the squad's sideways speed. */
  private fire(dt: number): void {
    const w = effectiveWeapon(this.weapon);
    const n = this.shooters;
    const pellets = Math.max(1, w.pellets);
    // bigger squads than we can draw hit harder per bullet, so the counter always matters
    const perBullet = (w.damage * (this.count / n)) / pellets;
    for (let i = 0; i < n; i++) {
      this.fireAcc[i] += w.rate * dt;
      if (this.fireAcc[i] < 1) continue;
      this.fireAcc[i] = Math.min(this.fireAcc[i] - 1, 1);
      const x = this.soldierX(i);
      const y = this.soldierY(i) + 0.5;
      for (let p = 0; p < pellets; p++) {
        const fan = pellets > 1 ? (p / (pellets - 1) - 0.5) * w.spread : 0;
        const a = Math.PI / 2 + fan + (this.rng() - 0.5) * w.jitter;
        const b = this.bulletHead;
        this.bulletHead = (this.bulletHead + 1) % MAX_BULLETS;
        this.bx[b] = x;
        this.by[b] = y;
        this.bvx[b] = Math.cos(a) * w.speed + this.squadVx * BULLET_INHERIT;
        this.bvy[b] = Math.sin(a) * w.speed;
        this.bdmg[b] = perBullet;
        this.blife[b] = BULLET_LIFE;
      }
      this.hooks.shot?.(x, y);
    }
  }

  private updateBullets(dt: number): void {
    // compact list of living monsters so each bullet only tests those
    let live = 0;
    for (let m = 0; m < MAX_MONSTERS; m++) if (this.malive[m]) this.liveMonsters[live++] = m;
    this.liveCount = live;

    for (let i = 0; i < MAX_BULLETS; i++) {
      if (this.blife[i] <= 0) continue;
      this.blife[i] -= dt;
      const x0 = this.bx[i];
      const y0 = this.by[i];
      const x1 = x0 + this.bvx[i] * dt;
      const y1 = y0 + this.bvy[i] * dt;
      this.bx[i] = x1;
      this.by[i] = y1;
      if (Math.abs(x1) > 8 || y1 > 21 || y1 < -6) {
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
    for (let k = 0; k < this.liveCount; k++) {
      const m = this.liveMonsters[k];
      if (!this.malive[m]) continue; // killed earlier this step
      const r = MONSTERS[MONSTER_KIND_BY_INDEX[this.mkind[m]]].radius + 0.12;
      if (Math.abs(this.my[m] - y1) > r + 1.2) continue; // cheap vertical reject
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
      this.hooks.obstacleHit?.(this.bx[i], obstacle.y - obstacle.height / 2);
      if (obstacle.hp <= 0) {
        obstacle.alive = false;
        this.waveDone++;
        if (obstacle.item) {
          this.items.push({
            x: obstacle.x,
            y: obstacle.y + obstacle.height / 2 + 0.9,
            def: obstacle.item,
          });
        }
        this.coinsRaw += BLOCK_COINS;
        this.hooks.coin?.(obstacle.x, obstacle.y, BLOCK_COINS);
        this.hooks.obstacleBreak?.(obstacle);
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
        this.coinsRaw += MONSTERS[kind].coins;
        this.hooks.coin?.(this.mx[monster], this.my[monster], MONSTERS[kind].coins);
        this.hooks.kill?.(this.mx[monster], this.my[monster], kind, MONSTERS[kind].radius);
      } else {
        this.hooks.hit?.(this.mx[monster], this.my[monster]);
      }
      return true;
    }
    return false;
  }
}
