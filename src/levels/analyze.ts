import { applyGate } from '../core/rules';
import { analyzeStationary } from '../modes/stationary/bot';
import type { Level, RunnerLevel } from './schema';

export interface RunnerAnalysis {
  /** True if a perfect player (best gate every time) can beat every fight. */
  winnable: boolean;
  /** Crowd size after the final fight with perfect play (0 if unwinnable). */
  bestFinalCount: number;
  /** Human-readable reason when not winnable. */
  failure?: string;
}

/**
 * Best-case walk through a runner level. Gates are monotonic in the crowd size, so
 * picking the best option at every row is optimal. Enemies are treated as unavoidable
 * (worst case) and only obstacles that block the whole track cost units.
 * Used by `npm run validate:levels` and the tests to catch impossible levels early.
 */
export function analyzeRunner(level: RunnerLevel): RunnerAnalysis {
  type Ev =
    | { at: number; kind: 'gate'; i: number }
    | { at: number; kind: 'enemy'; count: number; label: string }
    | { at: number; kind: 'wall'; damage: number };
  const events: Ev[] = [];
  level.gates.forEach((g, i) => events.push({ at: g.at, kind: 'gate', i }));
  level.enemies.forEach((e, i) =>
    events.push({ at: e.at, kind: 'enemy', count: e.count, label: `enemies[${i}]` }),
  );
  level.obstacles.forEach((o) => {
    if (o.width >= 0.9 && !o.sway) events.push({ at: o.at, kind: 'wall', damage: o.damage });
  });
  if (level.boss) {
    events.push({ at: level.length, kind: 'enemy', count: level.boss.count, label: 'boss' });
  }
  events.sort((a, b) => a.at - b.at);

  let count = level.startCount;
  for (const ev of events) {
    if (ev.kind === 'gate') {
      const row = level.gates[ev.i];
      count = Math.max(...row.options.map((g) => applyGate(count, g)));
    } else if (ev.kind === 'wall') {
      count = Math.max(0, count - ev.damage);
    } else {
      if (count <= ev.count) {
        return {
          winnable: false,
          bestFinalCount: 0,
          failure: `${ev.label} (${ev.count}) beats the best possible crowd (${count}) at ${ev.at}`,
        };
      }
      count -= ev.count;
    }
    if (count <= 0) {
      return { winnable: false, bestFinalCount: 0, failure: `crowd wiped out at ${ev.at}` };
    }
  }
  return { winnable: true, bestFinalCount: count };
}

/**
 * Star rating (1-3) for a won level, based on how much of the best possible crowd
 * survived. Beating a level always earns at least one star.
 */
export function starsFor(survivors: number, bestPossible: number): 1 | 2 | 3 {
  if (bestPossible <= 0) return 3;
  const ratio = survivors / bestPossible;
  if (ratio >= 0.8) return 3;
  if (ratio >= 0.45) return 2;
  return 1;
}

/**
 * Survivors a good player can reach: the best-case walk for runner levels and the best
 * bot run for stationary levels. Stars are measured against this number.
 */
export function referenceSurvivors(level: Level): number {
  return level.mode === 'runner'
    ? analyzeRunner(level).bestFinalCount
    : analyzeStationary(level).bestSurvivors;
}
