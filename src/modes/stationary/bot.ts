import { applyGate } from '../../core/rules';
import { mulberry32 } from '../../core/rng';
import type { ChoiceDef, StationaryLevel } from '../../levels/schema';
import { StationarySim } from './sim';
import { effectiveWeapon, type WeaponState } from './weapons';

export interface BotResult {
  won: boolean;
  survivors: number;
  seconds: number;
  /** Lowest squad size seen during the run (how close it came to losing). */
  lowest: number;
}

/** Rough firepower of a squad: soldiers x volleys per second x damage x pellets (spread counts half). */
function firepower(count: number, w: WeaponState): number {
  const e = effectiveWeapon(w);
  return count * e.rate * e.damage * (1 + (e.pellets - 1) * 0.5);
}

function pickChoice(choices: ChoiceDef[], count: number, w: WeaponState): number {
  let best = 0;
  let bestScore = -Infinity;
  choices.forEach((c, i) => {
    let score: number;
    if (c.kind === 'crowd') {
      score = firepower(applyGate(count, c), w);
    } else if (c.kind === 'upgrade') {
      const next = { ...w };
      if (c.stat === 'rate') next.rateMul += c.value;
      else if (c.stat === 'damage') next.damageMul += c.value;
      else next.extraPellets += Math.round(c.value);
      score = firepower(count, next);
    } else {
      score = firepower(count, { ...w, id: c.weapon });
    }
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/**
 * A simple but sensible player: auto-aims at monsters, but turns to a required block
 * whenever no monster is close, and always takes the card that raises firepower most.
 * Used by `npm run validate:levels` to check that a level can be won.
 */
export function runBot(level: StationaryLevel, seed: number, maxSeconds = 300): BotResult {
  const sim = new StationarySim(level, mulberry32(seed));
  const dt = 1 / 30;
  const steps = Math.ceil(maxSeconds / dt);
  let lowest = sim.count;
  for (let step = 0; step < steps; step++) {
    if (sim.phase === 'won' || sim.phase === 'lost') break;
    if (sim.phase === 'choosing') {
      sim.choose(pickChoice(sim.choiceList, sim.count, sim.weapon));
      continue;
    }
    const block = sim.obstacles.find((o) => o.alive && o.required);
    sim.aim = block && sim.nearestMonsterDistance() > 5.5 ? { x: block.x, y: block.y } : null;
    sim.update(dt);
    lowest = Math.min(lowest, sim.count);
  }
  return {
    won: sim.phase === 'won',
    survivors: sim.phase === 'won' ? sim.count : 0,
    seconds: sim.time,
    lowest,
  };
}

export interface StationaryAnalysis {
  /** Fraction of bot runs (different random spawn positions) that were won. */
  winRate: number;
  /** Most survivors in a won run (0 if none). */
  bestSurvivors: number;
  /** Lowest squad size reached in any won run, as a fraction of the starting squad. */
  tightness: number;
}

export function analyzeStationary(level: StationaryLevel, runs = 5): StationaryAnalysis {
  let wins = 0;
  let best = 0;
  let tight = Infinity;
  for (let seed = 1; seed <= runs; seed++) {
    const r = runBot(level, seed * 7919);
    if (r.won) {
      wins++;
      best = Math.max(best, r.survivors);
      tight = Math.min(tight, r.lowest);
    }
  }
  return {
    winRate: wins / runs,
    bestSurvivors: best,
    tightness: wins > 0 ? tight / level.startCount : 0,
  };
}
