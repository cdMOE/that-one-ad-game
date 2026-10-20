import { COLORS, HALF_TRACK, TRACK_WIDTH } from '../config';
import type { Camera } from '../core/camera';
import type { ObstacleDef } from '../levels/schema';

export interface Obstacle {
  def: ObstacleDef;
  /** Current lateral centre in world units (moves for swaying obstacles). */
  x: number;
  /** Half-width in world units. */
  halfWidth: number;
  hit: boolean;
}

export function createObstacle(def: ObstacleDef): Obstacle {
  return { def, x: def.x * HALF_TRACK, halfWidth: (def.width * TRACK_WIDTH) / 2, hit: false };
}

export function updateObstacle(o: Obstacle, time: number): void {
  const sway = o.def.sway;
  const base = o.def.x * HALF_TRACK;
  o.x = sway ? base + Math.sin(time * sway.speed) * sway.amplitude * HALF_TRACK : base;
  // keep the whole obstacle on the track
  o.x = Math.max(-HALF_TRACK + o.halfWidth, Math.min(HALF_TRACK - o.halfWidth, o.x));
}

export function drawObstacle(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  o: Obstacle,
  time: number,
): void {
  const s = cam.scale;
  const cx = cam.sx(o.x);
  const cy = cam.sy(o.def.at);
  const hw = o.halfWidth * s;
  ctx.globalAlpha = o.hit ? 0.35 : 1;
  if (o.def.kind === 'spikes') {
    const tooth = 0.9 * s;
    const count = Math.max(1, Math.round((hw * 2) / tooth));
    const tw = (hw * 2) / count;
    ctx.fillStyle = '#d9deff';
    ctx.strokeStyle = 'rgba(6,8,22,0.7)';
    ctx.lineWidth = 2;
    for (let i = 0; i < count; i++) {
      const x = cx - hw + i * tw;
      ctx.beginPath();
      ctx.moveTo(x, cy + 0.5 * s);
      ctx.lineTo(x + tw / 2, cy - 0.6 * s);
      ctx.lineTo(x + tw, cy + 0.5 * s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  } else {
    // saw blade: spiked disc that spins
    const r = Math.min(hw, 1.4 * s);
    const teeth = 10;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(time * 9);
    ctx.fillStyle = '#d9deff';
    ctx.strokeStyle = 'rgba(6,8,22,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < teeth * 2; i++) {
      const a = (i / (teeth * 2)) * Math.PI * 2;
      const rr = i % 2 === 0 ? r : r * 0.72;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLORS.bad;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
