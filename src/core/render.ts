import { COLORS, FONT, HALF_TRACK } from '../config';
import type { Camera } from './camera';
import type { Swarm } from './swarm';

const spriteCache = new Map<string, HTMLCanvasElement>();
const SPRITE_PX = 48;

/**
 * Pre-rendered unit sprite: one cheap drawImage per unit beats re-stroking a path
 * a thousand times per frame, and lets us have shading for free.
 */
export function unitSprite(fill: string, dark: string): HTMLCanvasElement {
  const key = fill + dark;
  const cached = spriteCache.get(key);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE_PX;
  const g = c.getContext('2d');
  if (g) {
    const r = SPRITE_PX / 2 - 3;
    const mid = SPRITE_PX / 2;
    const grad = g.createRadialGradient(mid - r * 0.35, mid - r * 0.4, r * 0.1, mid, mid, r);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.25, fill);
    grad.addColorStop(1, dark);
    g.beginPath();
    g.arc(mid, mid, r, 0, Math.PI * 2);
    g.fillStyle = grad;
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(6,8,22,0.75)';
    g.stroke();
  }
  spriteCache.set(key, c);
  return c;
}

/** Draws every unit of a swarm with a single sprite. */
export function drawSwarm(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  swarm: Swarm,
  sprite: HTMLCanvasElement,
  radius: number,
): void {
  const r = radius * cam.scale;
  const d = r * 2;
  const baseX = cam.originX + cam.shakeX - r;
  const baseY = cam.originY + cam.dist * cam.scale + cam.shakeY - r;
  const s = cam.scale;
  const { x, y } = swarm;
  const h = cam.height + d;
  for (let i = 0; i < swarm.n; i++) {
    const sy = baseY - y[i] * s;
    if (sy < -d || sy > h) continue;
    ctx.drawImage(sprite, baseX + x[i] * s, sy, d, d);
  }
}

export function drawBackdrop(ctx: CanvasRenderingContext2D, cam: Camera): void {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, cam.width, cam.height);
}

/** Track surface, scrolling lane markers and the finish line. */
export function drawTrack(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  length: number,
  finishLine = true,
): void {
  drawBackdrop(ctx, cam);
  const s = cam.scale;
  const left = cam.sx(-HALF_TRACK);
  const w = HALF_TRACK * 2 * s;
  ctx.fillStyle = COLORS.track;
  ctx.fillRect(left, 0, w, cam.height);

  const yMin = cam.dist - cam.behind - 1;
  const yMax = cam.dist + cam.ahead + 1;

  // horizontal grid lines give a strong sense of speed
  ctx.fillStyle = 'rgba(255,255,255,0.045)';
  const step = 2;
  for (let y = Math.floor(yMin / step) * step; y < yMax; y += step) {
    ctx.fillRect(left, cam.sy(y) - 1, w, 2);
  }
  // dashed lane dividers
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  for (const lx of [-HALF_TRACK / 3, HALF_TRACK / 3]) {
    for (let y = Math.floor(yMin / 3) * 3; y < yMax; y += 3) {
      ctx.fillRect(cam.sx(lx) - 1.5, cam.sy(y + 1.4), 3, 1.4 * s);
    }
  }
  // glowing rails
  const rail = 0.18 * s;
  ctx.fillStyle = COLORS.trackEdge;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(left - rail, 0, rail, cam.height);
  ctx.fillRect(left + w, 0, rail, cam.height);
  ctx.globalAlpha = 0.12;
  ctx.fillRect(left - rail * 3.5, 0, rail * 3.5, cam.height);
  ctx.fillRect(left + w, 0, rail * 3.5, cam.height);
  ctx.globalAlpha = 1;

  if (finishLine && length > yMin && length < yMax) {
    const cell = (HALF_TRACK * 2) / 10;
    const top = cam.sy(length + cell * 2);
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 10; col++) {
        ctx.fillStyle = (row + col) % 2 === 0 ? '#ffffff' : '#10142b';
        ctx.fillRect(left + col * cell * s, top + row * cell * s, cell * s + 0.5, cell * s + 0.5);
      }
    }
  }
}

/** Rounded label with a number in it, used for crowd counters. */
export function drawPill(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  fill: string,
  fontPx: number,
  textColor: string = COLORS.white,
): void {
  ctx.font = `900 ${fontPx}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const padX = fontPx * 0.55;
  const w = ctx.measureText(text).width + padX * 2;
  const h = fontPx * 1.45;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.lineWidth = Math.max(2, fontPx * 0.1);
  ctx.strokeStyle = 'rgba(6,8,22,0.55)';
  ctx.stroke();
  ctx.fillStyle = textColor;
  ctx.fillText(text, cx, cy + fontPx * 0.04);
}

/** Little gold crown that marks the boss. `w` is its width in px. */
export function drawCrown(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number): void {
  const h = w * 0.7;
  const l = cx - w / 2;
  const t = cy - h / 2;
  ctx.beginPath();
  ctx.moveTo(l, t + h);
  ctx.lineTo(l, t + h * 0.25);
  ctx.lineTo(l + w * 0.25, t + h * 0.6);
  ctx.lineTo(cx, t);
  ctx.lineTo(l + w * 0.75, t + h * 0.6);
  ctx.lineTo(l + w, t + h * 0.25);
  ctx.lineTo(l + w, t + h);
  ctx.closePath();
  ctx.fillStyle = COLORS.gold;
  ctx.fill();
  ctx.lineWidth = Math.max(2, w * 0.07);
  ctx.strokeStyle = 'rgba(6,8,22,0.7)';
  ctx.lineJoin = 'round';
  ctx.stroke();
}
