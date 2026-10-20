import { COLORS, FONT, HALF_TRACK, TRACK_WIDTH } from '../config';
import type { Camera } from '../core/camera';
import { gateLabel, isGoodGate, type GateEffect } from '../core/rules';

/** Runtime state of a row of gates. */
export interface GateRow {
  at: number;
  options: GateEffect[];
  used: boolean;
  /** Which option the player went through (-1 until used). */
  chosen: number;
  /** 1 right after passing, decays to 0; drives the flash animation. */
  flash: number;
}

export function createGateRow(at: number, options: GateEffect[]): GateRow {
  return { at, options, used: false, chosen: -1, flash: 0 };
}

/** Lateral centre of option `i` in a row with `n` options. */
export function gateLaneCenter(i: number, n: number): number {
  const w = TRACK_WIDTH / n;
  return -HALF_TRACK + w * (i + 0.5);
}

/** Which option a lateral position falls into. */
export function gateLaneAt(x: number, n: number): number {
  const i = Math.floor(((x + HALF_TRACK) / TRACK_WIDTH) * n);
  return Math.max(0, Math.min(n - 1, i));
}

export function drawGateRow(ctx: CanvasRenderingContext2D, cam: Camera, row: GateRow): void {
  const n = row.options.length;
  const laneW = TRACK_WIDTH / n;
  const s = cam.scale;
  const top = cam.sy(row.at + 0.8);
  const h = 1.6 * s;
  for (let i = 0; i < n; i++) {
    const effect = row.options[i];
    const good = isGoodGate(effect);
    const picked = row.used && row.chosen === i;
    const dimmed = row.used && !picked;
    const x0 = cam.sx(-HALF_TRACK + laneW * i) + 3;
    const w = laneW * s - 6;
    const pulse = picked ? row.flash : 0;

    ctx.globalAlpha = dimmed ? 0.25 : 1;
    const base = good ? COLORS.good : COLORS.bad;
    const grad = ctx.createLinearGradient(0, top, 0, top + h);
    grad.addColorStop(0, good ? '#6aa6ff' : '#ff8aa0');
    grad.addColorStop(1, base);
    ctx.fillStyle = picked && pulse > 0.3 ? COLORS.white : grad;
    ctx.beginPath();
    ctx.roundRect(x0, top - pulse * 4, w, h + pulse * 8, 0.3 * s);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(6,8,22,0.55)';
    ctx.stroke();

    const fontPx = Math.min(1.15 * s, (laneW * s) / 3.2) * (1 + pulse * 0.35);
    ctx.font = `900 ${fontPx}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = fontPx * 0.16;
    ctx.strokeStyle = 'rgba(8,10,28,0.7)';
    const label = gateLabel(effect);
    ctx.strokeText(label, x0 + w / 2, top + h / 2 + fontPx * 0.04);
    ctx.fillStyle = picked && pulse > 0.3 ? base : COLORS.white;
    ctx.fillText(label, x0 + w / 2, top + h / 2 + fontPx * 0.04);
  }
  ctx.globalAlpha = 1;
}
