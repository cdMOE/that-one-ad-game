import { COLORS, HALF_TRACK, MAX_VISIBLE_UNITS } from '../config';
import { Pc } from '../core/particles';
import { drawPill, drawSwarm, drawTrack, unitSprite } from '../core/render';
import { applyGate, formatCount, isGoodGate } from '../core/rules';
import { formationSpacing, Swarm, unitRadius, visibleFor } from '../core/swarm';
import { EnemyGroup } from '../entities/enemy';
import {
  createGateRow,
  drawGateRow,
  gateLaneAt,
  gateLaneCenter,
  type GateRow,
} from '../entities/gate';
import { createObstacle, drawObstacle, updateObstacle, type Obstacle } from '../entities/obstacle';
import type { RunnerLevel } from '../levels/schema';
import type { GameContext, GameMode, Outcome } from './mode';

const STEER_SPEED = 7.5; // keyboard / autopilot, world units per second
const DRAG_GAIN = 1.25; // finger travel -> world travel
const PLAYER_MAX_RADIUS = 3.0;
const FIGHT_SECONDS = 1.3; // a fight takes about this long, whatever the crowd sizes
const MIN_KILL_RATE = 14; // units per second per side, so tiny fights do not crawl
const DEATH_PARTICLE_BUDGET = 40; // particle spawns per frame for dying units

type Phase = 'run' | 'fight' | 'victory' | 'defeat';

/**
 * Auto-running mode: the crowd moves forward by itself and the player only steers
 * sideways to pick gates, dodge obstacles and line up with enemy crowds. Gates,
 * enemies and obstacles are triggered when the crowd passes their distance; an
 * optional boss waits at the end of the track.
 */
export class RunnerMode implements GameMode {
  outcome: Outcome = 'playing';
  /** Plays by itself (menu background, debugging). */
  autopilot = false;

  private readonly speed: number;
  private dist = 0;
  private px = 0;
  private count: number;
  private time = 0;
  private phase: Phase = 'run';
  private phaseTimer = 0;
  private spacing = 0.42;

  private readonly player = new Swarm(MAX_VISIBLE_UNITS);
  private readonly gates: GateRow[];
  private readonly enemies: EnemyGroup[];
  private readonly obstacles: Obstacle[];
  private nextGate = 0;
  private nextObstacle = 0;
  private fightTarget: EnemyGroup | null = null;
  private killAcc = 0;
  private deathBudget = 0;

  private readonly playerSprite = unitSprite(COLORS.player, COLORS.playerDark);
  private readonly enemySprite = unitSprite(COLORS.enemy, COLORS.enemyDark);
  private readonly bossSprite = unitSprite(COLORS.boss, COLORS.bossDark);

  private readonly onPlayerDeath = (x: number, y: number) => this.deathFx(x, y, Pc.Player);
  private readonly onEnemyDeath = (x: number, y: number) => this.deathFx(x, y, Pc.Enemy);

  constructor(
    private readonly level: RunnerLevel,
    private readonly ctx: GameContext,
  ) {
    this.speed = level.speed ?? 6;
    this.count = level.startCount;
    this.gates = level.gates.map((g) => createGateRow(g.at, g.options));
    this.enemies = level.enemies.map((e) => new EnemyGroup(e.at, e.count, (e.x ?? 0) * HALF_TRACK));
    if (level.boss) {
      this.enemies.push(
        new EnemyGroup(level.length, level.boss.count, 0, true, level.boss.name ?? 'BOSS'),
      );
    }
    this.obstacles = level.obstacles.map(createObstacle);

    this.player.setSize(visibleFor(this.count));
    this.spacing = formationSpacing(this.player.n, PLAYER_MAX_RADIUS);
    this.player.snap(0, 0, this.spacing);
  }

  get progress(): number {
    return Math.min(1, this.dist / this.level.length);
  }

  get survivors(): number {
    return this.count;
  }

  update(dt: number): void {
    const { camera } = this.ctx;
    const drag = this.ctx.input.consumeDrag();
    this.time += dt;
    this.deathBudget = DEATH_PARTICLE_BUDGET;
    for (const o of this.obstacles) updateObstacle(o, this.time);
    for (const row of this.gates) row.flash = Math.max(0, row.flash - dt * 2.2);

    let vy = 0;
    switch (this.phase) {
      case 'run':
        vy = this.speed;
        this.steer(dt, drag);
        this.dist += vy * dt;
        this.checkGates();
        this.checkObstacles();
        if (this.phase === 'run') this.checkContact();
        if (this.phase === 'run' && !this.level.boss && this.dist >= this.level.length) {
          this.beginVictory();
        }
        break;
      case 'fight':
        this.updateFight(dt);
        break;
      case 'victory':
        vy = this.speed * 0.5;
        this.dist += vy * dt;
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) this.outcome = 'won';
        break;
      case 'defeat':
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) this.outcome = 'lost';
        break;
    }

    this.spacing = formationSpacing(this.player.n, PLAYER_MAX_RADIUS);
    this.player.update(dt, this.px, this.dist, 0, vy, this.spacing, this.time);
    for (const e of this.enemies) e.update(dt, this.time);
    camera.dist = this.dist;
  }

  // ---- steering -----------------------------------------------------------

  private playerRadius(): number {
    return this.player.n === 0 ? 0 : this.spacing * Math.sqrt(this.player.n);
  }

  private steerLimit(): number {
    return Math.max(0.6, HALF_TRACK - this.playerRadius() * 0.5);
  }

  private steer(dt: number, dragPx: number): void {
    const limit = this.steerLimit();
    let move: number;
    if (this.autopilot) {
      const delta = this.autoTarget(limit) - this.px;
      const max = STEER_SPEED * dt;
      move = Math.max(-max, Math.min(max, delta));
    } else {
      move = this.ctx.input.axis * STEER_SPEED * dt + (dragPx / this.ctx.camera.scale) * DRAG_GAIN;
    }
    this.px = Math.max(-limit, Math.min(limit, this.px + move));
  }

  /** Where the autopilot wants to be: the best gate lane, dodging obstacles on the way. */
  private autoTarget(limit: number): number {
    let target = 0;
    const row = this.gates[this.nextGate];
    if (row && row.at - this.dist < 14) {
      let best = 0;
      let bestValue = -1;
      row.options.forEach((g, i) => {
        const v = applyGate(this.count, g);
        if (v > bestValue) {
          bestValue = v;
          best = i;
        }
      });
      target = gateLaneCenter(best, row.options.length);
    }
    for (let i = this.nextObstacle; i < this.obstacles.length; i++) {
      const o = this.obstacles[i];
      const ahead = o.def.at - this.dist;
      if (ahead > 7) break;
      const margin = o.halfWidth + this.playerRadius() * 0.35 + 0.4;
      if (Math.abs(target - o.x) < margin) {
        const leftSide = o.x - margin;
        const rightSide = o.x + margin;
        const rightOk = rightSide <= limit;
        const leftOk = leftSide >= -limit;
        if (rightOk && (!leftOk || Math.abs(rightSide - this.px) < Math.abs(leftSide - this.px))) {
          target = rightSide;
        } else if (leftOk) {
          target = leftSide;
        }
      }
    }
    return Math.max(-limit, Math.min(limit, target));
  }

  // ---- events -------------------------------------------------------------

  private deathFx(x: number, y: number, color: Pc): void {
    if (this.deathBudget <= 0) return;
    this.deathBudget--;
    this.ctx.particles.burst(x, y, 2, 3.5, color, 0.45, 0.15);
  }

  private syncPlayer(): void {
    this.player.setSize(visibleFor(this.count), this.onPlayerDeath, this.px, this.dist);
  }

  private checkGates(): void {
    const { particles, popups, sfx, camera } = this.ctx;
    while (this.nextGate < this.gates.length && this.gates[this.nextGate].at <= this.dist) {
      const row = this.gates[this.nextGate++];
      const lane = gateLaneAt(this.px, row.options.length);
      const effect = row.options[lane];
      const before = this.count;
      this.count = applyGate(this.count, effect);
      const delta = this.count - before;
      row.used = true;
      row.chosen = lane;
      row.flash = 1;

      const laneX = gateLaneCenter(lane, row.options.length);
      const good = delta > 0 || (delta === 0 && isGoodGate(effect));
      popups.add(
        laneX,
        row.at + 1.4,
        `${delta >= 0 ? '+' : '−'}${formatCount(Math.abs(delta))}`,
        good ? COLORS.player : COLORS.bad,
        1.15,
      );
      particles.burst(laneX, row.at, 16, 5, good ? Pc.Good : Pc.Bad, 0.55, 0.18);
      sfx.gate(good);
      camera.shake(Math.min(0.18, 0.04 + Math.abs(delta) / 400));
      this.syncPlayer();
      if (this.count <= 0) {
        this.beginDefeat();
        return;
      }
    }
  }

  private checkObstacles(): void {
    const { popups, sfx, camera } = this.ctx;
    while (
      this.nextObstacle < this.obstacles.length &&
      this.obstacles[this.nextObstacle].def.at <= this.dist
    ) {
      const o = this.obstacles[this.nextObstacle++];
      if (Math.abs(this.px - o.x) >= o.halfWidth + this.playerRadius() * 0.35) continue;
      o.hit = true;
      const damage = Math.min(o.def.damage, this.count);
      this.count -= damage;
      popups.add(this.px, this.dist + this.playerRadius() + 1, `−${damage}`, COLORS.bad, 1.1);
      sfx.hit();
      camera.shake(0.22);
      this.syncPlayer();
      if (this.count <= 0) {
        this.beginDefeat();
        return;
      }
    }
  }

  private checkContact(): void {
    const rp = this.playerRadius();
    for (const e of this.enemies) {
      if (e.dead) continue;
      const dy = e.y - this.dist;
      if (dy > 14) break; // enemies are sorted by distance
      if (dy < -14) continue;
      const dx = e.x - this.px;
      const reach = (rp + e.radius()) * 0.8;
      if (dx * dx + dy * dy < reach * reach) {
        this.phase = 'fight';
        this.fightTarget = e;
        this.killAcc = 0;
        this.ctx.camera.shake(0.12);
        this.ctx.sfx.boom();
        return;
      }
    }
  }

  private updateFight(dt: number): void {
    const e = this.fightTarget;
    if (!e) return;
    const { camera, sfx } = this.ctx;

    // the enemy crowd slides into the player's front line
    const targetY = this.dist + (this.playerRadius() + e.radius()) * 0.7;
    const k = 1 - Math.exp(-8 * dt);
    e.x += (this.px - e.x) * k;
    e.y += (targetY - e.y) * k;

    this.killAcc += Math.max(MIN_KILL_RATE, Math.min(this.count, e.count) / FIGHT_SECONDS) * dt;
    let kills = Math.floor(this.killAcc);
    if (kills > 0) {
      kills = Math.min(kills, this.count, e.count);
      this.killAcc -= kills;
      this.count -= kills;
      e.count -= kills;
      this.syncPlayer();
      e.sync(this.onEnemyDeath);
      sfx.hit();
      camera.shake(0.07);
    }

    if (this.count <= 0 || e.count <= 0) this.endFight(e);
  }

  private endFight(e: EnemyGroup): void {
    const { particles, popups, sfx, camera } = this.ctx;
    this.fightTarget = null;
    // A draw leaves nobody alive and counts as a loss: winning needs strict superiority.
    if (this.count <= 0) {
      this.beginDefeat();
      return;
    }
    e.dead = true;
    particles.burst(
      e.x,
      e.y,
      e.isBoss ? 60 : 24,
      e.isBoss ? 9 : 6,
      e.isBoss ? Pc.Boss : Pc.Enemy,
      0.8,
      0.22,
    );
    camera.shake(e.isBoss ? 0.4 : 0.2);
    sfx.boom();
    popups.add(
      this.px,
      this.dist + this.playerRadius() + 1.2,
      e.isBoss ? 'BOSS DOWN!' : 'CRUSHED!',
      COLORS.gold,
      1.2,
    );
    if (e.isBoss) this.beginVictory();
    else this.phase = 'run';
  }

  private beginVictory(): void {
    const { particles, sfx } = this.ctx;
    this.phase = 'victory';
    this.phaseTimer = 1.7;
    sfx.win();
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 4 + Math.random() * 7;
      const color = [Pc.Gold, Pc.White, Pc.Player, Pc.Good][i % 4];
      particles.emit(this.px, this.dist + 1, Math.cos(a) * s, Math.sin(a) * s + 3, 1.1, 0.2, color);
    }
  }

  private beginDefeat(): void {
    this.phase = 'defeat';
    this.phaseTimer = 0.9;
    this.ctx.sfx.lose();
    this.ctx.camera.shake(0.3);
  }

  // ---- drawing ------------------------------------------------------------

  render(g: CanvasRenderingContext2D): void {
    const { camera: cam, particles, popups } = this.ctx;
    drawTrack(g, cam, this.level.length);

    const yMin = cam.dist - cam.behind - 3;
    const yMax = cam.dist + cam.ahead + 3;
    for (const row of this.gates) {
      if (row.at > yMin && row.at < yMax) drawGateRow(g, cam, row);
    }
    for (const o of this.obstacles) {
      if (o.def.at > yMin && o.def.at < yMax) drawObstacle(g, cam, o, this.time);
    }
    for (const e of this.enemies) {
      if (e.dead) continue;
      drawSwarm(g, cam, e.swarm, e.isBoss ? this.bossSprite : this.enemySprite, e.unitRadius());
    }
    drawSwarm(g, cam, this.player, this.playerSprite, unitRadius(this.spacing));
    particles.draw(g, cam);

    const fontPx = Math.max(14, cam.scale * 0.8);
    for (const e of this.enemies) {
      if (e.dead || e.y < yMin || e.y > yMax) continue;
      const labelY = cam.sy(e.y + e.radius() + 0.9);
      if (e.isBoss) {
        drawPill(g, e.name, cam.sx(e.x), labelY - fontPx * 1.6, COLORS.bossDark, fontPx * 0.75);
        drawPill(
          g,
          formatCount(e.count),
          cam.sx(e.x),
          labelY,
          COLORS.boss,
          fontPx * 1.1,
          '#1a0b3d',
        );
      } else {
        drawPill(g, formatCount(e.count), cam.sx(e.x), labelY, COLORS.enemy, fontPx);
      }
    }
    if (this.count > 0) {
      drawPill(
        g,
        formatCount(this.count),
        cam.sx(this.px),
        cam.sy(this.dist - this.playerRadius() - 1),
        COLORS.player,
        fontPx * 1.1,
        '#04302c',
      );
    }
    popups.draw(g, cam);
  }
}
