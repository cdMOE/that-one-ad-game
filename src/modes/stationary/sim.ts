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
 * the screen. Every soldier fires its own bullet dead straight ahead from its own position,
 * so sliding the squad sweeps the fire across the field.
 *
 * The field has two separate lanes. The **upgrade lane** (left by default) is a column of
 * blocks (HP counter, stop bullets) and power-ups sliding towards the squad: the front block
 * holds close to the squad until it is shot to pieces, the power-ups behind it are visible
 * from the start and fall one after another, so you have to be underneath them to catch
 * them. The **monster lane** is the rest of the field: monsters pour down it in masses on
 * straight lines and never enter the upgrade lane.
 */

export const ARENA = { halfWidth: 6, spawnTop: 16 };
/** Distance between neighbouring soldiers; also the size of the formation grid. */
export const SOLDIER_SPACING = 0.46;
export const GRID_COLS = 8;
/** At most this many soldiers are simulated and drawn; bigger squads hit harder per bullet. */
export const MAX_SHOOTERS = 40;
/** Global pace of the shooter: everything (monsters, bullets, items) runs this much faster. */
export const GAME_SPEED = 1.3;
const SQUAD_MAX_SPEED = 16;
/** How fast lane elements slide towards the squad. */
const LANE_SPEED = 3.4;
/** Where the front block of the upgrade lane holds: close to the squad. */
export const LANE_HOLD_Y = 4.4;
/** Distance between two neighbouring lane elements. */
export const LANE_SPACING = 1.7;
export const BLOCK_HEIGHT = 1.3;
/** The upgrade lane is this wide and its centre is this far from the middle of the field. */
export const UPGRADE_LANE_WIDTH = 3.6;
export const UPGRADE_LANE_CENTER = 3.8;
/** Empty strip between the two lanes. */
const LANE_GAP = 0.9;
const BULLET_LIFE = 1.3;
/** Coins for smashing a block. */
const BLOCK_COINS = 20;
/** Bullets are forgiving: the hit circle of a monster is this much bigger than the monster. */
const HIT_FORGIVENESS = 0.25;

export interface MonsterStats {
  speed: number;
  radius: number;
  /** Squad soldiers lost when it reaches the squad. */
  bite: number;
  /** Coins dropped when it dies (before the coin-bonus upgrade). */
  coins: number;
}

export const MONSTERS: Record<MonsterKind, MonsterStats> = {
  grunt: { speed: 3.8, radius: 0.42, bite: 1, coins: 2 },
  runner: { speed: 6.2, radius: 0.34, bite: 1, coins: 3 },
  tank: { speed: 2.1, radius: 0.8, bite: 4, coins: 12 },
  miniboss: { speed: 1.7, radius: 1.15, bite: 10, coins: 60 },
  boss: { speed: 1.2, radius: 1.7, bite: 25, coins: 300 },
};
export const MONSTER_KIND_BY_INDEX: MonsterKind[] = ['grunt', 'runner', 'tank', 'miniboss', 'boss'];
const MONSTER_KIND_INDEX: Record<MonsterKind, number> = {
  grunt: 0,
  runner: 1,
  tank: 2,
  miniboss: 3,
  boss: 4,
};

export const MAX_MONSTERS = 450;
export const MAX_BULLETS = 900;
/** Monsters are sorted into horizontal slabs of this height so bullets only test nearby ones. */
const BUCKET_H = 1;
const BUCKETS = 22;

export type SimPhase = 'gap' | 'fighting' | 'won' | 'lost';

/** One thing on the upgrade lane. `y` is its distance in front of the squad. */
export interface LaneElement {
  type: 'block' | 'item';
  y: number;
  hp: number;
  maxHp: number;
  grow: number;
  item?: ItemDef;
  /** 1 right after a hit, decays in the view. */
  flash: number;
}

export interface LaneState {
  /** Centre x of the upgrade lane. */
  x: number;
  width: number;
  /** Front element first. */
  elements: LaneElement[];
}

export interface SimHooks {
  /** A soldier fired; (x, y) is the muzzle position. Called once per soldier shot. */
  shot?(x: number, y: number): void;
  hit?(x: number, y: number): void;
  kill?(x: number, y: number, kind: MonsterKind, radius: number): void;
  /** Coins dropped at a position (raw amount, before the coin-bonus upgrade). */
  coin?(x: number, y: number, amount: number): void;
  bite?(x: number, y: number, lost: number): void;
  blockHit?(x: number, y: number): void;
  blockBreak?(x: number, y: number): void;
  itemCollected?(x: number, y: number, def: ItemDef, delta: number): void;
  itemLost?(x: number, def: ItemDef): void;
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
  time = 0;
  kills = 0;
  /** Coins earned so far, before the coin-bonus upgrade. */
  coinsRaw = 0;

  /** Where the player wants the squad (world x). The squad slides there. */
  targetX = 0;
  squadX = 0;
  squadVx = 0;

  readonly lane: LaneState;
  /** x range of the monster lane (monsters spawn and walk inside it only). */
  readonly monsterMinX: number;
  readonly monsterMaxX: number;

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
  /** Monster indices sorted by slab (counting sort), rebuilt every step. */
  private readonly bucketItems = new Int16Array(MAX_MONSTERS);
  private readonly bucketStart = new Int16Array(BUCKETS + 1);
  private readonly bucketFill = new Int16Array(BUCKETS);
  private bulletHead = 0;
  private gapTimer = 0.4;
  private levelTime = 0;
  private readonly queue: Spawn[] = [];
  private queueIndex = 0;
  private readonly total: number;
  private done = 0;

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

    for (const s of level.monsters) {
      for (let i = 0; i < s.count; i++) {
        this.queue.push({
          t: (s.delay ?? 0) + i * s.interval,
          kind: s.kind,
          hp: s.hp,
          x: s.x ?? 0,
          spread: s.spread ?? 1,
        });
      }
    }
    this.queue.sort((a, b) => a.t - b.t);

    const left = (level.lane.side ?? 'left') === 'left';
    const laneX = left ? -UPGRADE_LANE_CENTER : UPGRADE_LANE_CENTER;
    const edge = UPGRADE_LANE_WIDTH / 2 + LANE_GAP;
    // the monster lane is everything on the other side of the gap
    this.monsterMinX = left ? laneX + edge : -ARENA.halfWidth + 0.4;
    this.monsterMaxX = left ? ARENA.halfWidth - 0.4 : laneX - edge;
    this.lane = {
      x: laneX,
      width: UPGRADE_LANE_WIDTH,
      elements: level.lane.elements.map((e, i) => ({
        type: e.type,
        y: LANE_HOLD_Y + i * LANE_SPACING,
        hp: e.type === 'block' ? e.hp : 0,
        maxHp: e.type === 'block' ? e.hp : 0,
        grow: e.type === 'block' ? (e.grow ?? 0) : 0,
        ...(e.type === 'item' ? { item: e.item } : {}),
        flash: 0,
      })),
    };
    this.total = Math.max(1, this.queue.length + this.lane.elements.length);
  }

  get progress(): number {
    return this.phase === 'won' ? 1 : Math.min(1, this.done / this.total);
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

  update(frameDt: number): void {
    if (this.phase === 'won' || this.phase === 'lost') return;
    const dt = frameDt * GAME_SPEED;
    this.time += dt;
    this.moveSquad(dt);
    this.updateBullets(dt);
    for (const e of this.lane.elements) e.flash = Math.max(0, e.flash - dt * 6);
    if (this.phase === 'gap') {
      this.gapTimer -= dt;
      if (this.gapTimer <= 0) this.phase = 'fighting';
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

  private end(won: boolean): void {
    this.phase = won ? 'won' : 'lost';
    this.hooks.ended?.(won);
  }

  // ---- fighting -----------------------------------------------------------

  /** Returns false when the monster pool is full (the spawn then waits for a free slot). */
  private spawn(s: Spawn): boolean {
    let slot = -1;
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (!this.malive[i]) {
        slot = i;
        break;
      }
    }
    if (slot < 0) return false;
    const stats = MONSTERS[s.kind];
    const half = (this.monsterMaxX - this.monsterMinX) / 2;
    const mid = (this.monsterMinX + this.monsterMaxX) / 2;
    const x = mid + (s.x + (this.rng() * 2 - 1) * s.spread) * half;
    // keep even the biggest monsters fully inside their own lane
    const lo = this.monsterMinX + stats.radius;
    const hi = this.monsterMaxX - stats.radius;
    this.mx[slot] = Math.max(lo, Math.min(hi, x));
    this.my[slot] = ARENA.spawnTop + this.rng() * 1.5;
    this.mhp[slot] = s.hp;
    this.mmax[slot] = s.hp;
    this.mkind[slot] = MONSTER_KIND_INDEX[s.kind];
    this.malive[slot] = 1;
    return true;
  }

  private updateFight(dt: number): void {
    this.levelTime += dt;
    while (this.queueIndex < this.queue.length && this.queue[this.queueIndex].t <= this.levelTime) {
      if (!this.spawn(this.queue[this.queueIndex])) break;
      this.queueIndex++;
    }

    // monsters march straight down their own lane; whatever reaches the bottom bites
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (!this.malive[i]) continue;
      const stats = MONSTERS[MONSTER_KIND_BY_INDEX[this.mkind[i]]];
      const y = this.my[i];
      if (y <= 0.5 + stats.radius * 0.6) {
        this.malive[i] = 0;
        this.done++;
        this.count = clampCount(this.count - stats.bite);
        this.hooks.bite?.(this.mx[i], Math.max(0, y), stats.bite);
        if (this.count <= 0) {
          this.end(false);
          return;
        }
        continue;
      }
      this.my[i] = y - stats.speed * dt;
    }

    this.updateLane(dt);
    this.fire(dt);

    if (
      this.queueIndex >= this.queue.length &&
      this.monstersAlive === 0 &&
      this.lane.elements.length === 0
    ) {
      this.end(true);
    }
  }

  /**
   * Slides the upgrade lane towards the squad. A front block holds at the hold line, a front
   * power-up keeps falling; every element behind keeps its spacing to the one in front.
   */
  private updateLane(dt: number): void {
    const lane = this.lane;
    const els = lane.elements;
    for (let k = 0; k < els.length; k++) {
      const e = els[k];
      if (e.type === 'block' && k === 0 && e.grow > 0) {
        e.hp += e.grow * dt;
        e.maxHp = Math.max(e.maxHp, e.hp);
      }
      let floor = -Infinity;
      if (k > 0) floor = els[k - 1].y + LANE_SPACING;
      else if (e.type === 'block') floor = LANE_HOLD_Y;
      e.y = Math.max(floor, e.y - LANE_SPEED * dt);
    }
    // collect or lose the front power-up
    const front = els[0];
    if (front && front.type === 'item' && front.item) {
      if (front.y <= 1 && Math.abs(lane.x - this.squadX) <= this.halfWidth() + lane.width / 2) {
        els.shift();
        this.done++;
        const before = this.count;
        this.applyItem(front.item);
        this.hooks.itemCollected?.(lane.x, front.y, front.item, this.count - before);
      } else if (front.y < -1.5) {
        els.shift();
        this.done++;
        this.hooks.itemLost?.(lane.x, front.item);
      }
    }
  }

  private applyItem(def: ItemDef): void {
    if (def.kind === 'crowd') this.count = applyGate(this.count, def);
    else if (def.kind === 'upgrade') applyUpgrade(this.weapon, def.stat, def.value);
    else this.weapon.id = def.weapon;
  }

  /** Every soldier fires on its own clock, straight up from where it stands. */
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
        const a = Math.PI / 2 + fan; // bullets fly dead straight from the soldier
        const b = this.bulletHead;
        this.bulletHead = (this.bulletHead + 1) % MAX_BULLETS;
        this.bx[b] = x;
        this.by[b] = y;
        this.bvx[b] = Math.cos(a) * w.speed;
        this.bvy[b] = Math.sin(a) * w.speed;
        this.bdmg[b] = perBullet;
        this.blife[b] = BULLET_LIFE;
      }
      this.hooks.shot?.(x, y);
    }
  }

  /** Counting-sorts the living monsters into horizontal slabs. */
  private buildBuckets(): void {
    const start = this.bucketStart;
    start.fill(0);
    for (let m = 0; m < MAX_MONSTERS; m++) {
      if (this.malive[m]) start[this.bucketOf(this.my[m]) + 1]++;
    }
    for (let b = 0; b < BUCKETS; b++) start[b + 1] += start[b];
    const fill = this.bucketFill;
    fill.fill(0);
    for (let m = 0; m < MAX_MONSTERS; m++) {
      if (!this.malive[m]) continue;
      const b = this.bucketOf(this.my[m]);
      this.bucketItems[start[b] + fill[b]++] = m;
    }
  }

  private bucketOf(y: number): number {
    return Math.max(0, Math.min(BUCKETS - 1, Math.floor(y / BUCKET_H)));
  }

  private updateBullets(dt: number): void {
    this.buildBuckets();
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
    // only slabs within reach (the biggest monster is ~2 units tall)
    const b0 = Math.max(0, this.bucketOf(Math.min(y0, y1)) - 2);
    const b1 = Math.min(BUCKETS - 1, this.bucketOf(Math.max(y0, y1)) + 2);
    for (let k = this.bucketStart[b0]; k < this.bucketStart[b1 + 1]; k++) {
      const m = this.bucketItems[k];
      if (!this.malive[m]) continue; // killed earlier this step
      const r = MONSTERS[MONSTER_KIND_BY_INDEX[this.mkind[m]]].radius + HIT_FORGIVENESS;
      const t = segmentCircle(x0, y0, x1, y1, this.mx[m], this.my[m], r);
      if (t >= 0 && t < bestT) {
        bestT = t;
        monster = m;
      }
    }
    let block: LaneElement | null = null;
    const lane = this.lane;
    for (const e of lane.elements) {
      if (e.type !== 'block') continue;
      for (let k = 1; k <= 4; k++) {
        const t = k / 4;
        const px = x0 + (x1 - x0) * t;
        const py = y0 + (y1 - y0) * t;
        if (Math.abs(px - lane.x) <= lane.width / 2 && Math.abs(py - e.y) <= BLOCK_HEIGHT / 2) {
          if (t < bestT) {
            bestT = t;
            block = e;
            monster = -1;
          }
          break;
        }
      }
    }
    const dmg = this.bdmg[i];
    if (block) {
      block.hp -= dmg;
      block.flash = 1;
      this.hooks.blockHit?.(this.bx[i], block.y - BLOCK_HEIGHT / 2);
      if (block.hp <= 0) {
        lane.elements.splice(lane.elements.indexOf(block), 1);
        this.done++;
        this.coinsRaw += BLOCK_COINS;
        this.hooks.coin?.(lane.x, block.y, BLOCK_COINS);
        this.hooks.blockBreak?.(lane.x, block.y);
      }
      return true;
    }
    if (monster >= 0) {
      const kind = MONSTER_KIND_BY_INDEX[this.mkind[monster]];
      this.mhp[monster] -= dmg;
      if (this.mhp[monster] <= 0) {
        this.malive[monster] = 0;
        this.done++;
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
