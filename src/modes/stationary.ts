import { COLORS, FONT } from '../config';
import { Pc } from '../core/particles';
import { drawCrown, drawPill, drawSwarm, drawTrack, unitSprite } from '../core/render';
import { formatCount, gateLabel, isGoodGate } from '../core/rules';
import { formationSpacing, Swarm, unitRadius, visibleFor } from '../core/swarm';
import type { ChoiceDef, MonsterKind, StationaryLevel } from '../levels/schema';
import type { GameContext, GameMode, Outcome } from './mode';
import {
  MAX_BULLETS,
  MAX_MONSTERS,
  MONSTERS,
  MONSTER_KIND_BY_INDEX,
  StationarySim,
  type ObstacleState,
} from './stationary/sim';
import { WEAPONS, choiceLabel } from './stationary/weapons';

interface CardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Stationary shooter: the squad stands still and shoots automatically. By default it aims
 * at the nearest monster; holding a finger (or the mouse button) aims at that spot instead,
 * which is how you take down the HP blocks while monsters keep coming. Between waves the
 * player picks a card (more soldiers, weapon upgrades or a new weapon).
 *
 * All rules live in the headless `StationarySim`; this class only translates input into
 * aim, reacts to simulation events with effects and draws everything.
 */
export class StationaryMode implements GameMode {
  outcome: Outcome = 'playing';

  private readonly sim: StationarySim;
  private readonly player = new Swarm(1000);
  private spacing = 0.42;
  private shownCount: number;
  private time = 0;
  private recoil = 0;
  private endTimer = -1;
  private keyAimX = 0;
  private keyAimUntil = 0;
  private cards: CardRect[] = [];
  private deathBudget = 0;

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
    this.sim = new StationarySim(level, Math.random, {
      volley: (x, y, angle) => {
        sfx.shoot();
        this.recoil = 1;
        particles.emit(x, y, Math.cos(angle) * 4, Math.sin(angle) * 4, 0.12, 0.28, Pc.Gold);
      },
      hit: (x, y) => {
        particles.burst(x, y, 2, 3, Pc.Enemy, 0.3, 0.12);
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
        popups.add(0, 2.6, `−${lost}`, COLORS.bad, 1.1);
        camera.shake(0.12 + Math.min(0.3, lost / 60));
        sfx.hit();
      },
      obstacleHit: (o) => {
        particles.burst(o.x + (Math.random() - 0.5) * o.width, o.y, 1, 3, Pc.Gold, 0.3, 0.14);
        sfx.pop();
      },
      obstacleBreak: (o, delta, crashed) => {
        particles.burst(o.x, o.y, 36, 8, crashed ? Pc.Bad : Pc.Gold, 0.8, 0.2);
        camera.shake(crashed ? 0.35 : 0.22);
        sfx.boom();
        if (delta !== 0) {
          popups.add(
            o.x,
            o.y + 1,
            `${delta > 0 ? '+' : '−'}${formatCount(Math.abs(delta))}`,
            delta > 0 ? COLORS.player : COLORS.bad,
            1.2,
          );
        }
        if (crashed) camera.shake(0.35);
      },
      waveStart: (i, total) => {
        popups.add(0, 9, total > 1 ? `WAVE ${i + 1}/${total}` : 'FIGHT!', COLORS.gold, 1.4);
      },
      waveClear: () => {
        popups.add(0, 7, 'CLEARED!', COLORS.player, 1.2);
        sfx.gate(true);
      },
      chosen: (c) => {
        sfx.gate(c.kind !== 'crowd' || isGoodGate(c));
        particles.burst(0, 1, 20, 6, Pc.Good, 0.6, 0.18);
        this.pulse();
      },
      ended: (won) => {
        this.endTimer = won ? 1.7 : 1;
        if (won) {
          sfx.win();
          for (let i = 0; i < 90; i++) {
            const a = Math.random() * Math.PI * 2;
            const s = 4 + Math.random() * 7;
            const color = [Pc.Gold, Pc.White, Pc.Player, Pc.Good][i % 4];
            particles.emit(0, 2, Math.cos(a) * s, Math.sin(a) * s + 3, 1.1, 0.2, color);
          }
        } else {
          sfx.lose();
          camera.shake(0.3);
        }
      },
    });

    this.shownCount = this.sim.count;
    this.player.setSize(visibleFor(this.shownCount));
    this.spacing = formationSpacing(this.player.n, 2.6);
    this.player.snap(0, 0, this.spacing);
  }

  get progress(): number {
    return this.sim.progress;
  }

  get survivors(): number {
    return this.sim.count;
  }

  private pulse(): void {
    this.recoil = Math.max(this.recoil, 0.6);
  }

  private toWorld(sx: number, sy: number): { x: number; y: number } {
    const cam = this.ctx.camera;
    return { x: (sx - cam.originX) / cam.scale, y: cam.dist + (cam.originY - sy) / cam.scale };
  }

  update(dt: number): void {
    const { input, camera } = this.ctx;
    this.time += dt;
    this.deathBudget = 40;
    camera.dist = 0;
    this.recoil *= Math.exp(-14 * dt);

    const tap = input.consumeTap();
    if (this.sim.phase === 'choosing') {
      if (tap) {
        const i = this.cards.findIndex(
          (c) => tap.x >= c.x && tap.x <= c.x + c.w && tap.y >= c.y && tap.y <= c.y + c.h,
        );
        if (i >= 0) this.sim.choose(i);
      }
    }

    // aiming: held pointer > keyboard sweep > auto
    if (input.pointerDown && this.sim.phase !== 'choosing') {
      this.sim.aim = this.toWorld(input.pointerX, input.pointerY);
    } else if (input.axis !== 0) {
      this.keyAimX = Math.max(-6.4, Math.min(6.4, this.keyAimX + input.axis * 12 * dt));
      this.keyAimUntil = this.time + 1.2;
      this.sim.aim = { x: this.keyAimX, y: 8 };
    } else if (this.time < this.keyAimUntil) {
      this.sim.aim = { x: this.keyAimX, y: 8 };
    } else {
      this.sim.aim = null;
    }

    this.sim.update(dt);

    if (this.sim.count !== this.shownCount) {
      this.shownCount = this.sim.count;
      this.player.setSize(visibleFor(this.shownCount), this.onPlayerDeath, 0, 0);
    }
    this.spacing = formationSpacing(this.player.n, 2.6);
    const kick = this.recoil * 0.14;
    this.player.update(
      dt,
      -Math.cos(this.sim.aimAngle) * kick,
      -Math.sin(this.sim.aimAngle) * kick,
      0,
      0,
      this.spacing * (1 + 0.15 * this.recoil),
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

    for (const o of sim.obstacles) if (o.alive) this.drawObstacle(g, o);
    this.drawMonsters(g);
    this.drawBullets(g);

    drawSwarm(g, cam, this.player, this.playerSprite, unitRadius(this.spacing));
    this.drawGun(g);
    this.drawCrosshair(g);
    particles.draw(g, cam);

    if (this.shownCount > 0) {
      const fontPx = Math.max(14, cam.scale * 0.8) * 1.1 * (1 + 0.25 * this.recoil);
      drawPill(
        g,
        formatCount(this.shownCount),
        cam.sx(0),
        cam.sy(-sim.playerRadius() - 1),
        COLORS.player,
        fontPx,
        '#04302c',
      );
    }
    popups.draw(g, cam);
    this.drawWeaponLabel(g);
    if (sim.phase === 'choosing') this.drawChoices(g);
  }

  private drawGun(g: CanvasRenderingContext2D): void {
    const cam = this.ctx.camera;
    const a = this.sim.aimAngle;
    const cx = cam.sx(0);
    const cy = cam.sy(0);
    const s = cam.scale;
    g.save();
    g.translate(cx, cy);
    g.rotate(-a);
    g.fillStyle = '#2b3158';
    g.strokeStyle = 'rgba(6,8,22,0.85)';
    g.lineWidth = 2.5;
    const len = (0.5 + (1 - this.recoil * 0.25)) * s;
    g.beginPath();
    g.roundRect(0.1 * s, -0.17 * s, len, 0.34 * s, 0.08 * s);
    g.fill();
    g.stroke();
    if (this.recoil > 0.5) {
      g.fillStyle = COLORS.gold;
      g.beginPath();
      g.arc(len + 0.25 * s, 0, 0.3 * s * this.recoil, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  private drawCrosshair(g: CanvasRenderingContext2D): void {
    const sim = this.sim;
    if (sim.phase !== 'fighting') return;
    const cam = this.ctx.camera;
    const manual = sim.aim !== null;
    const t = sim.aim ?? sim.autoTarget();
    if (!t) return;
    const x = cam.sx(t.x);
    const y = cam.sy(t.y);
    const r = cam.scale * (manual ? 0.7 : 0.55);
    g.strokeStyle = manual ? COLORS.gold : 'rgba(255,255,255,0.35)';
    g.lineWidth = manual ? 3 : 2;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.moveTo(x - r * 1.35, y);
    g.lineTo(x - r * 0.6, y);
    g.moveTo(x + r * 0.6, y);
    g.lineTo(x + r * 1.35, y);
    g.moveTo(x, y - r * 1.35);
    g.lineTo(x, y - r * 0.6);
    g.moveTo(x, y + r * 0.6);
    g.lineTo(x, y + r * 1.35);
    g.stroke();
  }

  private drawBullets(g: CanvasRenderingContext2D): void {
    const cam = this.ctx.camera;
    const sim = this.sim;
    g.strokeStyle = COLORS.gold;
    g.lineWidth = Math.max(3, cam.scale * 0.1);
    g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i < MAX_BULLETS; i++) {
      if (sim.blife[i] <= 0) continue;
      const x = sim.bx[i];
      const y = sim.by[i];
      g.moveTo(cam.sx(x), cam.sy(y));
      g.lineTo(cam.sx(x - sim.bvx[i] * 0.022), cam.sy(y - sim.bvy[i] * 0.022));
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
      // angry eyes, looking at the squad
      const dir = Math.atan2(-sim.my[i], -sim.mx[i]);
      const ex = Math.cos(-dir) * r * 0.25 * s;
      const ey = Math.sin(-dir) * r * 0.25 * s;
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(sx - r * 0.3 * s + ex, sy - r * 0.15 * s + ey, r * 0.2 * s, 0, Math.PI * 2);
      g.arc(sx + r * 0.3 * s + ex, sy - r * 0.15 * s + ey, r * 0.2 * s, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#10142b';
      g.beginPath();
      g.arc(
        sx - r * 0.3 * s + ex * 1.6,
        sy - r * 0.15 * s + ey * 1.6,
        r * 0.09 * s,
        0,
        Math.PI * 2,
      );
      g.arc(
        sx + r * 0.3 * s + ex * 1.6,
        sy - r * 0.15 * s + ey * 1.6,
        r * 0.09 * s,
        0,
        Math.PI * 2,
      );
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

  private drawObstacle(g: CanvasRenderingContext2D, o: ObstacleState): void {
    const cam = this.ctx.camera;
    const s = cam.scale;
    const w = o.width * s;
    const h = o.height * s;
    const x = cam.sx(o.x) - w / 2;
    const y = cam.sy(o.y) - h / 2;
    const drifting = o.drift > 0;
    const grad = g.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, drifting ? '#a14a5a' : '#7482ad');
    grad.addColorStop(1, drifting ? '#5a1f2c' : '#3a4470');
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
    g.fillRect(x + 4, y + h + 4, (w - 8) * Math.max(0, o.hp / o.maxHp), 5);
    if (o.reward) {
      drawPill(
        g,
        `${gateLabel(o.reward)} squad`,
        x + w / 2,
        y - 0.45 * s,
        isGoodGate(o.reward) ? COLORS.good : COLORS.bad,
        Math.max(11, s * 0.42),
      );
    }
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

  private drawChoices(g: CanvasRenderingContext2D): void {
    const cam = this.ctx.camera;
    const choices = this.sim.choiceList;
    g.fillStyle = 'rgba(8,10,26,0.72)';
    g.fillRect(0, 0, cam.width, cam.height);

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = COLORS.white;
    g.font = `900 ${Math.max(22, cam.scale * 1.05)}px ${FONT}`;
    g.fillText('CHOOSE ONE', cam.width / 2, cam.height * 0.2);

    const w = cam.width * 0.84;
    const h = Math.min(92, cam.height * 0.13);
    const gap = 14;
    const total = choices.length * h + (choices.length - 1) * gap;
    const top = cam.height * 0.5 - total / 2;
    this.cards = [];
    choices.forEach((c, i) => {
      const rect = { x: (cam.width - w) / 2, y: top + i * (h + gap), w, h };
      this.cards.push(rect);
      this.drawCard(g, c, rect);
    });
  }

  private drawCard(g: CanvasRenderingContext2D, c: ChoiceDef, r: CardRect): void {
    const label = choiceLabel(c);
    let top: string;
    let bottom: string;
    if (c.kind === 'crowd') {
      const good = isGoodGate(c);
      top = good ? '#6aa6ff' : '#ff8aa0';
      bottom = good ? COLORS.good : COLORS.bad;
    } else if (c.kind === 'upgrade') {
      top = '#ffe39a';
      bottom = '#e0a21f';
    } else {
      top = '#cdb2ff';
      bottom = '#7c4dd8';
    }
    const grad = g.createLinearGradient(0, r.y, 0, r.y + r.h);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    g.fillStyle = grad;
    g.beginPath();
    g.roundRect(r.x, r.y, r.w, r.h, 18);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(6,8,22,0.6)';
    g.stroke();

    const dark = c.kind === 'upgrade';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.font = `900 ${r.h * 0.42}px ${FONT}`;
    if (!dark) {
      g.lineWidth = r.h * 0.07;
      g.strokeStyle = 'rgba(8,10,28,0.55)';
      g.strokeText(label.title, r.x + r.w / 2, r.y + r.h * 0.4);
    }
    g.fillStyle = dark ? '#3b2a00' : COLORS.white;
    g.fillText(label.title, r.x + r.w / 2, r.y + r.h * 0.4);
    g.font = `800 ${r.h * 0.17}px ${FONT}`;
    g.fillStyle = dark ? 'rgba(59,42,0,0.8)' : 'rgba(255,255,255,0.9)';
    g.fillText(label.sub, r.x + r.w / 2, r.y + r.h * 0.78);
  }
}
