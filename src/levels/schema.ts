import type { GateEffect } from '../core/rules';

/** Every playable mode id. Add new ids here when you register a new mode. */
export const LEVEL_MODES = ['runner'] as const;
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

/** Union of all level shapes, discriminated by `mode`. */
export type Level = RunnerLevel;
