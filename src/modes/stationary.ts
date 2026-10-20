import { COLORS, FONT } from '../config';
import { Pc } from '../core/particles';
import { drawCrown, drawPill, drawSwarm, drawTrack, unitSprite } from '../core/render';
import { formatCount } from '../core/rules';
import { upgradeMultiplier } from '../core/shop';
import { Swarm } from '../core/swarm';
import type { ItemDef, MonsterKind, StationaryLevel } from '../levels/schema';
import type { GameContext, GameMode, Outcome } from './mode';
import {
  ARENA,
  MAX_BULLETS,
  MAX_MONSTERS,
  MAX_SHOOTERS,
  MONSTERS,
  MONSTER_KIND_BY_INDEX,
  SOLDIER_SPACING,
  StationarySim,
  type ItemState,
  type ObstacleState,
} from './stationary/sim';
import { WEAPONS, itemLabel } from './stationary/weapons';

const DRAG_GAIN = 1.3; // finger travel -> squad travel
const KEY_SPEED = 11; // A/D, world units per second
const SOLDIER_RADIUS = 0.25;

/**
 * Stationary shooter: the squad slides left and right (drag, mouse or A/D) and every
 * soldier fires one bullet straight ahead; bullets keep part of the squad's sideways speed,
 * so you sweep the fire across the field. Monsters come down from the top right, a block
 * with an HP counter stops bullets, and the power-up hidden behind it falls towards the
 * squad once the block breaks.
 *
 * All rules live in the headless `StationarySim`; this class only translates input into
 * squad movement, reacts to simulation events with effects and draws everything.
 */
export class StationaryMode implements GameMode {
  outcome: Outcome = 'playing';

  private readonly sim: StationarySim;
  private readonly player = new Swarm(MAX_SHOOTERS);
  private shownCount: number;
  private time = 0;
  private recoil = 0;
  private pillPop = 0;
  private endTimer = -1;
  private shotCounter = 0;
  private deathBudget = 0;
  private readonly coinMul: number;
  private coinPulse = 0;

  private readonly playerSprite = unitSprite(COLORS.player, COLORS.playerDark);
  private readonly sprites: Record<MonsterKind, HTMLCanvasElement> = {
    grunt: unitSprite(COLORS.enemy, COLORS.enemyDark),
    runner: unitSprite(COLORS.runner, COLORS.runnerDark),
    tank: unitSprite(COLORS.tank, COLORS.tankDark),
    boss: unitSprite(COLORS.boss, COLORS.bossDark),
  };

  private readonly onPlayerDeath = (x: number, y: number) => {
    if (this.deathBudget <= 0) return;
    this.deathBudget--;
    this.ctx.particles.burst(x, y, 2, 3.5, Pc.Player, 0.45, 0.15);
  };

  constructor(
    level: StationaryLevel,
    private readonly ctx: GameContext,
  ) {
    const { particles, popups, sfx, camera } = ctx;
    this.coinMul = upgradeMultiplier('coins', ctx.upgrades.coins);
    this.sim = new StationarySim(
      level,
      Math.random,
      {
        coin: (x, y, amount) => {
          particles.burst(x, y, Math.min(6, 1 + amount), 4, Pc.Gold, 0.45, 0.2);
          sfx.coin();
          this.coinPulse = 1;
        },
        shot: (x, y) => {
          sfx.shoot();
          this.recoil = 1;
          if (++this.shotCounter % 6 === 0) {
            particles.emit(x, y + 0.2, (Math.random() - 0.5) * 2, 4, 0.1, 0.22, Pc.Gold);
          }
        },
        hit: (x, y) => {
          if (Math.random() < 0.5) particles.burst(x, y, 1, 3, Pc.Enemy, 0.25, 0.12);
          sfx.pop();
        },
        kill: (x, y, kind) => {
          const big = kind === 'boss' || kind === 'tank';
          particles.burst(
            x,
            y,
            big ? 22 : 8,
            big ? 7 : 4.5,
            kind === 'boss' ? Pc.Boss : Pc.Enemy,
            0.6,
            0.18,
          );
          sfx.pop();
          if (big) {
            camera.shake(kind === 'boss' ? 0.5 : 0.18);
            sfx.boom();
          }
        },
        bite: (x, y, lost) => {
          particles.burst(x, y, 10, 5, Pc.Bad, 0.5, 0.16);
          popups.add(this.sim.squadX, 2.4, `−${lost}`, COLORS.bad, 1.1);
          camera.shake(0.12 + Math.min(0.3, lost / 60));
          this.pillPop = 1;
          sfx.hit();
        },
        obstacleHit: (x, y) => {
          if (Math.random() < 0.25) particles.burst(x, y, 1, 3, Pc.Gold, 0.25, 0.14);
        },
        obstacleBreak: (o) => {
          particles.burst(o.x, o.y, 40, 8, Pc.Gold, 0.8, 0.2);
          camera.shake(0.25);
          sfx.boom();
          popups.add(o.x, o.y + 1.8, 'SMASHED!', COLORS.gold, 1.1);
        },
        itemCollected: (item, delta) => {
          const label = itemLabel(item.def);
          particles.burst(this.sim.squadX, 1, 24, 6, Pc.Good, 0.6, 0.18);
          popups.add(this.sim.squadX, 3, label.title, COLORS.player, 1.3);
          sfx.gate(true);
          this.pillPop = 1;
          void delta;
        },
        itemLost: (item) => {
          popups.add(item.x, 1.5, 'MISSED', COLORS.bad, 1);
          sfx.gate(false);
        },
        waveStart: (i, total) => {
          popups.add(0, 9, total > 1 ? `WAVE ${i + 1}/${total}` : 'FIGHT!', COLORS.gold, 1.4);
        },
        waveClear: () => {
          popups.add(0, 7, 'CLEARED!', COLORS.player, 1.2);
          sfx.gate(true);
        },
        ended: (won) => {
          this.endTimer = won ? 1.7 : 1;
          if (won) {
            sfx.win();
            for (let i = 0; i < 90; i++) {
              const a = Math.random() * Math.PI * 2;
              const s = 4 + Math.random() * 7;
              const color = [Pc.Gold, Pc.White, Pc.Player, Pc.Good][i % 4];
              particles.emit(
                this.sim.squadX,
                2,
                Math.cos(a) * s,
                Math.sin(a) * s + 3,
                1.1,
                0.2,
                color,
              );
            }
          } else {
            sfx.lose();
            camera.shake(0.3);
          }
        },
      },
      {
        damageMul: upgradeMultiplier('damage', ctx.upgrades.damage),
        rateMul: upgradeMultiplier('rate', ctx.upgrades.rate),
      },
    );

    this.shownCount = this.sim.count;
    this.player.setSize(this.sim.shooters);
    this.player.useGrid(this.sim.cols);
    this.player.snap(0, 0, SOLDIER_SPACING);
  }

  get progress(): number {
    return this.sim.progress;
  }

  get survivors(): number {
    return this.sim.count;
  }

  get coinsEarned(): number {
    return Math.floor(this.sim.coinsRaw * this.coinMul);
  }

  update(dt: number): void {
    const { input, camera } = this.ctx;
    this.time += dt;
    this.deathBudget = 40;
    camera.dist = 0;
    this.recoil *= Math.exp(-12 * dt);
    this.pillPop *= Math.exp(-7 * dt);
    this.coinPulse *= Math.exp(-8 * dt);

    // steering: keys > mouse position > finger drag
    const drag = input.consumeDrag();
    input.consumeTap();
    const limit = ARENA.halfWidth;
    if (input.axis !== 0) {
      this.sim.targetX += input.axis * KEY_SPEED * dt;
    } else if (input.usesMouse) {
      this.sim.targetX = (input.pointerX - camera.originX) / camera.scale;
    } else {
      this.sim.targetX += (drag / camera.scale) * DRAG_GAIN;
    }
    this.sim.targetX = Math.max(-limit, Math.min(limit, this.sim.targetX));

    this.sim.update(dt);

    if (this.sim.count !== this.shownCount) {
      this.shownCount = this.sim.count;
      this.player.setSize(this.sim.shooters, this.onPlayerDeath, this.sim.squadX, 0);
      this.pillPop = Math.max(this.pillPop, 0.6);
    }
    this.player.useGrid(this.sim.cols);
    this.player.update(
      dt,
      this.sim.squadX,
      -this.recoil * 0.06,
      this.sim.squadVx,
      0,
      SOLDIER_SPACING,
      this.time,
    );

    if (this.endTimer >= 0) {
      this.endTimer -= dt;
      if (this.endTimer < 0) this.outcome = this.sim.phase === 'won' ? 'won' : 'lost';
    }
  }

  // ---- drawing ------------------------------------------------------------

  render(g: CanvasRenderingContext2D): void {
    const { camera: cam, particles, popups } = this.ctx;
    const sim = this.sim;
    drawTrack(g, cam, 0, false);

    for (const o of sim.obstacles)
      if (o.alive && o.item) this.drawItem(g, o.x, o.y + o.height / 2 + 0.9, o.item, true);
    for (const item of sim.items) this.drawFalling(g, item);
    for (const o of sim.obstacles) if (o.alive) this.drawObstacle(g, o);
    this.drawMonsters(g);
    this.drawBullets(g);

    drawSwarm(g, cam, this.player, this.playerSprite, SOLDIER_RADIUS);
    particles.draw(g, cam);

    if (this.shownCount > 0) {
      const rows = Math.ceil(sim.shooters / sim.cols);
      const fontPx = Math.max(14, cam.scale * 0.8) * 1.1 * (1 + 0.3 * this.pillPop);
      drawPill(
        g,
        formatCount(this.shownCount),
        cam.sx(sim.squadX),
        cam.sy(-(rows - 1) * SOLDIER_SPACING - 1),
        COLORS.player,
        fontPx,
        '#04302c',
      );
    }
    popups.draw(g, cam);
    this.drawWeaponLabel(g);
    this.drawCoins(g);
  }

  private drawCoins(g: CanvasRenderingContext2D): void {
    const cam = this.ctx.camera;
    const px = Math.max(14, cam.scale * 0.6) * (1 + 0.25 * this.coinPulse);
    const text = formatCount(this.coinsEarned);
    g.font = `900 ${px}px ${FONT}`;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    const x = cam.width - 14;
    const y = Math.max(64, cam.height * 0.1);
    g.lineJoin = 'round';
    g.lineWidth = px * 0.25;
    g.strokeStyle = 'rgba(8,10,28,0.85)';
    g.strokeText(text, x, y);
    g.fillStyle = COLORS.gold;
    g.fillText(text, x, y);
    const w = g.measureText(text).width;
    g.beginPath();
    g.arc(x - w - px * 0.6, y, px * 0.42, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = '#b8861f';
    g.stroke();
  }

  private drawBullets(g: CanvasRenderingContext2D): void {
    const cam = this.ctx.camera;
    const sim = this.sim;
    g.strokeStyle = COLORS.gold;
    g.lineWidth = Math.max(2.5, cam.scale * 0.08);
    g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i < MAX_BULLETS; i++) {
      if (sim.blife[i] <= 0) continue;
      const x = sim.bx[i];
      const y = sim.by[i];
      g.moveTo(cam.sx(x), cam.sy(y));
      g.lineTo(cam.sx(x - sim.bvx[i] * 0.02), cam.sy(y - sim.bvy[i] * 0.02));
    }
    g.stroke();
    g.lineCap = 'butt';
  }

  private drawMonsters(g: CanvasRenderingContext2D): void {
    const cam = this.ctx.camera;
    const sim = this.sim;
    const s = cam.scale;
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (!sim.malive[i]) continue;
      const kind = MONSTER_KIND_BY_INDEX[sim.mkind[i]];
      const r = MONSTERS[kind].radius;
      const sx = cam.sx(sim.mx[i]);
      const sy = cam.sy(sim.my[i]);
      const d = r * 2 * s;
      g.drawImage(this.sprites[kind], sx - d / 2, sy - d / 2, d, d);
      // angry eyes
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(sx - r * 0.3 * s, sy - r * 0.1 * s, r * 0.2 * s, 0, Math.PI * 2);
      g.arc(sx + r * 0.3 * s, sy - r * 0.1 * s, r * 0.2 * s, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#10142b';
      g.beginPath();
      g.arc(sx - r * 0.3 * s, sy - r * 0.02 * s, r * 0.09 * s, 0, Math.PI * 2);
      g.arc(sx + r * 0.3 * s, sy - r * 0.02 * s, r * 0.09 * s, 0, Math.PI * 2);
      g.fill();

      const label = formatCount(Math.ceil(sim.mhp[i]));
      const fontPx = Math.max(11, s * (kind === 'boss' ? 0.8 : 0.45));
      g.font = `900 ${fontPx}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.lineWidth = fontPx * 0.25;
      g.strokeStyle = 'rgba(8,10,28,0.9)';
      g.strokeText(label, sx, sy - d / 2 - fontPx * 0.7);
      g.fillStyle = '#fff';
      g.fillText(label, sx, sy - d / 2 - fontPx * 0.7);
      if (kind === 'boss') drawCrown(g, sx, sy - d / 2 - fontPx * 2.2, fontPx * 1.6);
    }
  }

  /** A power-up icon. `hidden` ones sit behind a block and are drawn faded. */
  private drawItem(
    g: CanvasRenderingContext2D,
    x: number,
    y: number,
    def: ItemDef,
    hidden: boolean,
  ): void {
    const cam = this.ctx.camera;
    const s = cam.scale;
    const size = 1.35 * s;
    const cx = cam.sx(x);
    const cy = cam.sy(y);
    let top: string;
    let bottom: string;
    if (def.kind === 'crowd') {
      top = '#6aa6ff';
      bottom = COLORS.good;
    } else if (def.kind === 'upgrade') {
      top = '#ffe39a';
      bottom = '#e0a21f';
    } else {
      top = '#cdb2ff';
      bottom = '#7c4dd8';
    }
    const label = itemLabel(def);
    g.globalAlpha = hidden ? 0.75 : 1;
    const bob = hidden ? 0 : Math.sin(this.time * 6) * 0.06 * s;
    const grad = g.createLinearGradient(0, cy - size / 2, 0, cy + size / 2);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    g.fillStyle = grad;
    g.beginPath();
    g.roundRect(cx - size * 0.8, cy - size / 2 + bob, size * 1.6, size, size * 0.25);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = hidden ? 'rgba(6,8,22,0.5)' : COLORS.white;
    g.stroke();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    const titlePx = size * (label.title.length > 5 ? 0.3 : 0.42);
    g.font = `900 ${titlePx}px ${FONT}`;
    g.lineWidth = titlePx * 0.18;
    g.strokeStyle = 'rgba(8,10,28,0.6)';
    g.strokeText(label.title, cx, cy - size * 0.08 + bob);
    g.fillStyle = def.kind === 'upgrade' ? '#3b2a00' : COLORS.white;
    g.fillText(label.title, cx, cy - size * 0.08 + bob);
    g.font = `800 ${size * 0.15}px ${FONT}`;
    g.fillStyle = def.kind === 'upgrade' ? 'rgba(59,42,0,0.8)' : 'rgba(255,255,255,0.9)';
    g.fillText(label.sub, cx, cy + size * 0.32 + bob);
    g.globalAlpha = 1;
  }

  private drawFalling(g: CanvasRenderingContext2D, item: ItemState): void {
    const cam = this.ctx.camera;
    // glow so the player notices it is something to catch
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.beginPath();
    g.arc(
      cam.sx(item.x),
      cam.sy(item.y),
      cam.scale * (1.3 + 0.15 * Math.sin(this.time * 8)),
      0,
      Math.PI * 2,
    );
    g.fill();
    this.drawItem(g, item.x, item.y, item.def, false);
  }

  private drawObstacle(g: CanvasRenderingContext2D, o: ObstacleState): void {
    const cam = this.ctx.camera;
    const s = cam.scale;
    const w = o.width * s;
    const h = o.height * s;
    const x = cam.sx(o.x) - w / 2;
    const y = cam.sy(o.y) - h / 2;
    const grad = g.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, '#7482ad');
    grad.addColorStop(1, '#3a4470');
    g.fillStyle = o.flash > 0.4 ? '#ffffff' : grad;
    g.beginPath();
    g.roundRect(x, y, w, h, 0.18 * s);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(6,8,22,0.8)';
    g.stroke();
    // hazard stripes along the bottom edge
    g.save();
    g.beginPath();
    g.roundRect(x, y, w, h, 0.18 * s);
    g.clip();
    g.fillStyle = 'rgba(255,209,102,0.55)';
    for (let sx = x - h; sx < x + w; sx += 0.7 * s) {
      g.beginPath();
      g.moveTo(sx, y + h);
      g.lineTo(sx + 0.35 * s, y + h);
      g.lineTo(sx + 0.35 * s + 0.2 * s, y + h - 0.2 * s);
      g.lineTo(sx + 0.2 * s, y + h - 0.2 * s);
      g.fill();
    }
    g.restore();

    const fontPx = Math.min(h * 0.62, s * 0.95);
    g.font = `900 ${fontPx}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = fontPx * 0.2;
    g.strokeStyle = 'rgba(8,10,28,0.85)';
    const label = formatCount(Math.ceil(o.hp));
    g.strokeText(label, x + w / 2, y + h / 2 - 0.05 * s);
    g.fillStyle = '#fff';
    g.fillText(label, x + w / 2, y + h / 2 - 0.05 * s);
    // hit-point bar
    g.fillStyle = 'rgba(6,8,22,0.6)';
    g.fillRect(x + 4, y + h + 4, w - 8, 5);
    g.fillStyle = COLORS.gold;
    g.fillRect(x + 4, y + h + 4, (w - 8) * Math.max(0, Math.min(1, o.hp / o.maxHp)), 5);
  }

  private drawWeaponLabel(g: CanvasRenderingContext2D): void {
    const cam = this.ctx.camera;
    const px = Math.max(11, cam.scale * 0.4);
    g.font = `800 ${px}px ${FONT}`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.fillText(WEAPONS[this.sim.weapon.id].name.toUpperCase(), 12, cam.height - 18);
  }
}
