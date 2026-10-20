import type { GateEffect } from '../core/rules';

/** Every playable mode id. Add new ids here when you register a new mode. */
export const LEVEL_MODES = ['runner', 'stationary'] as const;
export type LevelMode = (typeof LEVEL_MODES)[number];

/** A row of 1-3 gates across the track; the player picks one by where they cross. */
export interface GateRowDef {
  /** Distance along the track. */
  at: number;
  options: GateEffect[];
}

export interface EnemyDef {
  at: number;
  count: number;
  /** Lateral position, -1 (left rail) .. 1 (right rail). Default 0. */
  x?: number;
}

export const OBSTACLE_KINDS = ['spikes', 'saw'] as const;
export type ObstacleKind = (typeof OBSTACLE_KINDS)[number];

export interface ObstacleDef {
  at: number;
  kind: ObstacleKind;
  /** Lateral centre, -1 .. 1. */
  x: number;
  /** Width as a fraction of the track, 0.1 .. 1. */
  width: number;
  /** Units lost when the crowd touches it. */
  damage: number;
  /** Optional side-to-side motion; amplitude uses the same -1..1 scale as x. */
  sway?: { amplitude: number; speed: number };
}

export interface BossDef {
  count: number;
  name?: string;
}

interface LevelBase {
  /** Unique, stable id (used for saved progress). */
  id: string;
  name: string;
  mode: LevelMode;
  startCount: number;
}

export interface RunnerLevel extends LevelBase {
  mode: 'runner';
  /** Track length in world units; the boss (or finish line) sits here. */
  length: number;
  /** Forward speed in units per second. Default 6. */
  speed?: number;
  gates: GateRowDef[];
  enemies: EnemyDef[];
  obstacles: ObstacleDef[];
  boss?: BossDef;
}

// ---- stationary (shooter) mode ------------------------------------------

export const WEAPON_IDS = ['pistol', 'rifle', 'shotgun', 'minigun'] as const;
export type WeaponId = (typeof WEAPON_IDS)[number];

export const MONSTER_KINDS = ['grunt', 'runner', 'tank', 'miniboss', 'boss'] as const;
export type MonsterKind = (typeof MONSTER_KINDS)[number];

/** A stream of monsters of one kind, entering at the top of the arena. */
export interface SpawnDef {
  kind: MonsterKind;
  count: number;
  /** Hit points of each monster. */
  hp: number;
  /** Seconds between two monsters. */
  interval: number;
  /** Seconds after the level starts before the first one appears. */
  delay?: number;
  /**
   * Where in the monster lane they enter, -1 (left edge) .. 1 (right edge). Default 0: the middle.
   */
  x?: number;
  /** Random scatter around `x`, 0 (one column) .. 1 (the whole lane). Default 1. */
  spread?: number;
}

export const UPGRADE_STATS = ['rate', 'damage', 'pellets'] as const;
export type UpgradeStat = (typeof UPGRADE_STATS)[number];

/** A power-up on the lane; the squad catches it by moving underneath it. */
export type ItemDef =
  | { kind: 'crowd'; op: GateEffect['op']; value: number }
  | { kind: 'upgrade'; stat: UpgradeStat; value: number }
  | { kind: 'weapon'; weapon: WeaponId };

/** One thing on a lane: a block with an HP counter (stops bullets) or a power-up. */
export type LaneElementDef =
  | {
      type: 'block';
      hp: number;
      /** Extra hit points the block gains every second while it is the front block (default 0). */
      grow?: number;
    }
  | { type: 'item'; item: ItemDef };

/**
 * The upgrade lane: a column of blocks and power-ups that slides towards the squad. The front
 * element stops at the hold line if it is a block (bullets must break it) and falls to the
 * squad if it is a power-up; everything behind it is visible and waits its turn. Monsters
 * never enter it: they have their own lane on the other side of the field.
 */
export interface LaneDef {
  /** Which side of the field the upgrade lane is on (default `left`). */
  side?: 'left' | 'right';
  /** Front element first. */
  elements: LaneElementDef[];
}

export interface StationaryLevel extends LevelBase {
  mode: 'stationary';
  weapon: WeaponId;
  lane: LaneDef;
  monsters: SpawnDef[];
}

/** Union of all level shapes, discriminated by `mode`. */
export type Level = RunnerLevel | StationaryLevel;
