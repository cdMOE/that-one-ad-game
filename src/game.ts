import { Sfx } from './audio/sfx';
import {
  REPLAY_PAYOUT,
  firstClearBonus,
  levelCoinFactor,
  upgradeCost,
  type UpgradeKind,
  type UpgradeLevels,
} from './core/shop';
import { Camera } from './core/camera';
import { GlLayer } from './core/gl';
import { Input } from './core/input';
import { Loop } from './core/loop';
import { ParticleSystem, PopupSystem } from './core/particles';
import { drawBackdrop } from './core/render';
import { loadSave, resetSave, writeSave, type SaveData } from './core/storage';
import { referenceSurvivors, starsFor } from './levels/analyze';
import { levels, type Level } from './levels';
import { createMode, type GameContext, type GameMode } from './modes';
import { RunnerMode } from './modes/runner';
import { StationaryMode } from './modes/stationary';
import { downloadRunLog, logPurchase, logReset, logRun, runCount } from './modes/stationary/runlog';
import { Ui } from './ui/ui';

type State = 'menu' | 'playing' | 'result';

const NO_3D = "Your browser can't do 3D. Turn on hardware acceleration, or try another browser.";

/** Position of a level among the shooter levels (0 = first, -1 for a runner level). */
function shooterOrder(level: Level): number {
  if (level.mode !== 'stationary') return -1;
  return levels.filter((l) => l.mode === 'stationary').indexOf(level);
}

/** Game shell: owns the canvas, the loop, shared services and the screen flow. */
export class Game {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly camera = new Camera();
  private readonly particles = new ParticleSystem();
  private readonly popups = new PopupSystem();
  private readonly sfx = new Sfx();
  private readonly input: Input;
  private readonly gl: GlLayer;
  private readonly ui: Ui;
  private readonly loop: Loop;
  private readonly ctx: GameContext;
  private readonly save: SaveData = loadSave();
  private readonly params = new URLSearchParams(location.search);
  private readonly debug = this.params.has('debug');

  private state: State = 'menu';
  private mode: GameMode | null = null;
  private levelIndex = 0;
  /** The record this shooter run is racing (0..1); 0 when there is none or it was just beaten. */
  private runRecord = 0;
  /** What a shooter run began with, for the run log; null when no shooter run is on. */
  private runStart: { upgrades: UpgradeLevels; wallet: number } | null = null;
  private backdrop: GameMode | null = null;
  /** The level standing ready behind the shooter screen (null: the menu demo plays instead). */
  private previewIndex: number | null = null;
  /** A paused shooter run: nothing moves until it is resumed or left. */
  private paused = false;

  constructor(private readonly stage: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas';
    stage.prepend(this.canvas);
    // transparent: 3D modes show their WebGL layer behind this canvas and only draw text on it
    const g = this.canvas.getContext('2d');
    if (!g) throw new Error('2D canvas is not supported in this browser');
    this.g = g;

    this.gl = new GlLayer(stage, this.canvas);
    this.input = new Input(stage);
    this.ctx = {
      camera: this.camera,
      particles: this.particles,
      popups: this.popups,
      sfx: this.sfx,
      input: this.input,
      gl: this.gl,
      upgrades: this.save.upgrades,
      coinFactor: 1,
    };
    this.sfx.setMuted(this.save.muted);

    this.ui = new Ui(
      stage,
      {
        onStartLevel: (i) => this.startLevel(i),
        onRetry: () => this.startLevel(this.levelIndex),
        onNext: () => this.startLevel(this.nextIndex(this.levelIndex)),
        onMenu: () => this.toMenu(),
        onClose: () => (this.pausable() ? this.pause() : this.toMenu()),
        onResume: () => this.resume(),
        onBuy: (kind) => this.buy(kind),
        onPreview: (i) => this.preview(i),
        onReset: () => {
          resetSave(this.save);
          logReset();
          this.ui.setData(levels, this.save, this.params.get('unlock') === 'all');
          this.ui.showMenu();
        },
        onToggleMute: () => {
          this.save.muted = !this.save.muted;
          this.sfx.setMuted(this.save.muted);
          writeSave(this.save);
          return this.save.muted;
        },
        onClick: () => {
          this.sfx.unlock();
          this.sfx.click();
        },
        runLogSize: () => runCount(),
        onExportLog: () => downloadRunLog(),
      },
      this.debug,
    );
    this.ui.setData(levels, this.save, this.params.get('unlock') === 'all');

    // Browsers only allow audio after a gesture.
    const unlock = () => this.sfx.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    // a shooter run pauses by itself when the player looks away (app switch, call, other tab)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
    });
    window.addEventListener('blur', () => this.pause());
    // a lost GL context freezes the picture: hold the run until the browser hands it back
    this.gl.onContextChange = (lost) => {
      if (lost) this.pause();
    };
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape' && e.code !== 'KeyP') return;
      if (this.paused) this.resume();
      else this.pause();
    });

    new ResizeObserver(() => this.resize()).observe(stage);
    // the 3D layer covers the whole window, which can change without the stage changing
    window.addEventListener('resize', () => this.resize());
    this.resize();

    this.loop = new Loop(
      (dt) => this.update(dt),
      () => this.draw(),
    );
    this.toMenu();
    this.loop.start();

    if (this.debug) {
      (window as unknown as { __game: Game }).__game = this;
    }
  }

  private resize(): void {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.camera.resize(w, h);
    this.gl.resize(this.stage, dpr);
  }

  private newMode(level: Level): GameMode {
    // forget them at once, so a mode that fails to build leaves nothing disposed behind
    this.mode?.dispose?.();
    this.mode = null;
    this.backdrop?.dispose?.();
    this.backdrop = null;
    this.particles.clear();
    this.popups.clear();
    this.camera.dist = 0;
    return createMode(level, this.ctx);
  }

  startLevel(index: number): void {
    if (index < 0 || index >= levels.length) return;
    if (levels[index].mode === 'stationary' && !this.gl.supported) {
      this.ui.showNotice(NO_3D);
      return;
    }
    this.leaveRun();
    this.levelIndex = index;
    // later levels pay more; a level that was already beaten pays less, so replaying it is no way
    // around the wall
    this.ctx.coinFactor =
      levelCoinFactor(shooterOrder(levels[index])) *
      (this.save.completed[levels[index].id] ? REPLAY_PAYOUT : 1);
    try {
      this.mode = this.newMode(levels[index]);
    } catch (e) {
      // the 3D renderer could not be created after all: back to the menu with a word why
      if (this.gl.supported) throw e;
      console.error(e);
      this.toMenu();
      this.ui.showNotice(NO_3D);
      return;
    }
    this.backdrop = null;
    this.previewIndex = null;
    this.state = 'playing';
    const level = levels[index];
    const record = level.mode === 'stationary' ? (this.save.progress[level.id] ?? 0) : 0;
    this.runRecord = record < 1 ? record : 0;
    this.runStart =
      level.mode === 'stationary'
        ? { upgrades: { ...this.save.upgrades }, wallet: this.save.coins }
        : null;
    this.ui.showHud(level, index, record);
    const firstOfMode = levels.findIndex((l) => l.mode === level.mode) === index;
    // only for a newcomer: a shooter run that got anywhere leaves a progress record behind
    if (firstOfMode && !this.save.completed[level.id] && !this.save.progress[level.id]) {
      if (level.mode === 'runner')
        this.ui.showHint('Drag left / right to pick the best gate', 5000);
      else this.ui.showHint('Drag to move. Shoot everything.', 4000, true);
    }
  }

  /** Only shooter runs pause; the runner keeps its old behaviour (the X leaves the level). */
  private pausable(): boolean {
    return (
      this.state === 'playing' &&
      this.mode !== null &&
      levels[this.levelIndex].mode === 'stationary'
    );
  }

  private pause(): void {
    if (this.paused || !this.pausable() || !this.mode) return;
    this.paused = true;
    this.ui.showPause(this.mode.coinsEarned);
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.input.consumeDrag(); // finger travel on the pause screen must not move the squad
    this.ui.hidePause();
  }

  /**
   * Leaving a shooter run before it ends (retry or menu from the pause screen) still banks its
   * coins and its progress record, as a lost run would.
   */
  private leaveRun(): void {
    this.paused = false;
    const mode = this.mode;
    if (this.state !== 'playing' || !mode || levels[this.levelIndex].mode !== 'stationary') return;
    this.logShooterRun(mode, 'left');
    this.save.runs++;
    this.save.coins += mode.coinsEarned;
    this.recordProgress(levels[this.levelIndex], mode.progress);
    writeSave(this.save);
  }

  /** Keeps the furthest a level was ever played; returns the record from before. */
  private recordProgress(level: Level, reached: number): number {
    const before = this.save.progress[level.id] ?? 0;
    if (reached > before) this.save.progress[level.id] = Math.min(1, reached);
    return before;
  }

  private toMenu(): void {
    this.leaveRun();
    this.state = 'menu';
    this.mode?.dispose?.();
    this.mode = null;
    this.ui.showMenu();
    this.previewIndex = null;
    this.backdrop = this.newDemo();
  }

  /**
   * The shooter screen is the level itself: level `index` stands ready behind the upgrade cards,
   * with the squad it will start with, and a tap starts it. `null` brings the menu demo back.
   */
  private preview(index: number | null): void {
    if (index === this.previewIndex || this.state !== 'menu') return;
    this.previewIndex = index;
    if (index === null || !this.gl.supported) {
      this.backdrop = this.newDemo();
      return;
    }
    const mode = this.newMode(levels[index]);
    if (mode instanceof StationaryMode) mode.startPreview();
    this.backdrop = mode;
  }

  /**
   * Attract mode: a shooter level plays itself behind the menu, so the menu shows what the game
   * looks like. Without 3D the 2D runner plays instead.
   */
  private newDemo(): GameMode {
    const shooter = levels.find((l) => l.mode === 'stationary');
    let demo: GameMode;
    try {
      demo = this.newMode(shooter && this.gl.supported ? shooter : levels[0]);
    } catch (e) {
      if (this.gl.supported) throw e;
      console.error(e);
      demo = this.newMode(levels[0]);
    }
    if (demo instanceof StationaryMode) demo.startDemo();
    else if (demo instanceof RunnerMode) demo.autopilot = true;
    return demo;
  }

  private update(dt: number): void {
    if (this.paused) return;
    const active = this.mode ?? this.backdrop;
    if (active) {
      active.update(dt);
      if (this.state === 'playing' && this.mode) {
        this.ui.setProgress(this.mode.progress);
        // the moment a run gets further than ever: cheered on the spot, not only after the run
        if (this.runRecord > 0 && this.mode.progress > this.runRecord) {
          this.runRecord = 0;
          this.ui.cheerRecord();
          this.sfx.upgrade(12);
        }
        if (levels[this.levelIndex].mode === 'stationary') {
          this.ui.setCoins(this.save.coins + this.mode.coinsEarned, this.mode.coinsEarned);
        }
        if (this.mode.outcome !== 'playing') this.finishLevel(this.mode);
      } else if (this.state === 'menu' && active.outcome !== 'playing') {
        // restart the demo whenever it ends
        this.backdrop = this.newDemo();
      }
    }
    this.camera.update(dt);
    this.particles.update(dt);
    this.popups.update(dt);
  }

  /** Index of the next level of the same mode, or -1 when it was the last one. */
  private nextIndex(index: number): number {
    const mode = levels[index].mode;
    for (let i = index + 1; i < levels.length; i++) if (levels[i].mode === mode) return i;
    return -1;
  }

  /** Spends coins on the next level of an upgrade if the wallet allows it. */
  private buy(kind: UpgradeKind): void {
    const cost = upgradeCost(kind, this.save.upgrades[kind]);
    if (!Number.isFinite(cost) || this.save.coins < cost) return; // maxed out or too poor
    this.save.coins -= cost;
    this.save.upgrades[kind]++;
    writeSave(this.save);
    logPurchase(kind);
    this.sfx.upgrade(this.save.upgrades[kind]);
    // a bought soldier steps into the waiting squad at once
    if (kind === 'soldiers' && this.previewIndex !== null) {
      const index = this.previewIndex;
      this.previewIndex = null;
      this.preview(index);
    }
  }

  /** Adds the shooter run that just ended to the run log (see `runlog.ts`). */
  private logShooterRun(mode: GameMode, result: 'won' | 'lost' | 'left'): void {
    const start = this.runStart;
    this.runStart = null;
    if (!start || !(mode instanceof StationaryMode)) return;
    logRun({
      at: new Date().toISOString(),
      level: levels[this.levelIndex].id,
      upgrades: start.upgrades,
      wallet: start.wallet,
      result,
      reached: Math.round(mode.progress * 1000) / 1000,
      earned: mode.coinsEarned,
      ...mode.facts,
    });
  }

  private finishLevel(mode: GameMode): void {
    const won = mode.outcome === 'won';
    this.logShooterRun(mode, won ? 'won' : 'lost');
    this.state = 'result';
    const level = levels[this.levelIndex];
    // coins are kept even when the run is lost: that is what makes retrying worthwhile
    this.save.coins += mode.coinsEarned;
    let stars = 0;
    let bonus = 0;
    const shooter = level.mode === 'stationary';
    if (shooter) this.save.runs++;
    const hasNext = this.nextIndex(this.levelIndex) >= 0;
    const bestBefore = shooter ? this.recordProgress(level, won ? 1 : mode.progress) : 0;
    if (won) {
      stars =
        mode.stars ??
        (level.mode === 'runner' ? starsFor(mode.survivors, referenceSurvivors(level)) : 3);
      const prev = this.save.completed[level.id];
      if (!prev && level.mode === 'stationary') {
        // the first win pays a one-off bonus that grows with the level
        bonus = firstClearBonus(shooterOrder(level));
        this.save.coins += bonus;
        if (!hasNext) this.save.beatenIn = this.save.runs;
      }
      this.save.completed[level.id] = {
        stars: Math.max(prev?.stars ?? 0, stars),
        best: Math.max(prev?.best ?? 0, mode.survivors),
      };
    }
    this.ui.setData(levels, this.save, this.params.get('unlock') === 'all');
    writeSave(this.save);
    this.ui.showResult({
      won,
      survivors: mode.survivors,
      hasNext,
      stars,
      coins: mode.coinsEarned,
      upgradesAvailable: shooter,
      bonus,
      ...(shooter ? { progress: { reached: mode.progress, bestBefore } } : {}),
      ...(mode.lossReason ? { lossReason: mode.lossReason } : {}),
      ...(mode.bossLeft !== undefined ? { bossLeft: mode.bossLeft } : {}),
      // the last shooter level beaten: the campaign is done
      ...(won && shooter && !hasNext
        ? {
            finale: {
              runs: this.save.beatenIn,
              levels: levels.filter((l) => l.mode === 'stationary').length,
            },
          }
        : {}),
    });
  }

  private draw(): void {
    const active = this.mode ?? this.backdrop;
    if (active) active.render(this.g);
    else drawBackdrop(this.g, this.camera);
    if (this.debug) {
      this.ui.setFps(this.loop.fps, `state=${this.state} lvl=${this.levelIndex + 1}`);
    }
  }
}
