import { describe, expect, it, vi } from 'vitest';
import { noUpgrades } from '../src/core/shop';
import {
  loadRunLog,
  logPurchase,
  logReset,
  logRun,
  runCount,
  type RunEntry,
} from '../src/modes/stationary/runlog';

const run = (level: string): Omit<RunEntry, 'attempt' | 'bought'> => ({
  at: '2026-10-23T10:00:00.000Z',
  level,
  upgrades: noUpgrades(),
  wallet: 0,
  result: 'lost',
  reached: 0.4,
  seconds: 40,
  earned: 900,
  squad: { end: 0, peak: 6 },
  wallLeft: null,
  trace: { blocks: [1.2], items: [], elites: [], bitten: 3, struck: 0 },
});

describe('run log', () => {
  it('counts attempts per level, hangs purchases on the run before and restarts at a reset', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    logPurchase('damage'); // nothing to hang it on yet: dropped
    logRun(run('a'));
    logPurchase('damage');
    logPurchase('rate');
    logRun(run('a'));
    logRun(run('b'));
    logReset();
    logRun(run('a'));
    const runs = loadRunLog().filter((i): i is RunEntry => !('reset' in i));
    expect(runs.map((r) => `${r.level}${r.attempt}`)).toEqual(['a1', 'a2', 'b1', 'a1']);
    expect(runs[0].bought).toEqual(['damage', 'rate']);
    expect(runCount()).toBe(4);
    vi.unstubAllGlobals();
  });
});
