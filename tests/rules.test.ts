import { describe, expect, it } from 'vitest';
import { MAX_COUNT } from '../src/config';
import {
  applyGate,
  battleStep,
  clampCount,
  formatCount,
  gateLabel,
  isGoodGate,
  resolveBattle,
} from '../src/core/rules';

describe('applyGate', () => {
  it('adds and subtracts', () => {
    expect(applyGate(10, { op: '+', value: 5 })).toBe(15);
    expect(applyGate(10, { op: '-', value: 4 })).toBe(6);
  });

  it('never goes below zero', () => {
    expect(applyGate(3, { op: '-', value: 10 })).toBe(0);
  });

  it('multiplies and floors fractional results', () => {
    expect(applyGate(7, { op: 'x', value: 2 })).toBe(14);
    expect(applyGate(5, { op: 'x', value: 1.5 })).toBe(7);
  });

  it('divides with rounding to nearest and keeps a lone unit alive', () => {
    expect(applyGate(10, { op: '/', value: 2 })).toBe(5);
    expect(applyGate(5, { op: '/', value: 2 })).toBe(3);
    expect(applyGate(1, { op: '/', value: 2 })).toBe(1);
    expect(applyGate(1, { op: '/', value: 10 })).toBe(1);
  });

  it('keeps an empty crowd empty', () => {
    expect(applyGate(0, { op: 'x', value: 5 })).toBe(0);
    expect(applyGate(0, { op: '/', value: 2 })).toBe(0);
    expect(applyGate(0, { op: '+', value: 0 })).toBe(0);
  });

  it('clamps to MAX_COUNT', () => {
    expect(applyGate(MAX_COUNT, { op: 'x', value: 10 })).toBe(MAX_COUNT);
    expect(applyGate(MAX_COUNT - 1, { op: '+', value: 50 })).toBe(MAX_COUNT);
  });

  it('ignores a zero divisor instead of producing Infinity', () => {
    expect(applyGate(10, { op: '/', value: 0 })).toBe(10);
  });
});

describe('gate helpers', () => {
  it('classifies gates', () => {
    expect(isGoodGate({ op: '+', value: 1 })).toBe(true);
    expect(isGoodGate({ op: '-', value: 1 })).toBe(false);
    expect(isGoodGate({ op: 'x', value: 2 })).toBe(true);
    expect(isGoodGate({ op: 'x', value: 0.5 })).toBe(false);
    expect(isGoodGate({ op: '/', value: 2 })).toBe(false);
  });

  it('formats labels with proper symbols', () => {
    expect(gateLabel({ op: '+', value: 10 })).toBe('+10');
    expect(gateLabel({ op: '-', value: 5 })).toBe('−5');
    expect(gateLabel({ op: 'x', value: 2 })).toBe('×2');
    expect(gateLabel({ op: '/', value: 2 })).toBe('÷2');
  });
});

describe('resolveBattle', () => {
  it('lets the bigger side win with the difference', () => {
    expect(resolveBattle(30, 12)).toEqual({ a: 18, b: 0, winner: 'a' });
    expect(resolveBattle(5, 20)).toEqual({ a: 0, b: 15, winner: 'b' });
  });

  it('treats equal sizes as a draw with no survivors', () => {
    expect(resolveBattle(10, 10)).toEqual({ a: 0, b: 0, winner: 'draw' });
  });

  it('handles empty sides', () => {
    expect(resolveBattle(0, 5).winner).toBe('b');
    expect(resolveBattle(5, 0).winner).toBe('a');
  });
});

describe('battleStep', () => {
  it('removes the same number of units from both sides', () => {
    expect(battleStep(10, 7, 3)).toEqual({ a: 7, b: 4 });
  });

  it('never removes more than either side has', () => {
    expect(battleStep(10, 4, 99)).toEqual({ a: 6, b: 0 });
    expect(battleStep(2, 40, 99)).toEqual({ a: 0, b: 38 });
  });

  it('ignores negative kills', () => {
    expect(battleStep(5, 5, -3)).toEqual({ a: 5, b: 5 });
  });

  it('reaches the same result as resolveBattle when iterated', () => {
    for (const [a0, b0] of [
      [30, 12],
      [12, 30],
      [25, 25],
      [999, 1],
    ]) {
      let a = a0;
      let b = b0;
      while (a > 0 && b > 0) ({ a, b } = battleStep(a, b, 7));
      const r = resolveBattle(a0, b0);
      expect([a, b]).toEqual([r.a, r.b]);
    }
  });
});

describe('formatCount / clampCount', () => {
  it('formats compactly', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(9999)).toBe('9999');
    expect(formatCount(12_345)).toBe('12.3K');
    expect(formatCount(450_000)).toBe('450K');
    expect(formatCount(999_999)).toBe('999K');
    expect(formatCount(1_200_000)).toBe('1.2M');
  });

  it('clamps and floors', () => {
    expect(clampCount(-5)).toBe(0);
    expect(clampCount(3.9)).toBe(3);
    expect(clampCount(Number.NaN)).toBe(0);
    expect(clampCount(Infinity)).toBe(MAX_COUNT);
  });
});
