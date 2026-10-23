import { COLORS, FONT } from '../config';
import { Pc } from '../core/particles';
import { drawPill } from '../core/render';
import { formatCount } from '../core/rules';
import { starsFor } from '../levels/analyze';
import { startSoldiers, upgradeMultiplier } from '../core/shop';
import { Swarm } from '../core/swarm';
import type { ItemDef, StationaryLevel } from '../levels/schema';
import type { GameContext, GameMode, Outcome } from './mode';
import { FORT_STAGES, fortressStage } from './stationary/fortress';
import { monsterTop } from './stationary/models';
import { JACKPOT_SCALE, ShooterScene, flightPos } from './stationary/scene';
import {
  ARENA,
  MAX_MONSTERS,
  MAX_SHOOTERS,
  MONSTERS,
  MONSTER_KIND_BY_INDEX,
  SOLDIER_SPACING,
  StationarySim,
  BLOCK_HEIGHT,
  GAME_SPEED,
  laneJackpot,
  type LaneElement,
  type RunTrace,
} from './stationary/sim';
import { WEAPONS, itemLabel } from './stationary/weapons';

const DRAG_GAIN = 1.3; // finger travel -> squad travel
const KEY_SPEED = 11; // A/D, world units per second
/**
 * Only the first few power-ups carry their captions: the camera stacks the rest behind them, and
 * the text would pile up into an unreadable column. Every tyre pile shows its number, though, all
 * the way down the lane: the big ones far off are the goals for the next runs.
 */
const LANE_LABELS = 2;

/**
 * Stationary shooter: the squad slides left and right (drag, mouse or A/D) and every
 * soldier fires one bullet dead straight ahead from its own position, so you sweep the
 * fire across the field. Monsters come down from the top right, a block
 * with an HP counter stops bullets, and the power-up behind it flies to the squad once the
 * block breaks.
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
  /** When the last power-up label popped, and how many popped in a row (see `itemCollected`). */
  private itemPopAt = -Infinity;
  private itemPopStack = 0;
  private endTimer = -1;
  private shotCounter = 0;
  private deathBudget = 0;
  private killBudget = 0;
  /** Landed elite strikes, drawn as a quick flash. */
  private readonly flashes: Array<{ x: number; half: number; life: number; hit: boolean }> = [];
  private introShown = false;
  /** Attract mode behind the menu: plays itself, silently. */
  private demo = false;
  /** The shooter screen: the level stands ready behind the cards, nothing moves until it starts. */
  private preview = false;
  private readonly coinMul: number;
  /** Coins flying from a kill up to the coin counter in the HUD (screen px, 0..1 progress). */
  private readonly flyingCoins: Array<{ x: number; y: number; t: number }> = [];
  /** Seconds until the next coin value may pop up over a kill (masses die every frame). */
  private coinLabelWait = 0;
  /** The prize at the end of the upgrade lane: its caption shows from the start. */
  private readonly jackpot: LaneElement | null;
  /** Damage the fortress at the end of the bridge shows; it crumbles as the run goes on. */
  private fortStage = 0;
  /** What cost soldiers last: if the run is lost, that is what finished it. */
  private lastBlow: 'horde' | 'volley' | null = null;
  /**
   * Damage dealt to the elites since the last damage number popped up over them, and where: the
   * bullets land every frame, so the hits are summed into one number a few times a second.
   */
  private eliteDamage = 0;
  private eliteDamageAt = { x: 0, y: 0, lift: 0 };
  private eliteDamageWait = 0;
  /**
   * Soldiers bitten since the last "−N" popped up over the squad: a horde bites many times a
   * second, so the bites are summed into one number a few times a second, not a pile of "−1"s.
   */
  private biteLoss = 0;
  private biteLossWait = 0;
  /**
   * How close the strike the squad stands in is to landing (0..1, see `Attack.t`), or -1 when it
   * stands clear of every lit zone. While it is in one, its counter turns red and an alarm beeps.
   */
  private danger = -1;
  private alarmWait = 0;
  private readonly alarm: () => void;

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
    // the menu demo plays silently. The big sounds play once per moment: a boss that calls its
    // horde in the same instant as its volley lands would otherwise roar and boom twice over
    const heard: Record<string, number> = {};
    const once = (key: string, gapMs: number, play: () => void) => {
      const now = performance.now();
      if (now - (heard[key] ?? -Infinity) < gapMs) return;
      heard[key] = now;
      play();
    };
    const sfx = {
      coin: () => !this.demo && ctx.sfx.coin(),
      shoot: () => !this.demo && ctx.sfx.shoot(),
      pop: () => !this.demo && ctx.sfx.pop(),
      boom: () => !this.demo && once('boom', 150, () => ctx.sfx.blast()),
      hit: () => !this.demo && ctx.sfx.hit(),
      gate: (good: boolean) => !this.demo && ctx.sfx.gate(good),
      win: () => !this.demo && ctx.sfx.win(),
      lose: () => !this.demo && ctx.sfx.defeat(),
      roar: () => !this.demo && once('roar', 400, () => ctx.sfx.roar()),
      // a volley lights up all its zones in the same instant: one warning for all of them
      warn: () => !this.demo && once('warn', 300, () => ctx.sfx.volley()),
      alarm: () => !this.demo && ctx.sfx.alarm(),
    };
    this.alarm = sfx.alarm;
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
          // and says what it is worth where it dropped: every big one, a few of the small ones
          if (!this.demo && (amount > 100 || this.coinLabelWait <= 0)) {
            this.coinLabelWait = 0.12;
            const worth = Math.max(1, Math.round(amount * this.coinMul));
            popups.add(x, y, `+${formatCount(worth)}`, COLORS.gold, amount > 100 ? 0.9 : 0.6);
          }
        },
        shot: (x, y) => {
          sfx.shoot();
          this.recoil = 1;
          if (++this.shotCounter % 24 === 0) {
            particles.emit(x, y + 0.2, (Math.random() - 0.5) * 2, 4, 0.1, 0.22, Pc.Gold);
          }
        },
        hit: (x, y, damage, kind) => {
          if (Math.random() < 0.2) particles.burst(x, y, 1, 3, Pc.Enemy, 0.25, 0.12);
          sfx.pop();
          if (kind === 'boss' || kind === 'miniboss') {
            this.eliteDamage += damage;
            this.eliteDamageAt = { x, y, lift: kind === 'boss' ? 2.6 : 1.9 };
          }
        },
        kill: (x, y, kind, radius) => {
          this.scene.corpse(x, y, kind, radius);
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
          sfx.warn(); // a warning blip: a strike is about to land
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
        enrage: (x, y, rage) => {
          // it has stood too long: a roar, a jolt, and its volleys come sooner from now on
          sfx.roar();
          camera.shake(0.2 + 0.05 * rage);
          popups.add(x, y + 3.5, 'RAGE!', COLORS.bad, 1.2 + 0.15 * rage);
          particles.burst(x, y, 12 + 4 * rage, 6, Pc.Bad, 0.5, 0.2);
        },
        summon: (x, y, _count, rage) => {
          // the half wave of a rage step is part of that step: RAGE! already said it, and the
          // boss bar shows no mark for it, so it only bursts out of the boss
          if (rage) {
            particles.burst(x, y + 1.5, 16, 6, Pc.Bad, 0.5, 0.2);
            return;
          }
          // it calls its horde: the loudest moment of the fight, the wave is right behind it
          sfx.roar();
          sfx.boom();
          camera.shake(0.4);
          // high over its head, clear of the coin numbers raining from the fight below
          popups.add(x, y + 5.5, 'HORDE!', COLORS.bad, 2.2);
          particles.burst(x, y + 1.5, 36, 8, Pc.Bad, 0.6, 0.22);
        },
        bite: (x, y, lost, kind, radius) => {
          this.lastBlow = 'horde';
          // it leaps at the nearest soldier of the front row and snaps; the sparks fly there
          const half = Math.max(0, this.sim.halfWidth() - 0.3);
          const at = Math.max(this.sim.squadX - half, Math.min(this.sim.squadX + half, x));
          this.scene.bite(x, y, kind, radius, at);
          particles.burst(at, 0.3, 10, 5, Pc.Bad, 0.5, 0.16);
          this.biteLoss += lost;
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
          this.scene.celebrate(this.sim.squadX);
          particles.burst(this.sim.squadX, 1, 24, 6, Pc.Good, 0.6, 0.18);
          // power-ups freed together land a quarter second apart: each label above the last one
          // instead of on top of it (MINIGUN and TRIPLE read as one word otherwise)
          this.itemPopStack = this.time - this.itemPopAt < 0.8 ? this.itemPopStack + 1 : 0;
          this.itemPopAt = this.time;
          // and a word as long as MINIGUN stays on screen with the squad at the edge of the road
          const edge = ARENA.halfWidth - 2.5;
          const x = Math.max(-edge, Math.min(edge, this.sim.squadX));
          popups.add(x, 3 + 2.8 * this.itemPopStack, label.title, COLORS.player, 1.3);
          sfx.gate(true);
          this.pillPop = 1;
        },
        itemLaunched: (x, y) => {
          // freed: it lifts off the pedestal in a puff of gold and is on its way to the squad
          particles.burst(x, y, 14, 5, Pc.Gold, 0.5, 0.18);
          sfx.coin();
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
    this.jackpot = laneJackpot(this.sim.lane.elements);
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

  /** Turns this run into the backdrop of the shooter screen: the level as it will start, waiting. */
  startPreview(): void {
    this.preview = true;
    this.introShown = true;
  }

  /** Where the demo squad wants to be: under the nearest monster, or at the front block when calm. */
  private autopilotX(): number {
    const sim = this.sim;
    let nearest = -1;
    for (let i = 0; i < MAX_MONSTERS; i++) {
      if (!sim.malive[i] || sim.my[i] > 13) continue;
      if (nearest < 0 || sim.my[i] < sim.my[nearest]) nearest = i;
    }
    if (sim.lane.elements.length > 0 && nearest < 0) return sim.lane.x;
    return nearest >= 0 ? sim.mx[nearest] : (sim.monsterMinX + sim.monsterMaxX) / 2;
  }

  get progress(): number {
    return this.sim.progress;
  }

  get survivors(): number {
    return this.sim.count;
  }

  /** How this run went, for the run log (see `runlog.ts`). */
  get facts(): {
    seconds: number;
    squad: { end: number; peak: number };
    wallLeft: number | null;
    trace: RunTrace;
  } {
    const sim = this.sim;
    return {
      seconds: Math.round((sim.time / GAME_SPEED) * 10) / 10,
      squad: { end: sim.count, peak: sim.peak },
      wallLeft: sim.wallLeft,
      trace: sim.trace,
    };
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

  /** Health left (0..1) of the boss the run did not get past, if one was on the field. */
  get bossLeft(): number | undefined {
    return this.sim.wallLeft ?? undefined;
  }

  /** Why a lost run ended, for the result screen. */
  get lossReason(): string | undefined {
    // a boss still standing is the wall the run did not get past: say how close it was
    const left = this.sim.wallLeft;
    if (left !== null && left <= 0.35)
      return `The boss had ${Math.max(1, Math.round(left * 100))}% left. It's telling everyone.`;
    if (left !== null && this.lastBlow === 'horde') return 'The boss brought friends.';
    if (left !== null) return 'The boss hit back. Hit harder.';
    if (this.lastBlow === 'volley') return 'You stood where the boss was aiming.';
    if (this.lastBlow === 'horde') return 'There were more of them than bullets.';
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
    this.coinLabelWait -= dt;
    this.popEliteDamage(dt);
    this.popBiteLoss(dt);
    for (const c of this.flyingCoins) c.t += dt * 1.6;
    while (this.flyingCoins.length > 0 && this.flyingCoins[0].t >= 1) this.flyingCoins.shift();

    // steering: keys > mouse position > finger drag
    const drag = input.consumeDrag();
    input.consumeTap();
    // the target never runs past where the squad can stand: dragging beyond the edge and back
    // must move the squad at once, not first unwind an invisible overshoot
    const limit = ARENA.halfWidth - this.sim.halfWidth();
    // finger and mouse both put the squad exactly where they say (keys still glide), so a phone
    // steers as snappily as a desktop
    this.sim.snapSquad = !this.demo && input.axis === 0;
    if (this.demo) {
      this.sim.targetX += (this.autopilotX() - this.sim.targetX) * Math.min(1, 4 * dt);
    } else if (this.preview) {
      // stands ready: the pointer over the cards must not move it
    } else if (input.axis !== 0) {
      this.sim.targetX += input.axis * KEY_SPEED * dt;
    } else if (input.usesMouse) {
      this.sim.targetX = this.scene.screenToWorldX(input.pointerX);
    } else {
      this.sim.targetX += this.scene.pxToWorld(drag) * DRAG_GAIN;
    }
    this.sim.targetX = Math.max(-limit, Math.min(limit, this.sim.targetX));

    if (!this.preview) this.sim.update(dt);
    this.updateDanger(dt);
    // every quarter of the run knocks a piece off the fortress; the win brings it down
    const stage = fortressStage(this.sim.progress);
    if (stage > this.fortStage) {
      this.fortStage = stage;
      this.scene.breakFortress(stage, this.time);
      camera.shake(stage === FORT_STAGES ? 0.5 : 0.18);
      if (!this.demo) this.ctx.sfx.blast();
    }
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

  /**
   * Damage numbers over a boss: what the squad dealt since the last one, a few times a second,
   * a little to the side each time, so a melting health bar also reads as a shower of numbers.
   */
  private popEliteDamage(dt: number): void {
    this.eliteDamageWait -= dt;
    if (this.eliteDamageWait > 0 || this.eliteDamage < 1 || this.demo) return;
    const { x, y, lift } = this.eliteDamageAt;
    const big = Math.min(1.15, 0.6 + this.eliteDamage / 400);
    const at = x + (Math.random() - 0.5) * 1.4;
    this.ctx.popups.add(
      at,
      y + lift,
      `\u2212${formatCount(Math.round(this.eliteDamage))}`,
      '#fff',
      big,
    );
    this.eliteDamage = 0;
    this.eliteDamageWait = 0.14;
  }

  /**
   * Is the squad standing in a lit strike zone? Past the halfway mark of the telegraph an alarm
   * beeps, quicker as the strike closes in, until the squad steps out.
   */
  private updateDanger(dt: number): void {
    const sim = this.sim;
    const reach = sim.halfWidth();
    this.danger = -1;
    for (const a of sim.attacks) {
      if (sim.squadX + reach >= a.lo && sim.squadX - reach <= a.hi) {
        this.danger = Math.max(this.danger, a.t);
      }
    }
    this.alarmWait -= dt;
    if (this.danger < 0.4 || this.alarmWait > 0) return;
    this.alarm();
    this.alarmWait = 0.34 - 0.16 * this.danger;
  }

  /** The squad's losses to bites, summed (see `biteLoss`), over the squad. */
  private popBiteLoss(dt: number): void {
    this.biteLossWait -= dt;
    if (this.biteLossWait > 0 || this.biteLoss < 1) return;
    const big = Math.min(1.5, 1 + this.biteLoss / 20);
    this.ctx.popups.add(this.sim.squadX, 2.4, `\u2212${this.biteLoss}`, COLORS.bad, big);
    this.biteLoss = 0;
    this.biteLossWait = 0.18;
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
    this.drawStrikeWarnings(g);
    this.drawSquadCounter(g);
    popups.drawPlaced(g, this.scene);
    if (!this.demo && !this.preview) {
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
    // the close camera can put a squad at the road's edge half off screen; its number stays on
    const margin = fontPx * 1.3;
    const x = Math.max(margin, Math.min(this.ctx.camera.width - margin, sc.sx));
    // standing in a lit strike zone: the number you watch anyway throbs red until you step out
    const fill =
      this.danger >= 0 && Math.sin(performance.now() / 55) > -0.3 ? DANGER_RED : SQUAD_BLUE;
    drawPill(g, formatCount(this.shownCount), x, sc.sy, fill, fontPx);
  }

  /**
   * A warning sign at the squad's row under every lit strike zone, over everything else on the
   * field: the zones reach from the boss to the squad, but the far end is lost in the horde, and
   * the near end is the one that matters. It pulses faster as the strike closes in, and the one
   * over the squad stands out.
   */
  private drawStrikeWarnings(g: CanvasRenderingContext2D): void {
    const sim = this.sim;
    if (sim.attacks.length === 0 || this.demo) return;
    const sc = this.scene;
    const reach = sim.halfWidth();
    const now = performance.now() / 1000;
    // zones that overlap share one sign, in the middle of the stretch they cover together
    const spans = sim.attacks.map((a) => ({ lo: a.lo, hi: a.hi, t: a.t }));
    spans.sort((a, b) => a.lo - b.lo);
    const merged: typeof spans = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s.lo <= last.hi) {
        last.hi = Math.max(last.hi, s.hi);
        last.t = Math.max(last.t, s.t);
      } else merged.push(s);
    }
    for (const a of merged) {
      sc.placeAt((a.lo + a.hi) / 2, 1.3, 0.35);
      const over = sim.squadX + reach >= a.lo && sim.squadX - reach <= a.hi;
      const pulse = 0.5 + 0.5 * Math.sin(now * (6 + 22 * a.t * a.t) * 2);
      const size =
        Math.max(22, sc.scale * 0.95) * (over ? 1.3 : 1) * (0.9 + 0.2 * a.t + 0.1 * pulse);
      drawWarningSign(g, sc.sx, sc.sy - size * 0.2, size, over, 0.7 + 0.3 * pulse);
    }
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
      // a raging boss's health throbs, harder with every rage step: the clock is running
      const rage = sim.mrage[i] / (MONSTERS[kind].elite?.maxRage ?? 1);
      const throb = 1 + 0.14 * rage * Math.abs(Math.sin(performance.now() / (110 - 40 * rage)));
      const fontPx = Math.round(Math.max(13, sc.scale * (kind === 'boss' ? 0.75 : 0.6)) * throb);
      const w = Math.max(fontPx * 4.2, sc.scale * r * 2);
      const h = fontPx * 1.35;
      drawHealthBar(g, sc.sx, sc.sy, w, h, share);
      const marks = sim.msummons[i]?.at;
      if (marks) drawHordeMarks(g, sc.sx, sc.sy, w, h, share, marks);
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
    // far to near, so the close labels are drawn over the distant ones
    const els = sim.lane.elements;
    for (let k = els.length - 1; k >= 0; k--) {
      const e = els[k];
      if (e.type === 'item' && e.item) {
        // the prize at the far end keeps its caption all the way: it is the goal of the run
        if (k < LANE_LABELS || e === this.jackpot) {
          this.drawItemLabel(g, e, e.item, sim.lane.x, e.y, 0, 1);
        }
      } else {
        this.drawBlockLabel(g, e);
      }
    }
    // a power-up on its way to the squad says what it is all the way in
    for (const f of sim.flying) {
      const at = flightPos(f, sim.squadX);
      this.drawItemLabel(g, f.el, f.item, at.x, at.y, at.h, at.size);
    }
  }

  /** The caption of the power-up `e` standing at (x, y), `h` up in the air, at `size`. */
  private drawItemLabel(
    g: CanvasRenderingContext2D,
    e: LaneElement,
    def: ItemDef,
    x: number,
    y: number,
    h: number,
    size: number,
  ): void {
    const sc = this.scene;
    // over the light column of the pedestal (the weapon floats a little lower, inside it)
    const lift = (e === this.jackpot ? JACKPOT_SCALE : 1) * size;
    sc.placeAt(x, y, h + (def.kind === 'weapon' ? 2.1 : 1.6) * lift);
    const label = itemLabel(def);
    // the far-off prize gets a bigger minimum, so it still reads out in the haze
    const minPx = e === this.jackpot ? 18 : 13;
    const titlePx = Math.round(Math.max(minPx, sc.scale * (label.title.length > 5 ? 0.42 : 0.62)));
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
    sc.placeAt((lane.blockLo + lane.blockHi) / 2, o.y - BLOCK_HEIGHT / 2, 0.6);
    const fontPx = Math.round(Math.max(11, sc.scale * 0.95));
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

/** Colour of the squad counter: the soldiers' blue, and the red it flashes while in a strike zone. */
const SQUAD_BLUE = '#2f86e8';
const DANGER_RED = '#e8243a';
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

/**
 * Notches on a boss's health bar where it calls its horde (see `SummonDef.at`): the ones still
 * ahead stand out and the next one pulses as the bar closes in on it, the ones passed fade, so
 * the bar also says when the next wave comes.
 */
function drawHordeMarks(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  share: number,
  marks: readonly number[],
): void {
  const pad = Math.max(1.5, h * 0.14);
  const left = x - w / 2 + pad;
  const inner = w - pad * 2;
  const next = marks.find((m) => m < share);
  for (const m of marks) {
    const ahead = m < share;
    // the next notch grows as the health drops towards it
    const near = m === next ? Math.max(0, 1 - (share - m) / 0.08) : 0;
    const pulse = near * (0.5 + 0.5 * Math.abs(Math.sin(performance.now() / 70)));
    const mx = left + inner * m;
    const reach = h * (0.62 + 0.25 * pulse);
    g.beginPath();
    g.moveTo(mx, y - reach);
    g.lineTo(mx, y + reach);
    g.lineCap = 'round';
    g.lineWidth = Math.max(2, h * (0.16 + 0.1 * pulse));
    g.strokeStyle = ahead ? 'rgba(20,6,10,0.9)' : 'rgba(20,6,10,0.35)';
    g.stroke();
    g.lineWidth = Math.max(1, h * (0.08 + 0.06 * pulse));
    g.strokeStyle = ahead
      ? `rgba(255,${Math.round(214 - 120 * pulse)},60,1)`
      : 'rgba(255,255,255,0.3)';
    g.stroke();
  }
}

/**
 * A red warning triangle with a white "!", `size` px wide, its centre at (x, y). The one over the
 * squad (`over`) is outlined in white.
 */
function drawWarningSign(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  over: boolean,
  alpha: number,
): void {
  const h = size * 0.88;
  const top = y - h * 0.55;
  const bottom = y + h * 0.45;
  g.save();
  g.globalAlpha = alpha;
  g.beginPath();
  g.moveTo(x, top);
  g.lineTo(x + size / 2, bottom);
  g.lineTo(x - size / 2, bottom);
  g.closePath();
  g.lineJoin = 'round';
  g.lineWidth = size * (over ? 0.2 : 0.14);
  g.strokeStyle = over ? '#fff' : 'rgba(40,6,10,0.9)';
  g.stroke();
  g.fillStyle = '#ff2a3a';
  g.fill();
  const px = Math.round(h * 0.62);
  g.font = `900 ${px}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  g.fillText('!', x, y + h * 0.1);
  g.restore();
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
