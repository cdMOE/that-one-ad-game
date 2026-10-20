import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRunner, starsFor } from '../src/levels/analyze';
import type { RunnerLevel } from '../src/levels/schema';
import { validateLevel } from '../src/levels/validate';
import { MAX_TIER, analyzeStationary } from '../src/modes/stationary/bot';

const dir = join(import.meta.dirname, '..', 'src', 'levels');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();

const minimal = {
  id: 't',
  name: 'T',
  mode: 'runner',
  startCount: 5,
  length: 50,
  gates: [],
  enemies: [],
  obstacles: [],
};

function errorsOf(data: unknown): string[] {
  const r = validateLevel(data);
  return r.ok ? [] : r.errors;
}

describe('shipped levels', () => {
  it('has at least one level', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s is valid and winnable', (file) => {
    const data: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const result = validateLevel(data);
    expect(result.ok ? [] : result.errors).toEqual([]);
    if (result.ok && result.level.mode === 'runner') {
      const analysis = analyzeRunner(result.level);
      expect(analysis.failure).toBeUndefined();
      expect(analysis.winnable).toBe(true);
    }
    if (result.ok && result.level.mode === 'stationary') {
      // stationary levels are meant to need shop upgrades: lost at the start, winnable at the top
      expect(analyzeStationary(result.level, 5, 0).winRate).toBeLessThan(0.6);
      expect(analyzeStationary(result.level, 5, MAX_TIER).winRate).toBeGreaterThanOrEqual(0.6);
    }
  });

  it('uses unique ids', () => {
    const ids = files.map(
      (f) => (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { id: string }).id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('validateLevel', () => {
  it('accepts a minimal level', () => {
    expect(validateLevel(minimal).ok).toBe(true);
  });

  it('rejects non-objects and unknown modes', () => {
    expect(validateLevel(null).ok).toBe(false);
    expect(validateLevel([]).ok).toBe(false);
    expect(errorsOf({ ...minimal, mode: 'nope' })[0]).toContain('mode');
  });

  it('reports typos in keys', () => {
    expect(errorsOf({ ...minimal, enemys: [] }).join()).toContain('enemys');
  });

  it('reports bad gates with a readable path', () => {
    const errs = errorsOf({
      ...minimal,
      gates: [{ at: 10, options: [{ op: 'x3', value: 2 }] }],
    });
    expect(errs.join()).toContain('gates[0].options[0].op');
  });

  it('limits a gate row to 1-3 options', () => {
    const g = { op: '+', value: 1 };
    expect(errorsOf({ ...minimal, gates: [{ at: 10, options: [] }] })).not.toEqual([]);
    expect(errorsOf({ ...minimal, gates: [{ at: 10, options: [g, g, g, g] }] })).not.toEqual([]);
  });

  it('rejects out-of-range numbers', () => {
    expect(errorsOf({ ...minimal, startCount: 0 })).not.toEqual([]);
    expect(errorsOf({ ...minimal, enemies: [{ at: 49.5, count: 3 }] })).not.toEqual([]);
    expect(errorsOf({ ...minimal, enemies: [{ at: 10, count: 3, x: 2 }] })).not.toEqual([]);
    expect(
      errorsOf({ ...minimal, gates: [{ at: 10, options: [{ op: '/', value: 0 }] }] }),
    ).not.toEqual([]);
  });

  it('sorts events by distance', () => {
    const r = validateLevel({
      ...minimal,
      enemies: [
        { at: 30, count: 2 },
        { at: 10, count: 1 },
      ],
    });
    expect(r.ok && r.level.mode === 'runner' ? r.level.enemies.map((e) => e.at) : []).toEqual([
      10, 30,
    ]);
  });
});

describe('analyzeRunner', () => {
  const base = minimal as unknown as RunnerLevel;

  it('picks the best gate every time', () => {
    const level: RunnerLevel = {
      ...base,
      startCount: 5,
      gates: [
        {
          at: 10,
          options: [
            { op: '+', value: 10 },
            { op: 'x', value: 2 },
          ],
        },
      ],
      enemies: [{ at: 20, count: 14 }],
    };
    expect(analyzeRunner(level)).toEqual({ winnable: true, bestFinalCount: 1 });
  });

  it('flags levels the best path cannot win', () => {
    const level: RunnerLevel = { ...base, startCount: 5, boss: { count: 5 } };
    const a = analyzeRunner(level);
    expect(a.winnable).toBe(false);
    expect(a.failure).toContain('boss');
  });
});

describe('starsFor', () => {
  it('rewards keeping more of the best possible crowd', () => {
    expect(starsFor(10, 10)).toBe(3);
    expect(starsFor(8, 10)).toBe(3);
    expect(starsFor(5, 10)).toBe(2);
    expect(starsFor(1, 10)).toBe(1);
  });

  it('gives full stars when the best case is unknown or exceeded', () => {
    expect(starsFor(3, 0)).toBe(3);
    expect(starsFor(30, 10)).toBe(3);
  });
});
