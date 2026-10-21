import { COLORS, FONT } from '../config';
import { Pc } from '../core/particles';
import { drawPill } from '../core/render';
import { formatCount } from '../core/rules';
import { starsFor } from '../levels/analyze';
import { startSoldiers, upgradeMultiplier } from '../core/shop';
import { Swarm } from '../core/swarm';
import type { ItemDef, StationaryLevel } from '../levels/schema';
import type { GameContext, GameMode, Outcome } from './mode';
import { monsterTop } from './stationary/models';
import { ShooterScene } from './stationary/scene';
import {
  ARENA,
  MAX_MONSTERS,
  MAX_SHOOTERS,
  MONSTERS,
  MONSTER_KIND_BY_INDEX,
  SOLDIER_SPACING,
  StationarySim,
  BLOCK_HEIGHT,
  type LaneElement,
} from './stationary/sim';
import { WEAPONS, itemLabel } from './stationary/weapons';

const DRAG_GAIN = 1.3; // finger travel -> squad travel
const KEY_SPEED = 11; // A/D, world units per second
/**
 * Only the first few lane elements carry their numbers: the low camera stacks the rest behind
 * them, and their labels would pile up into an unreadable column.
 */
const LANE_LABELS = 2;

/**
 * Stationary shooter: the squad slides left and right (drag, mouse or A/D) and every
 * soldier fires one bullet dead straight ahead from its own position, so you sweep the
 * fire across the field. Monsters come down from the top right, a block
 * with an HP counter stops bullets, and the power-up hidden behind it falls towards the
 * squad once the block breaks.
 *
 * All rules live in the headless `StationarySim`; this class only translates input into
 * squad movement and reacts to simulation events with effects. The world is drawn in 3D by
 * `ShooterScene` (WebGL layer); the numbers floating over it are painted on the 2D overlay.
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
  private killBudget = 0;
  /** Landed elite strikes, drawn as a quick flash. */
  private readonly flashes: Array<{ x: number; half: number; life: number; hit: boolean }> = [];
  private introShown = false;
  /** Attract mode behind the menu: plays itself, silently. */
  private demo = false;
  private readonly coinMul: number;
  /** Coins flying from a kill up to the coin counter in the HUD (screen px, 0..1 progress). */
  private readonly flyingCoins: Array<{ x: number; y: number; t: number }> = [];
  /** What cost soldiers last: if the run is lost, that is what finished it. */
  private lastBlow: 'horde' | 'volley' | null = null;

  private readonly scene: ShooterScene;
  private viewKey = -1;

  private readonly onPlayerDeath = (x: number, y: number) => {
    if (this.deathBudget <= 0) return;
    this.deathBudget--;
    this.ctx.particles.burst(x, y, 2, 3.5, Pc.Player, 0.45, 0.15);
  };

  constructor(
    level: StationaryLevel,
    private readonly ctx: GameContext,
  ) {
    const { particles, popups, camera } = ctx;
    // the menu demo plays silently
    const sfx = {
      coin: () => !this.demo && ctx.sfx.coin(),
      shoot: () => !this.demo && ctx.sfx.shoot(),
      pop: () => !this.demo && ctx.sfx.pop(),
      boom: () => !this.demo && ctx.sfx.boom(),
      hit: () => !this.demo && ctx.sfx.hit(),
      gate: (good: boolean) => !this.demo && ctx.sfx.gate(good),
      win: () => !this.demo && ctx.sfx.win(),
      lose: () => !this.demo && ctx.sfx.lose(),
    };
    this.coinMul = upgradeMultiplier('coins', ctx.upgrades.coins) * ctx.coinFactor;
    this.sim = new StationarySim(
      level,
      Math.random,
      {
        coin: (x, y, amount) => {
          // the coin itself flies to the counter; a big payout still sparkles a little more
          particles.burst(x, y, amount > 100 ? 6 : 1, 4, Pc.Gold, 0.45, 0.2);
          sfx.coin();
          this.launchCoin(x, y);
        },
        shot: (x, y) => {
          sfx.shoot();
          this.recoil = 1;
          if (++this.shotCounter % 24 === 0) {
            particles.emit(x, y + 0.2, (Math.random() - 0.5) * 2, 4, 0.1, 0.22, Pc.Gold);
          }
        },
        hit: (x, y) => {
          if (Math.random() < 0.2) particles.burst(x, y, 1, 3, Pc.Enemy, 0.25, 0.12);
          sfx.pop();
        },
        kill: (x, y, kind) => {
          const big = kind === 'boss' || kind === 'miniboss' || kind === 'tank';
          if (big) {
            particles.burst(
              x,
              y,
              kind === 'boss' ? 30 : 16,
              7,
              kind === 'boss' ? Pc.Boss : kind === 'tank' ? Pc.Enemy : Pc.Gold,
              0.6,
              0.2,
            );
            camera.shake(kind === 'boss' ? 0.5 : kind === 'miniboss' ? 0.3 : 0.12);
            sfx.boom();
          } else if (this.killBudget > 0) {
            // masses die every frame, so cap the sparks per frame
            this.killBudget--;
            particles.burst(x, y, 2, 4, Pc.Enemy, 0.35, 0.14);
          }
          sfx.pop();
        },
        telegraph: () => {
          sfx.gate(false); // a warning blip: a strike is about to land
        },
        strike: (x, half, hit, lost) => {
          this.flashes.push({ x, half, life: 0.3, hit });
          camera.shake(hit ? 0.3 : 0.1);
          sfx.boom();
          if (hit && lost > 0) {
            this.lastBlow = 'volley';
            popups.add(this.sim.squadX, 2.4, `\u2212${lost}`, COLORS.bad, 1.1);
            particles.burst(this.sim.squadX, 0.8, 18, 6, Pc.Bad, 0.5, 0.18);
            this.pillPop = 1;
          }
        },
        bite: (x, y, lost) => {
          this.lastBlow = 'horde';
          particles.burst(x, y, 10, 5, Pc.Bad, 0.5, 0.16);
          popups.add(this.sim.squadX, 2.4, `−${lost}`, COLORS.bad, 1.1);
          camera.shake(0.12 + Math.min(0.3, lost / 60));
          this.pillPop = 1;
          sfx.hit();
        },
        blockHit: (x, y) => {
          if (Math.random() < 0.1) particles.burst(x, y, 1, 3, Pc.Gold, 0.25, 0.14);
        },
        blockBreak: (x, y) => {
          particles.burst(x, y, 30, 8, Pc.Gold, 0.7, 0.2);
          camera.shake(0.2);
          sfx.boom();
        },
        itemCollected: (_x, _y, def) => {
          const label = itemLabel(def);
          particles.burst(this.sim.squadX, 1, 24, 6, Pc.Good, 0.6, 0.18);
          popups.add(this.sim.squadX, 3, label.title, COLORS.player, 1.3);
          sfx.gate(true);
          this.pillPop = 1;
        },
        itemLost: (x) => {
          popups.add(x, 1.5, 'MISSED', COLORS.bad, 1);
          sfx.gate(false);
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
        startBonus: startSoldiers(ctx.upgrades.soldiers),
      },
    );

    this.scene = new ShooterScene(ctx.gl, this.sim, ctx.particles.cap);
    this.shownCount = this.sim.count;
    this.player.setSize(this.sim.shooters);
    this.player.useGrid(this.sim.cols);
    this.player.snap(0, 0, SOLDIER_SPACING);
  }

  /** Turns this run into the menu's attract mode: a strong squad that steers itself. */
  startDemo(): void {
    this.demo = true;
    this.introShown = true;
    this.sim.count += 16;
    this.shownCount = this.sim.count;
    this.player.setSize(this.sim.shooters);
    this.player.useGrid(this.sim.cols);
    this.player.snap(0, 0, SOLDIER_SPACING);
  }

  /** Where the demo squad wants to be: under the power-ups, otherwise under the nearest monster. */
  private autopilotX(): number {
    const sim = this.sim;
    let nearest = -1;
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (!sim.malive[i] || sim.my[i] > 13) continue;
      if (nearest < 0 || sim.my[i] < sim.my[nearest]) nearest = i;
    }
    const front = sim.lane.elements[0];
    if (front && (front.type === 'item' ? front.y < 9 : nearest < 0)) return sim.lane.x;
    return nearest >= 0 ? sim.mx[nearest] : (sim.monsterMinX + sim.monsterMaxX) / 2;
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

  /**
   * A clean run earns three stars: they measure how much of the biggest squad of the run is
   * still standing at the end. Cheap and the same for everyone, whatever they bought.
   */
  get stars(): 1 | 2 | 3 {
    return starsFor(this.sim.count, this.sim.peak);
  }

  /** Why a lost run ended, for the result screen. */
  get lossReason(): string | undefined {
    if (this.lastBlow === 'volley') return 'A boss volley wiped out your squad.';
    if (this.lastBlow === 'horde') return 'The horde broke through.';
    return undefined;
  }

  update(dt: number): void {
    const { input, camera } = this.ctx;
    this.fitView();
    this.time += dt;
    this.deathBudget = 40;
    this.killBudget = 5;
    camera.dist = 0;
    if (!this.introShown) {
      this.introShown = true;
      this.ctx.popups.add(0, 9, 'FIGHT!', COLORS.gold, 1.4);
    }
    this.recoil *= Math.exp(-12 * dt);
    this.pillPop *= Math.exp(-7 * dt);
    for (const c of this.flyingCoins) c.t += dt * 1.6;
    while (this.flyingCoins.length > 0 && this.flyingCoins[0].t >= 1) this.flyingCoins.shift();

    // steering: keys > mouse position > finger drag
    const drag = input.consumeDrag();
    input.consumeTap();
    const limit = ARENA.halfWidth;
    this.sim.snapSquad = !this.demo && input.axis === 0 && input.usesMouse;
    if (this.demo) {
      this.sim.targetX += (this.autopilotX() - this.sim.targetX) * Math.min(1, 4 * dt);
    } else if (input.axis !== 0) {
      this.sim.targetX += input.axis * KEY_SPEED * dt;
    } else if (input.usesMouse) {
      this.sim.targetX = this.scene.screenToWorldX(input.pointerX);
    } else {
      this.sim.targetX += this.scene.pxToWorld(drag) * DRAG_GAIN;
    }
    this.sim.targetX = Math.max(-limit, Math.min(limit, this.sim.targetX));

    this.sim.update(dt);
    for (const f of this.flashes) f.life -= dt;
    while (this.flashes.length > 0 && this.flashes[0].life <= 0) this.flashes.shift();

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

  /** Keeps the 3D camera framed to the canvas; cheap when nothing changed. */
  private fitView(): void {
    const { width, height } = this.ctx.camera;
    const { width: glW, height: glH, offsetX } = this.ctx.gl;
    const key = width + height * 7919 + glW * 104729 + glH * 1299709 + offsetX * 15485863;
    if (key === this.viewKey) return;
    this.viewKey = key;
    this.scene.resize(width, height);
  }

  dispose(): void {
    this.scene.dispose();
    this.ctx.gl.release();
  }

  /** Sends a coin from a world position up to the HUD counter (a few at a time, never a flood). */
  private launchCoin(x: number, y: number): void {
    if (this.demo || this.flyingCoins.length >= MAX_FLYING_COINS) return;
    this.scene.placeAt(x, y, 0.8);
    this.flyingCoins.push({ x: this.scene.sx, y: this.scene.sy, t: 0 });
  }

  // ---- drawing ------------------------------------------------------------

  render(g: CanvasRenderingContext2D): void {
    const { camera: cam, particles, popups } = this.ctx;
    this.fitView();
    this.scene.render(
      this.time,
      this.player,
      this.recoil,
      particles,
      this.flashes,
      cam.shakeX / cam.scale,
      cam.shakeY / cam.scale,
    );

    // the overlay only carries text, everything else is the 3D layer behind it
    g.clearRect(0, 0, cam.width, cam.height);
    this.drawLaneLabels(g);
    this.drawMonsterLabels(g);
    this.drawSquadCounter(g);
    popups.drawPlaced(g, this.scene);
    if (!this.demo) {
      this.drawWeaponLabel(g);
      this.drawFlyingCoins(g);
    }
  }

  private drawSquadCounter(g: CanvasRenderingContext2D): void {
    const p = this.player;
    if (this.shownCount <= 0 || p.n <= 0) return;
    const sc = this.scene;
    // pinned to the soldiers as drawn (centre, behind the back row), so it moves with them
    let sumX = 0;
    let backY = Infinity;
    for (let i = 0; i < p.n; i++) {
      sumX += p.x[i];
      if (p.y[i] < backY) backY = p.y[i];
    }
    sc.placeAt(sumX / p.n, backY - 1.1, 0.1);
    const fontPx = Math.round(Math.max(14, sc.scale * 0.8) * 1.05 * (1 + 0.3 * this.pillPop));
    drawPill(g, formatCount(this.shownCount), sc.sx, sc.sy, SQUAD_BLUE, fontPx);
  }

  /** Coins on their way to the counter at the top right, along a short arc. */
  private drawFlyingCoins(g: CanvasRenderingContext2D): void {
    const cam = this.ctx.camera;
    const tx = cam.width - 34;
    const ty = 34;
    for (const c of this.flyingCoins) {
      const t = c.t * c.t;
      // a little hop upwards first, then straight into the counter
      const x = c.x + (tx - c.x) * t;
      const y = c.y + (ty - c.y) * t - Math.sin(c.t * Math.PI) * 40;
      const r = 9 - 3 * t;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = '#ffcf33';
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = '#a86a00';
      g.stroke();
      g.beginPath();
      g.arc(x - r * 0.25, y - r * 0.25, r * 0.4, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.fill();
    }
  }

  /**
   * Health bars over the big ones: a slim bar over tanks, and over minibosses and bosses a fat
   * pill with the hit points written inside, like the boss bars in the ad shooters.
   */
  private drawMonsterLabels(g: CanvasRenderingContext2D): void {
    const sim = this.sim;
    const sc = this.scene;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (!sim.malive[i]) continue;
      const kind = MONSTER_KIND_BY_INDEX[sim.mkind[i]];
      if (kind === 'grunt' || kind === 'runner') continue;
      const r = MONSTERS[kind].radius;
      sc.placeAt(sim.mx[i], sim.my[i], monsterTop(kind) * r + 0.4);
      const share = Math.max(0, Math.min(1, sim.mhp[i] / sim.mmax[i]));
      if (kind === 'tank') {
        const w = Math.max(26, sc.scale * 1.4);
        drawHealthBar(g, sc.sx, sc.sy, w, Math.max(5, w * 0.14), share);
        continue;
      }
      const fontPx = Math.round(Math.max(13, sc.scale * (kind === 'boss' ? 0.75 : 0.6)));
      const w = Math.max(fontPx * 4.2, sc.scale * r * 2);
      const h = fontPx * 1.35;
      drawHealthBar(g, sc.sx, sc.sy, w, h, share);
      const label = formatCount(Math.ceil(sim.mhp[i]));
      g.font = `900 ${fontPx}px ${FONT}`;
      g.lineWidth = fontPx * 0.22;
      g.strokeStyle = 'rgba(40,6,10,0.9)';
      g.strokeText(label, sc.sx, sc.sy + fontPx * 0.04);
      g.fillStyle = '#fff';
      g.fillText(label, sc.sx, sc.sy + fontPx * 0.04);
    }
  }

  /** HP counters on the tyre piles and the captions over the power-ups. */
  private drawLaneLabels(g: CanvasRenderingContext2D): void {
    const sim = this.sim;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    sim.lane.elements.forEach((e, k) => {
      if (k >= LANE_LABELS) return;
      if (e.type === 'item' && e.item) this.drawItemLabel(g, e, e.item);
      else this.drawBlockLabel(g, e);
    });
  }

  private drawItemLabel(g: CanvasRenderingContext2D, e: LaneElement, def: ItemDef): void {
    const sc = this.scene;
    // over the light column of the pedestal (the weapon floats a little lower, inside it)
    sc.placeAt(this.sim.lane.x, e.y, def.kind === 'weapon' ? 2.1 : 1.6);
    const label = itemLabel(def);
    const titlePx = Math.round(Math.max(13, sc.scale * (label.title.length > 5 ? 0.42 : 0.62)));
    drawBigNumber(g, label.title, sc.sx, sc.sy, titlePx, ITEM_FILL[def.kind]);
    const subPx = Math.round(Math.max(8, titlePx * 0.36));
    g.font = `900 ${subPx}px ${FONT}`;
    g.lineWidth = subPx * 0.35;
    g.strokeStyle = 'rgba(10,16,40,0.85)';
    g.strokeText(label.sub, sc.sx, sc.sy + titlePx * 0.68);
    g.fillStyle = '#fff';
    g.fillText(label.sub, sc.sx, sc.sy + titlePx * 0.68);
  }

  private drawBlockLabel(g: CanvasRenderingContext2D, o: LaneElement): void {
    const sc = this.scene;
    const lane = this.sim.lane;
    // big orange numbers on the front of the pile, like the obstacles in the ad shooters
    sc.placeAt(lane.x, o.y - BLOCK_HEIGHT / 2, 0.6);
    const fontPx = Math.round(Math.max(14, sc.scale * 0.95));
    drawBigNumber(g, formatCount(Math.ceil(o.hp)), sc.sx, sc.sy, fontPx, BLOCK_FILL);
  }

  private drawWeaponLabel(g: CanvasRenderingContext2D): void {
    const cam = this.ctx.camera;
    const px = Math.max(11, cam.scale * 0.4);
    g.font = `800 ${px}px ${FONT}`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(20,30,60,0.75)';
    g.fillText(WEAPONS[this.sim.weapon.id].name.toUpperCase(), 12, cam.height - 18);
  }
}

/** Colour of the squad counter: the soldiers' blue. */
const SQUAD_BLUE = '#2f86e8';
const MAX_FLYING_COINS = 18;
/** Top and bottom colour of the big numbers on tyre piles: the ad shooters' orange. */
const BLOCK_FILL: [string, string] = ['#ffe27a', '#ff7b1c'];
const ITEM_FILL: Record<ItemDef['kind'], [string, string]> = {
  crowd: ['#ffffff', '#cfe6ff'],
  upgrade: ['#fff3b0', '#ffc23a'],
  weapon: ['#e6fbff', '#7fe9ff'],
};

/** A chunky game number: vertical colour gradient, a thick dark outline and a drop shadow. */
function drawBigNumber(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  px: number,
  fill: [string, string],
): void {
  g.font = `900 ${px}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = px * 0.24;
  g.strokeStyle = 'rgba(30,12,4,0.95)';
  g.strokeText(text, x, y + px * 0.08); // the shadow
  g.strokeText(text, x, y);
  const grad = g.createLinearGradient(0, y - px * 0.45, 0, y + px * 0.45);
  grad.addColorStop(0, fill[0]);
  grad.addColorStop(1, fill[1]);
  g.fillStyle = grad;
  g.fillText(text, x, y);
}

/** A rounded health bar centred on (x, y): dark track, red fill for the share that is left. */
function drawHealthBar(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  share: number,
): void {
  const l = x - w / 2;
  const t = y - h / 2;
  g.beginPath();
  g.roundRect(l, t, w, h, h / 2);
  g.fillStyle = 'rgba(20,22,34,0.85)';
  g.fill();
  if (share > 0) {
    const pad = Math.max(1.5, h * 0.14);
    g.beginPath();
    g.roundRect(
      l + pad,
      t + pad,
      Math.max(h - pad * 2, (w - pad * 2) * share),
      h - pad * 2,
      (h - pad * 2) / 2,
    );
    g.fillStyle = '#ff4433';
    g.fill();
  }
}
