const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// Spring constants for units following their formation slot.
const STIFFNESS = 70;
const DAMPING = 12;

/**
 * How many units we actually simulate/draw for a crowd counter. Small crowds are
 * shown 1:1; bigger ones grow logarithmically so the counter can reach the
 * hundreds of thousands without the frame rate caring. Monotonic by design, so
 * the swarm visibly shrinks when the counter drops.
 */
export function visibleFor(count: number, max = 1000): number {
  if (count <= 0) return 0;
  if (count <= 250) return Math.floor(count);
  return Math.min(max, Math.round(250 + 60 * Math.log2(count / 250)));
}

/** Distance between neighbouring units; shrinks for big crowds so they stay within `maxRadius`. */
export function formationSpacing(n: number, maxRadius: number, ideal = 0.42): number {
  if (n <= 1) return ideal;
  return Math.min(ideal, maxRadius / Math.sqrt(n));
}

/**
 * Slot of unit `i` in a phalanx of `n` units with `cols` columns (units of spacing).
 * Row 0 is the front row; later rows sit behind it (negative y); a partial last row is
 * centred. Used by the shooter mode, where every soldier is also a gun.
 */
export function gridSlotX(i: number, n: number, cols: number): number {
  const row = Math.floor(i / cols);
  const inRow = Math.min(cols, n - row * cols);
  return i - row * cols - (inRow - 1) / 2;
}

export function gridSlotY(i: number, cols: number): number {
  return 0 - Math.floor(i / cols);
}

/** Drawn radius of a single unit for a given spacing. */
export function unitRadius(spacing: number): number {
  return Math.max(0.1, Math.min(0.27, spacing * 0.65));
}

/**
 * A crowd of units stored as structure-of-arrays in typed arrays: no per-unit
 * objects, no allocation while playing. Units follow their slot in a sunflower
 * (Vogel spiral) formation with a damped spring, which gives an organic swarm
 * without any O(n²) neighbour checks. Higher indices sit further out, so
 * removing from the end shrinks the crowd from its rim.
 */
export class Swarm {
  /** Number of live units (always <= capacity). */
  n = 0;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  private readonly phase: Float32Array;
  private readonly slotX: Float32Array;
  private readonly slotY: Float32Array;
  private gridCols = 0;

  constructor(readonly capacity: number) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.phase = new Float32Array(capacity);
    this.slotX = new Float32Array(capacity);
    this.slotY = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      const r = Math.sqrt(i + 0.5);
      const a = i * GOLDEN_ANGLE;
      this.slotX[i] = r * Math.cos(a);
      this.slotY[i] = r * Math.sin(a);
      this.phase[i] = Math.random() * Math.PI * 2;
    }
  }

  /** Switches from the spiral to a phalanx with `cols` columns (see `gridSlotX`). */
  useGrid(cols: number): void {
    this.gridCols = cols;
    this.relayout();
  }

  private relayout(): void {
    if (this.gridCols === 0) return;
    for (let i = 0; i < this.n; i++) {
      this.slotX[i] = gridSlotX(i, this.n, this.gridCols);
      this.slotY[i] = gridSlotY(i, this.gridCols);
    }
  }

  /**
   * Grows or shrinks to `target` units. New units pop out of a random existing
   * unit (or the fallback point if the swarm is empty) and spring to their slot.
   * `onRemove` is called with the position of every removed unit.
   */
  setSize(
    target: number,
    onRemove?: (x: number, y: number) => void,
    fallbackX = 0,
    fallbackY = 0,
  ): void {
    const t = Math.max(0, Math.min(this.capacity, Math.floor(target)));
    while (this.n > t) {
      this.n--;
      onRemove?.(this.x[this.n], this.y[this.n]);
    }
    while (this.n < t) {
      const i = this.n;
      if (i > 0) {
        const s = (Math.random() * i) | 0;
        this.x[i] = this.x[s] + (Math.random() - 0.5) * 0.2;
        this.y[i] = this.y[s] + (Math.random() - 0.5) * 0.2;
      } else {
        this.x[i] = fallbackX;
        this.y[i] = fallbackY;
      }
      this.vx[i] = 0;
      this.vy[i] = 0;
      this.n++;
    }
    this.relayout();
  }

  /** Teleports every unit onto its formation slot (used when a level starts). */
  snap(cx: number, cy: number, spacing: number): void {
    for (let i = 0; i < this.n; i++) {
      this.x[i] = cx + this.slotX[i] * spacing;
      this.y[i] = cy + this.slotY[i] * spacing;
      this.vx[i] = 0;
      this.vy[i] = 0;
    }
  }

  /**
   * Advances the swarm. (cx, cy) is the formation centre and (cvx, cvy) its velocity;
   * damping works on the velocity relative to the centre so a moving crowd keeps
   * its shape instead of trailing behind.
   */
  update(
    dt: number,
    cx: number,
    cy: number,
    cvx: number,
    cvy: number,
    spacing: number,
    time: number,
  ): void {
    const { x, y, vx, vy, phase, slotX, slotY } = this;
    for (let i = 0; i < this.n; i++) {
      const wobble = Math.sin(time * 5 + phase[i]) * 0.05;
      const tx = cx + slotX[i] * spacing + wobble;
      const ty = cy + slotY[i] * spacing + wobble * 0.7;
      vx[i] += ((tx - x[i]) * STIFFNESS + (cvx - vx[i]) * DAMPING) * dt;
      vy[i] += ((ty - y[i]) * STIFFNESS + (cvy - vy[i]) * DAMPING) * dt;
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
    }
  }
}
