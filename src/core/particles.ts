import { COLORS, FONT } from '../config';
import type { Camera } from './camera';

/** Palette indices for particles; keeps the pooled arrays free of strings. */
export const enum Pc {
  Player,
  Enemy,
  Boss,
  Gold,
  White,
  Good,
  Bad,
}
const PALETTE = [
  COLORS.player,
  COLORS.enemy,
  COLORS.boss,
  COLORS.gold,
  COLORS.white,
  COLORS.good,
  COLORS.bad,
];

/**
 * Fixed-size particle pool (ring buffer). Emitting never allocates; when the pool
 * is full the oldest particle is recycled, which is invisible at this scale.
 */
export class ParticleSystem {
  private readonly cap: number;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size: Float32Array;
  private readonly color: Uint8Array;
  private head = 0;

  constructor(capacity = 700) {
    this.cap = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.color = new Uint8Array(capacity);
  }

  clear(): void {
    this.life.fill(0);
  }

  emit(x: number, y: number, vx: number, vy: number, life: number, size: number, color: Pc): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.color[i] = color;
  }

  /** Radial burst of `n` particles. Speeds are in world units per second. */
  burst(x: number, y: number, n: number, speed: number, color: Pc, life = 0.5, size = 0.16): void {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.65);
      this.emit(
        x,
        y,
        Math.cos(a) * s,
        Math.sin(a) * s,
        life * (0.6 + Math.random() * 0.4),
        size,
        color,
      );
    }
  }

  update(dt: number): void {
    const drag = Math.exp(-3.2 * dt);
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.vx[i] *= drag;
      this.vy[i] *= drag;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
    }
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
    const s = cam.scale;
    let lastColor = -1;
    for (let i = 0; i < this.cap; i++) {
      const life = this.life[i];
      if (life <= 0) continue;
      const t = life / this.maxLife[i];
      if (this.color[i] !== lastColor) {
        lastColor = this.color[i];
        ctx.fillStyle = PALETTE[lastColor];
      }
      ctx.globalAlpha = t < 0.5 ? t * 2 : 1;
      const d = this.size[i] * s * (0.4 + 0.6 * t);
      ctx.fillRect(cam.sx(this.x[i]) - d / 2, cam.sy(this.y[i]) - d / 2, d, d);
    }
    ctx.globalAlpha = 1;
  }
}

const POPUP_CAP = 24;

/** Floating "+10" style numbers, pooled like the particles. */
export class PopupSystem {
  private readonly x = new Float32Array(POPUP_CAP);
  private readonly y = new Float32Array(POPUP_CAP);
  private readonly life = new Float32Array(POPUP_CAP);
  private readonly big = new Float32Array(POPUP_CAP);
  private readonly text: string[] = new Array<string>(POPUP_CAP).fill('');
  private readonly color: string[] = new Array<string>(POPUP_CAP).fill('#fff');
  private head = 0;
  private static readonly LIFE = 0.95;

  clear(): void {
    this.life.fill(0);
  }

  add(x: number, y: number, text: string, color: string, big = 1): void {
    const i = this.head;
    this.head = (this.head + 1) % POPUP_CAP;
    this.x[i] = x;
    this.y[i] = y;
    this.life[i] = PopupSystem.LIFE;
    this.big[i] = big;
    this.text[i] = text;
    this.color[i] = color;
  }

  update(dt: number): void {
    for (let i = 0; i < POPUP_CAP; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.y[i] += dt * 2.2;
    }
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (let i = 0; i < POPUP_CAP; i++) {
      const life = this.life[i];
      if (life <= 0) continue;
      const age = PopupSystem.LIFE - life;
      // quick pop-in, then fade out over the last 40%
      const pop = Math.min(1, age / 0.12);
      const scale =
        (0.6 + 0.4 * pop) * this.big[i] * (1 + 0.15 * Math.sin(Math.min(1, age / 0.2) * Math.PI));
      const alpha = Math.min(1, life / PopupSystem.LIFE / 0.4);
      const px = cam.scale * 0.85 * scale;
      ctx.globalAlpha = alpha;
      ctx.font = `900 ${px}px ${FONT}`;
      ctx.lineWidth = Math.max(3, px * 0.18);
      ctx.strokeStyle = 'rgba(8,10,28,0.85)';
      const sx = cam.sx(this.x[i]);
      const sy = cam.sy(this.y[i]);
      ctx.strokeText(this.text[i], sx, sy);
      ctx.fillStyle = this.color[i];
      ctx.fillText(this.text[i], sx, sy);
    }
    ctx.globalAlpha = 1;
  }
}
