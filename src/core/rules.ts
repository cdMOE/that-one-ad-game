import { MAX_COUNT } from '../config';

/**
 * Pure game rules. Nothing in here touches the DOM, the canvas or time, so every
 * mode can share it and it stays trivial to unit test.
 */

export type GateOp = '+' | '-' | 'x' | '/';
export const GATE_OPS: readonly GateOp[] = ['+', '-', 'x', '/'];

export interface GateEffect {
  op: GateOp;
  value: number;
}

export function clampCount(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(MAX_COUNT, Math.floor(n)));
}

/**
 * Applies a gate to a crowd size.
 * - Division rounds to nearest (half up) and never takes a living crowd to zero,
 *   so a lone unit cannot be killed by a ÷2 gate.
 * - Results are clamped to [0, MAX_COUNT].
 */
export function applyGate(count: number, gate: GateEffect): number {
  switch (gate.op) {
    case '+':
      return clampCount(count + gate.value);
    case '-':
      return clampCount(count - gate.value);
    case 'x':
      return clampCount(count * gate.value);
    case '/':
      if (count <= 0 || gate.value <= 0) return clampCount(count);
      return clampCount(Math.max(1, Math.round(count / gate.value)));
  }
}

/** Whether a gate is "good" in general (used for coloring, not for gameplay decisions). */
export function isGoodGate(gate: GateEffect): boolean {
  switch (gate.op) {
    case '+':
      return true;
    case '-':
      return false;
    case 'x':
      return gate.value >= 1;
    case '/':
      return gate.value <= 1;
  }
}

export function gateLabel(gate: GateEffect): string {
  switch (gate.op) {
    case '+':
      return `+${gate.value}`;
    case '-':
      return `−${gate.value}`;
    case 'x':
      return `×${gate.value}`;
    case '/':
      return `÷${gate.value}`;
  }
}

export interface BattleResult {
  /** Survivors on side A (usually the player). */
  a: number;
  /** Survivors on side B. */
  b: number;
  winner: 'a' | 'b' | 'draw';
}

/**
 * Resolves a fight in one go: both sides cancel each other out one-to-one and the
 * larger side keeps the difference. A draw leaves nobody alive; modes treat a draw
 * as a defeat for the player, so winning always needs strict superiority.
 */
export function resolveBattle(a: number, b: number): BattleResult {
  const sa = Math.max(0, Math.floor(a));
  const sb = Math.max(0, Math.floor(b));
  if (sa > sb) return { a: sa - sb, b: 0, winner: 'a' };
  if (sb > sa) return { a: 0, b: sb - sa, winner: 'b' };
  return { a: 0, b: 0, winner: 'draw' };
}

/**
 * One tick of a fight that plays out over time. Removes `kills` units from each
 * side (never more than either side has). Iterating this until one side is empty
 * yields exactly the same survivors as `resolveBattle`.
 */
export function battleStep(a: number, b: number, kills: number): { a: number; b: number } {
  const k = Math.max(0, Math.min(Math.floor(kills), a, b));
  return { a: a - k, b: b - k };
}

/** Short label for crowd counters: 999, 12.3K, 450K, 1.2M. */
export function formatCount(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v < 10_000) return String(v);
  if (v < 100_000) return `${Math.floor(v / 100) / 10}K`;
  if (v < 1_000_000) return `${Math.floor(v / 1000)}K`;
  return `${Math.floor(v / 100_000) / 10}M`;
}
