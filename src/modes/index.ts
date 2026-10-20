import type { Level, LevelMode } from '../levels/schema';
import type { GameContext, GameMode } from './mode';
import { RunnerMode } from './runner';
import { StationaryMode } from './stationary';

type Factories = {
  [M in LevelMode]: (level: Extract<Level, { mode: M }>, ctx: GameContext) => GameMode;
};

// Registry of all modes. It is typed against LevelMode, so adding a mode id to the
// level schema without registering it here is a compile error.
const factories: Factories = {
  runner: (level, ctx) => new RunnerMode(level, ctx),
  stationary: (level, ctx) => new StationaryMode(level, ctx),
};

export function createMode(level: Level, ctx: GameContext): GameMode {
  const create = factories[level.mode] as (level: Level, ctx: GameContext) => GameMode;
  return create(level, ctx);
}

export type { GameContext, GameMode, Outcome } from './mode';
