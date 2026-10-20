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

export const MONSTER_KINDS = ['grunt', 'runner', 'tank', 'boss'] as const;
export type MonsterKind = (typeof MONSTER_KINDS)[number];

/** A stream of monsters of one kind, entering at the top of the arena. */
export interface SpawnDef {
  kind: MonsterKind;
  count: number;
  /** Hit points of each monster. */
  hp: number;
  /** Seconds between two monsters. */
  interval: number;
  /** Seconds after the wave starts before the first one appears. */
  delay?: number;
  /** Lane centre, -1 (left) .. 1 (right). Default 0.6: the right side. */
  x?: number;
  /** Random lateral scatter around the lane, 0 .. 1 (default 0.25). */
  spread?: number;
}

export const UPGRADE_STATS = ['rate', 'damage', 'pellets'] as const;
export type UpgradeStat = (typeof UPGRADE_STATS)[number];

/** A power-up hidden behind an obstacle; it falls towards the squad once the obstacle breaks. */
export type ItemDef =
  | { kind: 'crowd'; op: GateEffect['op']; value: number }
  | { kind: 'upgrade'; stat: UpgradeStat; value: number }
  | { kind: 'weapon'; weapon: WeaponId };

/** A block with a hit-point counter. Bullets cannot pass it. */
export interface StationaryObstacleDef {
  /** Lateral position, -1 (left) .. 1 (right). */
  x: number;
  /** Distance in front of the squad. */
  y: number;
  hp: number;
  /** Block width in world units (default 4.2). */
  width?: number;
  /** Extra hit points the block gains every second while it stands (default 0). */
  grow?: number;
  /** Power-up behind the block. */
  item?: ItemDef;
}

export interface WaveDef {
  monsters: SpawnDef[];
  obstacles?: StationaryObstacleDef[];
}

export interface StationaryLevel extends LevelBase {
  mode: 'stationary';
  weapon: WeaponId;
  waves: WaveDef[];
}

/** Union of all level shapes, discriminated by `mode`. */
export type Level = RunnerLevel | StationaryLevel;
