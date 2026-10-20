import { describe, expect, it } from 'vitest';
import { formationSpacing, Swarm, visibleFor } from '../src/core/swarm';

describe('visibleFor', () => {
  it('shows small crowds one to one', () => {
    expect(visibleFor(0)).toBe(0);
    expect(visibleFor(1)).toBe(1);
    expect(visibleFor(250)).toBe(250);
  });

  it('grows monotonically and stays under the cap', () => {
    let prev = 0;
    for (const n of [1, 10, 100, 250, 251, 500, 1000, 10_000, 100_000, 1_000_000]) {
      const v = visibleFor(n);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1000);
      prev = v;
    }
  });
});

describe('formationSpacing', () => {
  it('keeps big crowds inside the max radius', () => {
    for (const n of [10, 100, 500, 1000]) {
      const r = formationSpacing(n, 3) * Math.sqrt(n);
      expect(r).toBeLessThanOrEqual(3.0001);
    }
  });
});

describe('Swarm', () => {
  it('grows and shrinks to the requested size', () => {
    const s = new Swarm(100);
    s.setSize(40);
    expect(s.n).toBe(40);
    s.setSize(10);
    expect(s.n).toBe(10);
    s.setSize(500); // clamped to capacity
    expect(s.n).toBe(100);
  });

  it('reports the position of every removed unit', () => {
    const s = new Swarm(50);
    s.setSize(20);
    s.snap(5, 5, 0.4);
    let removed = 0;
    s.setSize(15, () => removed++);
    expect(removed).toBe(5);
  });

  it('spawns from the fallback point when empty', () => {
    const s = new Swarm(10);
    s.setSize(1, undefined, 3, 4);
    expect(s.x[0]).toBe(3);
    expect(s.y[0]).toBe(4);
  });

  it('converges onto its formation around the centre', () => {
    const s = new Swarm(200);
    s.setSize(200, undefined, 0, 0);
    for (let i = 0; i < 240; i++) s.update(1 / 60, 10, 20, 0, 0, 0.3, 0);
    let mx = 0;
    let my = 0;
    for (let i = 0; i < s.n; i++) {
      mx += s.x[i];
      my += s.y[i];
    }
    expect(mx / s.n).toBeCloseTo(10, 0);
    expect(my / s.n).toBeCloseTo(20, 0);
    for (let i = 0; i < s.n; i++) {
      expect(Number.isFinite(s.x[i]) && Number.isFinite(s.y[i])).toBe(true);
    }
  });
});
