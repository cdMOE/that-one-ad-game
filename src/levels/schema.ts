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

export const SPAWN_SIDES = ['left', 'right', 'top'] as const;
export type SpawnSide = (typeof SPAWN_SIDES)[number];

/** A stream of monsters of one kind, entering from one side. */
export interface SpawnDef {
  kind: MonsterKind;
  count: number;
  /** Hit points of each monster. */
  hp: number;
  from: SpawnSide;
  /** Seconds between two monsters. */
  interval: number;
  /** Seconds after the wave starts before the first one appears. */
  delay?: number;
}

/** A shootable block with a hit-point counter. */
export interface StationaryObstacleDef {
  /** Lateral position, -1 (left) .. 1 (right). */
  x: number;
  /** Distance in front of the squad. */
  y: number;
  hp: number;
  /** Block width in world units (default 2.4). */
  width?: number;
  /** The wave only counts as cleared once required obstacles are destroyed (default true). */
  required?: boolean;
  /** Reward applied to the squad when the block is destroyed. */
  reward?: GateEffect;
  /** Units per second the block creeps towards the squad (default 0). */
  drift?: number;
  /** Squad units lost if a drifting block reaches the squad (default 5). */
  damage?: number;
}

export const UPGRADE_STATS = ['rate', 'damage', 'pellets'] as const;
export type UpgradeStat = (typeof UPGRADE_STATS)[number];

/** A card offered between waves. */
export type ChoiceDef =
  | { kind: 'crowd'; op: GateEffect['op']; value: number }
  | { kind: 'upgrade'; stat: UpgradeStat; value: number }
  | { kind: 'weapon'; weapon: WeaponId };

export interface WaveDef {
  monsters: SpawnDef[];
  obstacles?: StationaryObstacleDef[];
  /** Offered after the wave is cleared (ignored after the last wave). */
  choices?: ChoiceDef[];
}

export interface StationaryLevel extends LevelBase {
  mode: 'stationary';
  weapon: WeaponId;
  waves: WaveDef[];
}

/** Union of all level shapes, discriminated by `mode`. */
export type Level = RunnerLevel | StationaryLevel;
