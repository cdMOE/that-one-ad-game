import { applyGate, clampCount } from '../../core/rules';
import { COIN_SCALE } from '../../core/shop';
import { gridSlotX, gridSlotY } from '../../core/swarm';
import type {
  ItemDef,
  MonsterKind,
  StationaryLevel,
  SummonKind,
  SummonDef,
  WeaponId,
} from '../../levels/schema';
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
 * from the start, and each one the broken block frees flies to the squad on its own (see
 * `ITEM_FLIGHT`). The **monster lane** is the rest of the field: monsters pour down it in masses on
 * straight lines and never enter the upgrade lane. Levels send them as marching ranks, one row
 * after another without a breather, so every second spent on the upgrade lane costs you.
 */

export const ARENA = { halfWidth: 6, spawnTop: 16 };
/**
 * Where monsters actually appear: far down the bridge beyond `ARENA.spawnTop`, so the horde queues
 * up in a long column all the way to the horizon, like in the ad shooters: the road looks deep and
 * you see what is still coming. Each one starts early by the time it needs for the extra way, so it
 * still crosses `spawnTop` exactly when the level schedules it: the walk-in changes the view, not
 * the fight.
 */
export const SPAWN_FAR = 48;
/**
 * Distance between neighbouring soldiers; also the size of the formation grid. Wide enough that
 * the big, close-up soldiers read as a loose group of people, not a block of helmets.
 */
export const SOLDIER_SPACING = 0.6;
/**
 * Columns of the formation. The full squad fires a lane (4 x 0.6 = 2.4) narrower than the
 * smallest big target (a tank is 2.5 wide to bullets, a miniboss 3.2, a block 3.6), so a squad
 * standing under one puts every bullet into it.
 */
export const GRID_COLS = 5;
/** At most this many soldiers are simulated and drawn; bigger squads hit harder per bullet. */
export const MAX_SHOOTERS = 40;
/**
 * Global pace of the shooter: everything (monsters, bullets, items) runs this much faster. Kept
 * high, like the ad shooters: the horde storms in, kills and coins come every split second, and a
 * lost run is over in well under a minute. Boss warnings are set in game time so that they still
 * give the same reaction time in real seconds (see `EliteStats.telegraph`).
 */
export const GAME_SPEED = 1.6;
const SQUAD_MAX_SPEED = 16;
/** How fast lane elements slide towards the squad. */
const LANE_SPEED = 3.4;
/** Where the front block of the upgrade lane holds: close to the squad. */
export const LANE_HOLD_Y = 4.4;
/** Distance between two neighbouring lane elements. */
export const LANE_SPACING = 1.7;
export const BLOCK_HEIGHT = 1.3;
/**
 * A power-up freed from its block flies to the squad on its own, wherever the squad stands, in
 * this many seconds (game time), and counts when it lands. The choice is shooting the block or
 * the horde; walking under a power-up to catch it was legwork, and a missed minigun hurt a run
 * without being a decision. Power-ups freed together leave one after another, `ITEM_GAP` apart.
 */
export const ITEM_FLIGHT = 0.75;
const ITEM_GAP = 0.25;
/** The upgrade lane is this wide and its centre is this far from the middle of the field. */
export const UPGRADE_LANE_WIDTH = 3.6;
export const UPGRADE_LANE_CENTER = 3.8;
/** Empty strip between the two lanes. */
const LANE_GAP = 0.9;
/**
 * How far a bullet flies: well past the top of the field into the queue walking in, so the shots
 * visibly reach the horde (a bullet always hits the nearest monster on its path, so this changes
 * the look far more than the balance), but never out into the haze where monsters appear.
 */
export const BULLET_RANGE = 24;
/** Coins for smashing a block. */
const BLOCK_COINS = 20 * COIN_SCALE;
/** Bullets are forgiving: the hit circle of a monster is this much bigger than the monster. */
export const HIT_FORGIVENESS = 0.35;

/**
 * Minibosses and bosses are the walls of a level. They stop at `holdY`, stay there and every
 * `interval` seconds fire a volley of `zones` strikes: each zone `halfWidth` to each side lights up
 * for `telegraph` seconds, then hits. With chance `aimedChance` the first zone is aimed at where
 * the squad stands, otherwise it lands at random; every further zone is random. A volley always
 * leaves a gap the squad fits into, so it can be dodged. Whoever is caught by any zone loses
 * `damage` of the squad (once per volley, however many zones it stands in).
 *
 * The longer one stands, the angrier it gets: after `calm` seconds on its hold line, and again
 * every `rageEvery` seconds, it rages one step more (up to `maxRage`). Every step makes its volleys
 * come `RAGE_PACE` times sooner, every second step adds a zone, and at full rage the upgrade lane
 * is no shelter any more. A short fight is relaxed, a long one gets hectic, and a squad too weak to
 * bring it down in time is worn down by the strikes it cannot all dodge. So every elite is a
 * damage check the shop upgrades have to pass, and a lost run ends with the boss's health bar
 * saying how close it was. All times are game time (see `GAME_SPEED`).
 */
export interface EliteStats {
  holdY: number;
  interval: number;
  telegraph: number;
  halfWidth: number;
  damage: number;
  zones: number;
  aimedChance: number;
  calm: number;
  rageEvery: number;
  maxRage: number;
  /**
   * Share of the progress bar its health is worth, filled as it loses health (see `progress`). A
   * boss is a fight of its own: counted as one monster among thousands, the bar would sit at 99%
   * through all of it and a run that got the boss down to a sliver would look like one that did not
   * scratch it.
   */
  progressShare: number;
}

/** The elites of a level fill at most this share of the progress bar; the horde fills the rest. */
const ELITE_PROGRESS_MAX = 0.5;

/** Every rage step makes an elite's volleys come this many times sooner. */
export const RAGE_PACE = 0.8;

/**
 * A boss fight comes in phases, never horde and volleys at full strength at once: while the horde
 * on the field in front of the elites (closer than `HORDE_FIELD_Y`, its own or the level's) could
 * bite at least `HORDE_HOLD` soldiers (a tank counts as four grunts), they hold their fire, and
 * the squad deals with the horde.
 * Once the field clears they open fire within `HORDE_REFIRE` of their volley interval: dodge and
 * hit the boss. A volley already announced still lands. Health marks and rage steps call the next
 * wave, so a fight that drags never thins out into a lonely duel either.
 */
export const HORDE_HOLD = 6;
export const HORDE_FIELD_Y = 12;
const HORDE_REFIRE = 0.35;

export interface MonsterStats {
  speed: number;
  radius: number;
  /** Squad soldiers lost when it reaches the squad (elites never do). */
  bite: number;
  elite?: EliteStats;
  /** Coins dropped when it dies (before the coin-bonus upgrade). */
  coins: number;
}

export const MONSTERS: Record<MonsterKind, MonsterStats> = {
  grunt: { speed: 1.9, radius: 0.5, bite: 1, coins: 0.25 * COIN_SCALE },
  runner: { speed: 3.1, radius: 0.42, bite: 1, coins: 0.4 * COIN_SCALE },
  tank: { speed: 1.3, radius: 0.9, bite: 4, coins: 12 * COIN_SCALE },
  miniboss: {
    speed: 1.0,
    radius: 1.25,
    bite: 0,
    coins: 60 * COIN_SCALE,
    elite: {
      // the front edge stays about nine units off the squad: big, but not in its face. Further back
      // and a queue of three elites (two minibosses, then the boss) no longer fits on the field
      holdY: 10,
      interval: 5,
      // 0.85 s of warning in real time
      telegraph: 1.35,
      halfWidth: 1.1,
      damage: 0.2,
      zones: 1,
      aimedChance: 0.5,
      calm: 9,
      rageEvery: 4,
      maxRage: 4,
      progressShare: 0.05,
    },
  },
  boss: {
    speed: 0.8,
    radius: 1.8,
    bite: 0,
    coins: 300 * COIN_SCALE,
    elite: {
      // further back than the miniboss, as it is bigger (same front edge)
      holdY: 11,
      interval: 3.6,
      // 0.77 s of warning in real time
      telegraph: 1.23,
      halfWidth: 1.3,
      damage: 0.3,
      zones: 2,
      aimedChance: 0.6,
      calm: 12,
      rageEvery: 4,
      maxRage: 4,
      progressShare: 0.25,
    },
  },
};
/**
 * Elites are slow, and on the long walk in from `SPAWN_FAR` at their own pace a boss would stand
 * on the bridge from the first second, long before its turn. Beyond `ARENA.spawnTop` they march at
 * this speed instead: a boss shows up at the horizon about ten seconds before it reaches the field,
 * then slows down to its menacing walk.
 */
const ELITE_WALK_IN = 3;

/** How fast a monster comes down the bridge beyond `ARENA.spawnTop` (see `ELITE_WALK_IN`). */
function walkInSpeed(stats: MonsterStats): number {
  return stats.elite ? Math.max(stats.speed, ELITE_WALK_IN) : stats.speed;
}

/** Most zones one volley can have; sizes the per-monster target storage. */
export const MAX_ZONES = 3;
/** Extra room, beyond the squad's own width, that a volley leaves free so it can be dodged. */
const SAFE_MARGIN = 0.6;

export const MONSTER_KIND_BY_INDEX: MonsterKind[] = ['grunt', 'runner', 'tank', 'miniboss', 'boss'];
const MONSTER_KIND_INDEX: Record<MonsterKind, number> = {
  grunt: 0,
  runner: 1,
  tank: 2,
  miniboss: 3,
  boss: 4,
};

/**
 * Monster slots only elites may use. A crowd that piles up behind a boss can fill the pool, and
 * the next boss must still be able to walk in on schedule.
 */
const ELITE_RESERVE = 8;
/** Ordinary monsters collide as discs this much smaller than their hit circle, so ranks stay loose. */
export const BODY_SCALE = 0.8;
/** How much of an overlap between two ordinary monsters is undone per step. */
const BODY_STIFFNESS = 0.4;
/** An elite blocks the crowd as a disc this much smaller than its hit circle, so a tank still fits past it. */
export const ELITE_BODY_SCALE = 0.85;

/**
 * Room for the horde on its long walk in down the bridge, plus what reaches the squad. The busiest
 * level peaks at about 700 with the bot playing.
 */
export const MAX_MONSTERS = 1000;
/**
 * Bullets in flight at most; a fired bullet takes the slot of the oldest one. Enough for a full
 * squad of drawn soldiers on a maxed minigun over a whole bullet range, so none is lost unseen.
 */
export const MAX_BULLETS = 1600;
/** Shots one soldier may fire in one step: a long frame (up to `MAX_FRAME`) still fires them all. */
const MAX_SHOTS_PER_STEP = 6;
/** Monsters are sorted into horizontal slabs of this height so bullets only test nearby ones. */
const BUCKET_H = 1;
/** Enough slabs to reach past the spawn line (plus its jitter); anything beyond shares the last. */
const BUCKETS = Math.ceil((SPAWN_FAR + 4) / BUCKET_H);

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

/** A power-up on its way from the lane to the squad (see `ITEM_FLIGHT`). */
export interface FlyingItem {
  /** The lane element it was, so the view keeps drawing the same thing. */
  el: LaneElement;
  item: ItemDef;
  /** Where it left the lane. */
  x: number;
  y: number;
  /** 0 when it leaves, 1 when it lands. */
  t: number;
}

export interface LaneState {
  /** Centre x of the upgrade lane. */
  x: number;
  width: number;
  /**
   * What a block covers across: everything on the lane's side of the divider, from the road's edge
   * to the divider itself. A squad on that side can never shoot past a block, even when it stands
   * at the very edge of the road.
   */
  blockLo: number;
  blockHi: number;
  /** Front element first. */
  elements: LaneElement[];
}

/** An elite strike that is lit up and about to land. `t` runs 0 (just announced) to 1 (lands). */
export interface Attack {
  /** Centre of the strike and how far it reaches to each side. */
  x: number;
  half: number;
  /** The part of it that lies on the monster field: the upgrade lane is always safe. */
  lo: number;
  hi: number;
  t: number;
  /** y of the monster that fires it. */
  y: number;
}

export interface SimHooks {
  /** An elite announced a strike zone at x (once per zone of a volley). */
  telegraph?(x: number, half: number): void;
  /**
   * A strike zone landed; `hit` says whether the squad stands in it. `lost` is what the volley cost
   * and is reported on the first zone that caught the squad only (0 on the others).
   */
  strike?(x: number, half: number, hit: boolean, lost: number): void;
  /** An elite got angrier (one rage step, see `EliteStats`): its volleys come sooner from now on. */
  enrage?(x: number, y: number, rage: number): void;
  /** A soldier fired; (x, y) is the muzzle position. Called once per soldier shot. */
  shot?(x: number, y: number): void;
  /** A bullet hit a monster without killing it, for `damage`. */
  hit?(x: number, y: number, damage: number, kind: MonsterKind): void;
  kill?(x: number, y: number, kind: MonsterKind, radius: number): void;
  /** Coins dropped at a position (raw amount, before the coin-bonus upgrade). */
  coin?(x: number, y: number, amount: number): void;
  /** A monster of `kind` reached the squad at (x, y) and bit `lost` soldiers out of it. */
  bite?(x: number, y: number, lost: number, kind: MonsterKind, radius: number): void;
  blockHit?(x: number, y: number): void;
  blockBreak?(x: number, y: number): void;
  /** A power-up left the lane for the squad (see `ITEM_FLIGHT`). */
  itemLaunched?(x: number, y: number, def: ItemDef): void;
  /** It landed on the squad and counts now; `delta` is what it did to the squad's size. */
  itemCollected?(x: number, y: number, def: ItemDef, delta: number): void;
  /**
   * An elite called `count` monsters of its horde to its side (see `SummonDef`): at one of its
   * health marks, or (`rage`) as the half wave that comes with a rage step.
   */
  summon?(x: number, y: number, count: number, rage: boolean): void;
  ended?(won: boolean): void;
}

interface Spawn {
  t: number;
  kind: MonsterKind;
  hp: number;
  x: number;
  spread: number;
  /** Set for formations: which column of its row this monster marches in. */
  slot?: { col: number; columns: number };
  summons?: SummonDef;
}

/**
 * The prize at the far end of the upgrade lane, shown from the first second as the goal of the run:
 * the last weapon on the lane, otherwise its biggest crowd multiplier (null if it has neither).
 */
export function laneJackpot<T extends { type: 'block' | 'item'; item?: ItemDef }>(
  elements: readonly T[],
): T | null {
  let best: T | null = null;
  for (const e of elements) {
    const it = e.item;
    if (e.type !== 'item' || !it) continue;
    if (it.kind === 'weapon') best = e;
    else if (it.kind === 'crowd' && it.op === 'x' && best?.item?.kind !== 'weapon') {
      const cur = best?.item;
      if (!cur || (cur.kind === 'crowd' && it.value >= cur.value)) best = e;
    }
  }
  return best;
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
  /** Extra soldiers the squad starts with (the soldiers upgrade). */
  startBonus?: number;
}

/**
 * What happened in a run, kept by the sim itself so a person's run (the run log) and a bot's run
 * can be laid side by side. Times are real seconds from the start of the run.
 */
export interface RunTrace {
  /** When each lane block broke. */
  blocks: number[];
  /** Every power-up caught: when, what (`+2`, `x2`, `rifle`, ...) and the squad right after. */
  items: Array<{ t: number; item: string; count: number }>;
  /**
   * Every miniboss and boss reaching its hold line: when, the squad then, the lane blocks still
   * standing and the weapon in hand; `down` is when it died.
   */
  elites: Array<{
    kind: MonsterKind;
    t: number;
    count: number;
    blocksLeft: number;
    weapon: WeaponId;
    down?: number;
  }>;
  /** Soldiers lost to monsters that got through, and to elite volleys. */
  bitten: number;
  struck: number;
}

function itemName(def: ItemDef): string {
  if (def.kind === 'weapon') return def.weapon;
  if (def.kind === 'crowd') return `${def.op}${def.value}`;
  return `${def.stat}+${def.value}`;
}

export class StationarySim {
  count: number;
  /** Biggest the squad has been in this run (stars compare the survivors with it). */
  peak: number;
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
  /** When true the squad sits exactly on `targetX` instead of gliding there (mouse aiming). */
  snapSquad = false;

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
  /** Elite state: 0 walking in, 1 holding (waiting to strike), 2 strike announced. */
  readonly mstate = new Uint8Array(MAX_MONSTERS);
  private readonly mtimer = new Float32Array(MAX_MONSTERS);
  /** Seconds an elite still stands on its hold line before its next rage step (see `EliteStats`). */
  private readonly mcalm = new Float32Array(MAX_MONSTERS);
  /** Rage steps an elite has taken so far, 0 (calm) .. `EliteStats.maxRage`. */
  readonly mrage = new Uint8Array(MAX_MONSTERS);
  /** The horde an elite calls, null for everything else (see `SummonDef`). */
  readonly msummons: (SummonDef | null)[] = new Array<SummonDef | null>(MAX_MONSTERS).fill(null);
  /** How many of its `SummonDef.at` health shares an elite has dropped past (and called for). */
  private readonly mwave = new Uint8Array(MAX_MONSTERS);
  /**
   * 1 for a monster an elite called: it is not one the level sends, so it does not move the
   * progress bar (calling a wave must not push the bar back), but it has to die for the win.
   */
  private readonly mcalled = new Uint8Array(MAX_MONSTERS);
  /** Index of an elite's entry in `trace.elites` once it has reached its hold line, else -1. */
  private readonly mtrace = new Int16Array(MAX_MONSTERS).fill(-1);
  readonly trace: RunTrace = { blocks: [], items: [], elites: [], bitten: 0, struck: 0 };
  /**
   * When a run is lost with an elite on the field: health left (0..1) of the one in front, the
   * wall the run did not get past. How close it came, for the result screen; null otherwise.
   */
  wallLeft: number | null = null;
  /** Centres of the announced zones, `MAX_ZONES` slots per monster. */
  private readonly mtarget = new Float32Array(MAX_MONSTERS * MAX_ZONES);
  private readonly mzones = new Uint8Array(MAX_MONSTERS);
  /** Strikes that are lit up right now (rebuilt every step). */
  readonly attacks: Attack[] = [];
  /** Soldiers the horde in front of the elites could bite this step (see `HORDE_HOLD`). */
  hordeNear = 0;
  /** Power-ups in the air between the lane and the squad. */
  readonly flying: FlyingItem[] = [];
  /** Game time until the next freed power-up may leave the lane. */
  private launchWait = 0;
  // bullets (ring buffer)
  readonly bx = new Float32Array(MAX_BULLETS);
  readonly by = new Float32Array(MAX_BULLETS);
  readonly bvx = new Float32Array(MAX_BULLETS);
  readonly bvy = new Float32Array(MAX_BULLETS);
  readonly bdmg = new Float32Array(MAX_BULLETS);
  /** Piercing bullets (the laser) fly on through the horde; `blast` is the monster hit last. */
  private readonly bpierce = new Uint8Array(MAX_BULLETS);
  private readonly blast = new Int16Array(MAX_BULLETS);
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
  /**
   * Elites run on their own clock: a full monster pool holds back the ordinary queue, but never
   * a boss. They are not tied to each other either; every one comes at its time.
   */
  private readonly eliteQueue: Spawn[] = [];
  private eliteIndex = 0;
  /** Ordinary monsters the level sends, and how many of them are dead or got through. */
  private readonly total: number;
  private done = 0;
  /** Elite `progressShare`s are scaled by this so they fit in `ELITE_PROGRESS_MAX`. */
  private readonly eliteScale: number;
  /** Share of the bar all elites together fill, and how much of it their lost health has filled. */
  private readonly eliteShare: number;
  private eliteDone = 0;

  constructor(
    readonly level: StationaryLevel,
    private readonly rng: () => number,
    readonly hooks: SimHooks = {},
    options: SimOptions = { damageMul: 1, rateMul: 1 },
  ) {
    this.count = level.startCount + (options.startBonus ?? 0);
    this.peak = this.count;
    this.weapon = newWeaponState(level.weapon);
    this.weapon.damageMul = options.damageMul;
    this.weapon.rateMul = options.rateMul;
    for (let i = 0; i < MAX_SHOOTERS; i++) this.fireAcc[i] = (i * 0.618) % 1; // stagger the guns

    for (const s of level.monsters) {
      for (let i = 0; i < s.count; i++) {
        const columns = s.columns;
        const stats = MONSTERS[s.kind];
        const lead = (SPAWN_FAR - ARENA.spawnTop) / walkInSpeed(stats);
        (stats.elite ? this.eliteQueue : this.queue).push({
          t: (s.delay ?? 0) + (columns ? Math.floor(i / columns) : i) * s.interval - lead,
          kind: s.kind,
          hp: s.hp,
          x: s.x ?? 0,
          spread: s.spread ?? 1,
          ...(columns ? { slot: { col: i % columns, columns } } : {}),
          ...(s.summons ? { summons: s.summons } : {}),
        });
      }
    }
    this.queue.sort((a, b) => a.t - b.t);
    this.eliteQueue.sort((a, b) => a.t - b.t);

    const left = (level.lane.side ?? 'left') === 'left';
    const laneX = left ? -UPGRADE_LANE_CENTER : UPGRADE_LANE_CENTER;
    const edge = UPGRADE_LANE_WIDTH / 2 + LANE_GAP;
    // the monster lane is everything on the other side of the gap
    this.monsterMinX = left ? laneX + edge : -ARENA.halfWidth + 0.4;
    this.monsterMaxX = left ? ARENA.halfWidth - 0.4 : laneX - edge;
    // the divider stands in the middle of the gap between the two lanes
    const divider = left
      ? laneX + UPGRADE_LANE_WIDTH / 2 + LANE_GAP / 2
      : laneX - UPGRADE_LANE_WIDTH / 2 - LANE_GAP / 2;
    this.lane = {
      x: laneX,
      width: UPGRADE_LANE_WIDTH,
      blockLo: left ? -ARENA.halfWidth : divider,
      blockHi: left ? divider : ARENA.halfWidth,
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
    this.total = Math.max(1, this.queue.length);
    let shares = 0;
    for (const e of this.eliteQueue) shares += MONSTERS[e.kind].elite!.progressShare;
    this.eliteScale = shares > ELITE_PROGRESS_MAX ? ELITE_PROGRESS_MAX / shares : 1;
    this.eliteShare = this.queue.length === 0 ? 1 : shares * this.eliteScale;
  }

  /**
   * How far the run got (0..1): ordinary monsters count one each, an elite by the health it has
   * lost (its `progressShare`), so a boss fight moves the bar as the boss goes down.
   */
  /** Real seconds since the run began, to a tenth (for `trace`). */
  private traceTime(): number {
    return Math.round((this.time / GAME_SPEED) * 10) / 10;
  }

  get progress(): number {
    if (this.phase === 'won') return 1;
    return Math.min(1, (1 - this.eliteShare) * (this.done / this.total) + this.eliteDone);
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
    if (this.snapSquad) {
      this.squadX = want;
      this.squadVx = dt > 0 ? Math.max(-SQUAD_MAX_SPEED, Math.min(SQUAD_MAX_SPEED, dx / dt)) : 0;
      return;
    }
    const step = Math.max(
      -SQUAD_MAX_SPEED * dt,
      Math.min(SQUAD_MAX_SPEED * dt, dx * Math.min(1, 16 * dt)),
    );
    this.squadX += step;
    this.squadVx = dt > 0 ? step / dt : 0;
  }

  private end(won: boolean): void {
    this.phase = won ? 'won' : 'lost';
    if (!won) {
      let front = -1;
      for (let i = 0; i < MAX_MONSTERS; i++) {
        if (!this.malive[i] || !MONSTERS[MONSTER_KIND_BY_INDEX[this.mkind[i]]].elite) continue;
        if (this.my[i] > ARENA.spawnTop) continue;
        if (front < 0 || this.my[i] < this.my[front]) front = i;
      }
      if (front >= 0) this.wallLeft = Math.max(0, this.mhp[front] / this.mmax[front]);
    }
    this.hooks.ended?.(won);
  }

  // ---- fighting -----------------------------------------------------------

  /** A free monster slot, or -1 when the pool is full (the last few are kept for elites). */
  private freeSlot(elite: boolean): number {
    const room = elite ? MAX_MONSTERS : MAX_MONSTERS - ELITE_RESERVE;
    for (let i = 0; i < room; i++) if (!this.malive[i]) return i;
    return -1;
  }

  /** Fills a slot with a fresh monster at (x, y). */
  private place(slot: number, kind: MonsterKind, hp: number, x: number, y: number): void {
    const stats = MONSTERS[kind];
    // keep even the biggest monsters fully inside their own lane
    const lo = this.monsterMinX + stats.radius;
    const hi = this.monsterMaxX - stats.radius;
    this.mx[slot] = Math.max(lo, Math.min(hi, x));
    this.my[slot] = y;
    this.mhp[slot] = hp;
    this.mmax[slot] = hp;
    this.mkind[slot] = MONSTER_KIND_INDEX[kind];
    this.mstate[slot] = 0;
    this.mcalm[slot] = stats.elite?.calm ?? 0;
    this.mrage[slot] = 0;
    this.msummons[slot] = null;
    this.mwave[slot] = 0;
    this.mcalled[slot] = 0;
    this.mtrace[slot] = -1;
    this.malive[slot] = 1;
  }

  /** Returns false when the monster pool is full (the spawn then waits for a free slot). */
  private spawn(s: Spawn): boolean {
    const stats = MONSTERS[s.kind];
    const slot = this.freeSlot(!!stats.elite);
    if (slot < 0) return false;
    const half = (this.monsterMaxX - this.monsterMinX) / 2;
    const mid = (this.monsterMinX + this.monsterMaxX) / 2;
    // a formation marches in columns (a little ragged); a plain stream is scattered at random
    const w = s.slot;
    const across = w
      ? ((w.col + 0.5) / w.columns) * 2 - 1 + (this.rng() - 0.5) * 0.12
      : this.rng() * 2 - 1;
    // an elite always comes down the middle: the crowd then has the same room on both sides
    const x = stats.elite ? mid : mid + (s.x + across * s.spread) * half;
    // a monster due before the level began (its walk-in starts early) is already on its way; one
    // held back by a full pool appears no closer than the old spawn line
    const lead = (SPAWN_FAR - ARENA.spawnTop) / walkInSpeed(stats);
    const late = Math.max(0, Math.min(lead, this.levelTime - s.t));
    const jitter = stats.elite ? 0 : this.rng() * (w ? 0.3 : 1.5);
    this.place(slot, s.kind, s.hp, x, SPAWN_FAR + jitter - walkInSpeed(stats) * late);
    if (s.summons) this.msummons[slot] = s.summons;
    return true;
  }

  /**
   * Elite `i` calls `n` monsters of its horde: they appear in ranks right behind it, across the
   * whole monster lane, and storm the squad around it. As many as the pool has room for.
   */
  private callHorde(i: number, n: number, rage = false): void {
    const h = this.msummons[i];
    if (!h || n <= 0) return;
    const r = MONSTERS[MONSTER_KIND_BY_INDEX[this.mkind[i]]].radius;
    const width = this.monsterMaxX - this.monsterMinX;
    // the main kind in front, a mixed horde's other kinds in the rows behind it, each as big a
    // share of its full count as this wave is of the main one
    const wave: Array<{ kind: SummonKind; hp: number }> = [];
    for (let k = 0; k < n; k++) wave.push({ kind: h.kind, hp: h.hp });
    for (const part of h.mix ?? []) {
      const m = Math.ceil((part.count * n) / h.count);
      for (let k = 0; k < m; k++) wave.push({ kind: part.kind, hp: part.hp });
    }
    let called = 0;
    for (const [k, w] of wave.entries()) {
      const slot = this.freeSlot(false);
      if (slot < 0) break;
      const col = k % h.columns;
      const row = Math.floor(k / h.columns);
      const x = this.monsterMinX + ((col + 0.5) / h.columns) * width + (this.rng() - 0.5) * 0.3;
      this.place(slot, w.kind, w.hp, x, this.my[i] + r + 0.8 + row * 1.1 + this.rng() * 0.2);
      this.mcalled[slot] = 1;
      called++;
    }
    if (called > 0) this.hooks.summon?.(this.mx[i], this.my[i], called, rage);
  }

  private updateFight(dt: number): void {
    this.levelTime += dt;
    while (this.queueIndex < this.queue.length && this.queue[this.queueIndex].t <= this.levelTime) {
      if (!this.spawn(this.queue[this.queueIndex])) break;
      this.queueIndex++;
    }
    while (
      this.eliteIndex < this.eliteQueue.length &&
      this.eliteQueue[this.eliteIndex].t <= this.levelTime
    ) {
      if (!this.spawn(this.eliteQueue[this.eliteIndex])) break;
      this.eliteIndex++;
    }

    this.hordeNear = 0;
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (this.malive[i] && this.my[i] < HORDE_FIELD_Y) {
        this.hordeNear += MONSTERS[MONSTER_KIND_BY_INDEX[this.mkind[i]]].bite;
      }
    }
    // monsters march straight down their own lane; whatever reaches the bottom bites
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (!this.malive[i]) continue;
      const stats = MONSTERS[MONSTER_KIND_BY_INDEX[this.mkind[i]]];
      const y = this.my[i];
      if (stats.elite) {
        if (this.updateElite(i, stats, dt)) return;
        continue;
      }
      if (y <= 0.5 + stats.radius * 0.6) {
        this.malive[i] = 0;
        if (!this.mcalled[i]) this.done++;
        this.count = clampCount(this.count - stats.bite);
        this.trace.bitten += stats.bite;
        this.hooks.bite?.(
          this.mx[i],
          Math.max(0, y),
          stats.bite,
          MONSTER_KIND_BY_INDEX[this.mkind[i]],
          stats.radius,
        );
        if (this.count <= 0) {
          this.end(false);
          return;
        }
        continue;
      }
      this.my[i] = y - stats.speed * dt;
    }
    this.resolveBodies();

    this.attacks.length = 0;
    for (let i = 0; i < MAX_MONSTERS; i++) {
      const stats = this.malive[i] ? MONSTERS[MONSTER_KIND_BY_INDEX[this.mkind[i]]] : null;
      if (stats?.elite && this.mstate[i] === 2) {
        const t = 1 - Math.max(0, this.mtimer[i]) / stats.elite.telegraph;
        const half = stats.elite.halfWidth;
        const [minX, maxX] = this.strikeField(i, stats.elite);
        for (let z = 0; z < this.mzones[i]; z++) {
          const x = this.mtarget[i * MAX_ZONES + z];
          const lo = Math.max(x - half, minX);
          const hi = Math.min(x + half, maxX);
          this.attacks.push({ x, half, lo, hi, t, y: this.my[i] });
        }
      }
    }

    this.updateLane(dt);
    this.fire(dt);

    // the level is won as soon as the last monster is gone; unbroken blocks and power-ups still
    // on the lane do not have to be cleared
    const spawned =
      this.queueIndex >= this.queue.length && this.eliteIndex >= this.eliteQueue.length;
    if (spawned && this.monstersAlive === 0) this.end(true);
  }

  /**
   * Keeps bodies from sharing space. Ordinary monsters shove each other apart a little every step
   * (a crowd, not a ghost parade); elites are immovable: whatever walks into one is pushed out
   * along the line from its centre, so a horde slides around a boss and splits into two streams.
   * Only on the field: on the long walk in beyond `ARENA.spawnTop` the horde marches in step, so it
   * reaches the field exactly as the level sends it, however far away it appeared.
   */
  private resolveBodies(): void {
    const minX = this.monsterMinX;
    const maxX = this.monsterMaxX;
    const kinds = MONSTER_KIND_BY_INDEX;
    const elites: number[] = [];
    const top = ARENA.spawnTop;

    // ordinary monsters against each other, using the slabs built at the start of this step
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (!this.malive[i] || this.my[i] > top) continue;
      const si = MONSTERS[kinds[this.mkind[i]]];
      if (si.elite) {
        elites.push(i);
        continue;
      }
      const ri = si.radius * BODY_SCALE;
      const b = this.bucketOf(this.my[i]);
      const lo = this.bucketStart[Math.max(0, b - 2)];
      const hi = this.bucketStart[Math.min(BUCKETS - 1, b + 2) + 1];
      for (let k = lo; k < hi; k++) {
        const j = this.bucketItems[k];
        if (j <= i || !this.malive[j] || this.my[j] > top) continue;
        const sj = MONSTERS[kinds[this.mkind[j]]];
        if (sj.elite) continue;
        const reach = ri + sj.radius * BODY_SCALE;
        let dx = this.mx[j] - this.mx[i];
        const dy = this.my[j] - this.my[i];
        if (Math.abs(dx) >= reach || Math.abs(dy) >= reach) continue;
        let d2 = dx * dx + dy * dy;
        if (d2 >= reach * reach) continue;
        if (d2 < 1e-6) {
          dx = (i & 1 ? 1 : -1) * 0.01; // exactly on top of each other: pick a side
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const push = (reach - d) * BODY_STIFFNESS;
        const wi = sj.radius * sj.radius;
        const wj = si.radius * si.radius;
        const share = wi / (wi + wj); // the lighter one gives way more
        const nx = dx / d;
        const ny = dy / d;
        this.mx[i] -= nx * push * share;
        this.my[i] -= ny * push * share;
        this.mx[j] += nx * push * (1 - share);
        this.my[j] += ny * push * (1 - share);
      }
    }

    // and everything else is pushed out of the elites
    for (let m = 0; m < MAX_MONSTERS; m++) {
      if (!this.malive[m] || this.my[m] > top) continue;
      const sm = MONSTERS[kinds[this.mkind[m]]];
      if (sm.elite) continue;
      for (const e of elites) {
        const reach =
          MONSTERS[kinds[this.mkind[e]]].radius * ELITE_BODY_SCALE + sm.radius * BODY_SCALE;
        let dx = this.mx[m] - this.mx[e];
        const dy = this.my[m] - this.my[e];
        if (Math.abs(dx) >= reach || Math.abs(dy) >= reach) continue;
        if (dx * dx + dy * dy >= reach * reach) continue;
        if (Math.abs(dx) < 0.02) dx = (m & 1 ? 1 : -1) * 0.02; // dead centre: slide to one side
        const d = Math.sqrt(dx * dx + dy * dy);
        this.mx[m] = this.mx[e] + (dx / d) * reach;
        this.my[m] = this.my[e] + (dy / d) * reach;
      }
      this.mx[m] = Math.max(minX + sm.radius, Math.min(maxX - sm.radius, this.mx[m]));
    }
  }

  /**
   * Where an elite stops: its own hold line, or right behind an elite that is already in front of
   * it on the field. They all come down the middle, so they queue up in a column and leave both
   * sides of the lane free for the crowd. One still walking in does not hold up the next: every
   * elite reaches the field on time.
   */
  private holdLine(i: number, e: EliteStats): number {
    let hold = e.holdY;
    const ri = MONSTERS[MONSTER_KIND_BY_INDEX[this.mkind[i]]].radius;
    for (let j = 0; j < MAX_MONSTERS; j++) {
      if (j === i || !this.malive[j] || this.my[j] > ARENA.spawnTop) continue;
      const other = MONSTERS[MONSTER_KIND_BY_INDEX[this.mkind[j]]];
      if (!other.elite) continue;
      const inFront = this.my[j] < this.my[i] || (this.my[j] === this.my[i] && j < i);
      if (inFront) hold = Math.max(hold, this.my[j] + ri + other.radius);
    }
    return hold;
  }

  /**
   * Where an elite's strikes may land: the monster field, and at full rage the whole road, the
   * upgrade lane included.
   */
  private strikeField(i: number, e: EliteStats): [number, number] {
    return this.mrage[i] >= e.maxRage
      ? [-ARENA.halfWidth, ARENA.halfWidth]
      : [this.monsterMinX, this.monsterMaxX];
  }

  /**
   * One elite's step: walk in to the hold line, wait, announce a volley (see `aimVolley`), then
   * let it land. Returns true when the volley wiped out the squad.
   */
  private updateElite(i: number, stats: MonsterStats, dt: number): boolean {
    const e = stats.elite as EliteStats;
    // the walk in down the bridge is quick, the last stretch on the field slow
    let y = this.my[i];
    let left = dt;
    const top = ARENA.spawnTop;
    if (y > top) {
      const fast = walkInSpeed(stats);
      const step = Math.min(y - top, fast * left);
      y -= step;
      left -= step / fast;
    }
    y -= stats.speed * left;
    // also while holding: when the elite in front falls, the next one steps up
    const hold = this.holdLine(i, e);
    this.my[i] = Math.max(hold, y);
    if (this.mstate[i] === 0) {
      if (this.my[i] <= hold) {
        this.mstate[i] = 1;
        this.mtimer[i] = e.interval * 0.6;
        this.mtrace[i] = this.trace.elites.length;
        this.trace.elites.push({
          kind: MONSTER_KIND_BY_INDEX[this.mkind[i]],
          t: this.traceTime(),
          count: this.count,
          blocksLeft: this.lane.elements.filter((el) => el.type === 'block').length,
          weapon: this.weapon.id,
        });
      }
      return false;
    }
    // only the one at the front of the queue gets angry; the ones behind it wait their turn calmly
    if (this.my[i] <= e.holdY + 1e-3 && this.mrage[i] < e.maxRage) {
      this.mcalm[i] -= dt;
      if (this.mcalm[i] <= 0) {
        this.mrage[i]++;
        this.mcalm[i] = e.rageEvery;
        this.hooks.enrage?.(this.mx[i], this.my[i], this.mrage[i]);
        // and every rage step it sends half a wave more of its horde
        const h = this.msummons[i];
        if (h) this.callHorde(i, Math.ceil(h.count / 2), true);
      }
    }
    // horde phase: it holds its fire while the horde is in front of it (see `HORDE_HOLD`)
    if (this.mstate[i] === 1 && this.hordeNear >= HORDE_HOLD) {
      this.mtimer[i] = Math.max(this.mtimer[i] - dt, e.interval * HORDE_REFIRE);
      return false;
    }
    this.mtimer[i] -= dt;
    if (this.mtimer[i] > 0) return false;
    if (this.mstate[i] === 1) {
      this.mstate[i] = 2;
      this.mtimer[i] = e.telegraph;
      this.aimVolley(i, e);
      for (let z = 0; z < this.mzones[i]; z++) {
        this.hooks.telegraph?.(this.mtarget[i * MAX_ZONES + z], e.halfWidth);
      }
      return false;
    }
    // only the monster field is struck: a squad standing in the upgrade lane is out of reach,
    // until the elite is in full rage
    const reach = this.halfWidth();
    const zones = this.mzones[i];
    const [minX, maxX] = this.strikeField(i, e);
    const caught: boolean[] = [];
    let hit = false;
    for (let z = 0; z < zones; z++) {
      const x = this.mtarget[i * MAX_ZONES + z];
      const lo = Math.max(x - e.halfWidth, minX);
      const hi = Math.min(x + e.halfWidth, maxX);
      const inside = this.squadX + reach >= lo && this.squadX - reach <= hi;
      caught.push(inside);
      hit ||= inside;
    }
    const lost = hit ? Math.max(1, Math.ceil(this.count * e.damage)) : 0;
    this.mstate[i] = 1;
    this.mtimer[i] = e.interval * Math.pow(RAGE_PACE, this.mrage[i]);
    if (hit) this.count = clampCount(this.count - lost);
    this.trace.struck += hit ? lost : 0;
    let reported = false;
    for (let z = 0; z < zones; z++) {
      const first = caught[z] && !reported;
      reported ||= caught[z];
      this.hooks.strike?.(
        this.mtarget[i * MAX_ZONES + z],
        e.halfWidth,
        caught[z],
        first ? lost : 0,
      );
    }
    if (this.count <= 0) {
      this.end(false);
      return true;
    }
    return false;
  }

  /**
   * Picks the zones of a volley: `zones` of them, one more for every second rage step. The first
   * one is aimed at the squad with chance `aimedChance`, otherwise (and for all further zones) it
   * lands at random where the elite may strike (see `strikeField`). A zone that would leave no gap
   * the squad fits into is dropped, so a volley can always be dodged.
   */
  private aimVolley(i: number, e: EliteStats): void {
    const [minX, maxX] = this.strikeField(i, e);
    const aimed = this.rng() < e.aimedChance;
    const need = 2 * this.halfWidth() + SAFE_MARGIN;
    const zones: number[] = [];
    const leavesRoom = (extra: number): boolean => {
      const spans = [...zones, extra]
        .map((x) => [Math.max(x - e.halfWidth, minX), Math.min(x + e.halfWidth, maxX)])
        .sort((a, b) => a[0] - b[0]);
      // the upgrade lane is never struck, so the free room counts all the way to the arena wall
      let cursor = -ARENA.halfWidth;
      for (const [lo, hi] of spans) {
        if (lo - cursor >= need) return true;
        cursor = Math.max(cursor, hi);
      }
      return ARENA.halfWidth - cursor >= need;
    };
    const count = Math.min(e.zones + Math.floor(this.mrage[i] / 2), MAX_ZONES);
    for (let z = 0; z < count; z++) {
      // the very first zone is allowed to hit the squad whatever the room, a lone strike can be dodged
      const x =
        z === 0 && aimed
          ? Math.max(minX, Math.min(maxX, this.squadX))
          : minX + this.rng() * (maxX - minX);
      if (z === 0 || leavesRoom(x)) zones.push(x);
    }
    this.mzones[i] = zones.length;
    for (let z = 0; z < zones.length; z++) this.mtarget[i * MAX_ZONES + z] = zones[z];
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
      // a block never comes closer than the hold line, even while a power-up in front of it
      // is still falling, so it cannot jump back up once it becomes the front element
      let floor = e.type === 'block' ? LANE_HOLD_Y : -Infinity;
      if (k > 0) floor = Math.max(floor, els[k - 1].y + LANE_SPACING);
      e.y = Math.max(floor, e.y - LANE_SPEED * dt);
    }
    // a power-up with no block in front of it leaves for the squad
    this.launchWait -= dt;
    const front = els[0];
    if (front && front.type === 'item' && front.item && this.launchWait <= 0) {
      els.shift();
      this.launchWait = ITEM_GAP;
      this.flying.push({ el: front, item: front.item, x: lane.x, y: front.y, t: 0 });
      this.hooks.itemLaunched?.(lane.x, front.y, front.item);
    }
    for (const f of this.flying) f.t += dt / ITEM_FLIGHT;
    while (this.flying.length > 0 && this.flying[0].t >= 1) {
      const f = this.flying.shift() as FlyingItem;
      const before = this.count;
      this.applyItem(f.item);
      this.trace.items.push({ t: this.traceTime(), item: itemName(f.item), count: this.count });
      this.hooks.itemCollected?.(this.squadX, 0, f.item, this.count - before);
    }
  }

  private applyItem(def: ItemDef): void {
    if (def.kind === 'crowd') {
      this.count = applyGate(this.count, def);
      this.peak = Math.max(this.peak, this.count);
    } else if (def.kind === 'upgrade') applyUpgrade(this.weapon, def.stat, def.value);
    else this.weapon.id = def.weapon;
  }

  /** Every soldier fires on its own clock, straight up from where it stands. */
  private fire(dt: number): void {
    const w = effectiveWeapon(this.weapon);
    const n = this.shooters;
    const pellets = Math.max(1, w.pellets);
    // every pellet carries the full damage, so a base weapon one-shots the swarm; bigger squads
    // than we can draw hit harder per bullet, so the counter always matters
    const perBullet = w.damage * (this.count / n);
    for (let i = 0; i < n; i++) {
      // a fast gun fires several times per step on a slow frame (a 30 fps phone, the 30 Hz bot):
      // one shot per step at most capped a maxed minigun at 60% of its damage there. Each shot of
      // the step leaves when it was due, so it starts as far along its way as it has flown since
      this.fireAcc[i] = Math.min(this.fireAcc[i] + w.rate * dt, MAX_SHOTS_PER_STEP);
      if (this.fireAcc[i] < 1) continue;
      const x = this.soldierX(i);
      const y = this.soldierY(i) + 0.5;
      while (this.fireAcc[i] >= 1) {
        this.fireAcc[i] -= 1;
        const age = this.fireAcc[i] / w.rate;
        for (let p = 0; p < pellets; p++) {
          const fan = pellets > 1 ? (p / (pellets - 1) - 0.5) * w.spread : 0;
          const a = Math.PI / 2 + fan; // bullets fly dead straight from the soldier
          const b = this.bulletHead;
          this.bulletHead = (this.bulletHead + 1) % MAX_BULLETS;
          this.bvx[b] = Math.cos(a) * w.speed;
          this.bvy[b] = Math.sin(a) * w.speed;
          this.bx[b] = x + this.bvx[b] * age;
          this.by[b] = y + this.bvy[b] * age;
          this.bdmg[b] = perBullet;
          this.blife[b] = BULLET_RANGE / w.speed - age;
          this.bpierce[b] = w.pierce ? 1 : 0;
          this.blast[b] = -1;
        }
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
      if (Math.abs(x1) > 8 || y1 > BULLET_RANGE + 6 || y1 < -6) {
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
      if (m === this.blast[i]) continue; // a piercing bullet does not hit the same one twice
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
        if (px >= lane.blockLo && px <= lane.blockHi && Math.abs(py - e.y) <= BLOCK_HEIGHT / 2) {
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
        this.coinsRaw += BLOCK_COINS;
        this.hooks.coin?.(lane.x, block.y, BLOCK_COINS);
        this.trace.blocks.push(this.traceTime());
        this.hooks.blockBreak?.(lane.x, block.y);
      }
      return true;
    }
    if (monster >= 0) {
      const kind = MONSTER_KIND_BY_INDEX[this.mkind[monster]];
      const elite = MONSTERS[kind].elite;
      if (elite) {
        const lost = Math.min(dmg, Math.max(0, this.mhp[monster])) / this.mmax[monster];
        this.eliteDone += lost * elite.progressShare * this.eliteScale;
      }
      this.mhp[monster] -= dmg;
      // a piercing bullet flies on through the horde, an elite still stops it
      const through = this.bpierce[i] === 1 && !elite;
      if (through) this.blast[i] = monster;
      if (this.mhp[monster] <= 0) {
        this.malive[monster] = 0;
        if (!this.mcalled[monster] && !elite) this.done++;
        this.kills++;
        this.coinsRaw += MONSTERS[kind].coins;
        this.hooks.coin?.(this.mx[monster], this.my[monster], MONSTERS[kind].coins);
        if (this.mtrace[monster] >= 0)
          this.trace.elites[this.mtrace[monster]].down = this.traceTime();
        this.hooks.kill?.(this.mx[monster], this.my[monster], kind, MONSTERS[kind].radius);
      } else {
        this.hooks.hit?.(this.mx[monster], this.my[monster], dmg, kind);
        // an elite calls its horde whenever its health drops past one of its marks
        const h = this.msummons[monster];
        while (h && this.mwave[monster] < h.at.length) {
          if (this.mhp[monster] > h.at[this.mwave[monster]] * this.mmax[monster]) break;
          this.mwave[monster]++;
          this.callHorde(monster, h.count);
        }
      }
      return !through;
    }
    return false;
  }
}
