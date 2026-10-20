import { Sfx } from './audio/sfx';
import { Camera } from './core/camera';
import { Input } from './core/input';
import { Loop } from './core/loop';
import { ParticleSystem, PopupSystem } from './core/particles';
import { drawBackdrop } from './core/render';
import { loadSave, writeSave, type SaveData } from './core/storage';
import { analyzeRunner, starsFor } from './levels/analyze';
import { levels, type Level } from './levels';
import { createMode, type GameContext, type GameMode } from './modes';
import { RunnerMode } from './modes/runner';
import { Ui } from './ui/ui';

type State = 'menu' | 'playing' | 'result';

/** Game shell: owns the canvas, the loop, shared services and the screen flow. */
export class Game {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly camera = new Camera();
  private readonly particles = new ParticleSystem();
  private readonly popups = new PopupSystem();
  private readonly sfx = new Sfx();
  private readonly input: Input;
  private readonly ui: Ui;
  private readonly loop: Loop;
  private readonly ctx: GameContext;
  private readonly save: SaveData = loadSave();
  private readonly params = new URLSearchParams(location.search);
  private readonly debug = this.params.has('debug');

  private state: State = 'menu';
  private mode: GameMode | null = null;
  private levelIndex = 0;
  private backdrop: GameMode | null = null;

  constructor(private readonly stage: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas';
    stage.prepend(this.canvas);
    const g = this.canvas.getContext('2d', { alpha: false });
    if (!g) throw new Error('2D canvas is not supported in this browser');
    this.g = g;

    this.input = new Input(stage);
    this.ctx = {
      camera: this.camera,
      particles: this.particles,
      popups: this.popups,
      sfx: this.sfx,
      input: this.input,
    };
    this.sfx.setMuted(this.save.muted);

    this.ui = new Ui(
      stage,
      {
        onStartLevel: (i) => this.startLevel(i),
        onRetry: () => this.startLevel(this.levelIndex),
        onNext: () => this.startLevel(this.levelIndex + 1),
        onMenu: () => this.toMenu(),
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
      },
      this.debug,
    );
    this.ui.setData(levels, this.save, this.params.get('unlock') === 'all');

    // Browsers only allow audio after a gesture.
    const unlock = () => this.sfx.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    new ResizeObserver(() => this.resize()).observe(stage);
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
  }

  private newMode(level: Level): GameMode {
    this.particles.clear();
    this.popups.clear();
    this.camera.dist = 0;
    return createMode(level, this.ctx);
  }

  startLevel(index: number): void {
    if (index < 0 || index >= levels.length) return;
    this.levelIndex = index;
    this.mode = this.newMode(levels[index]);
    this.backdrop = null;
    this.state = 'playing';
    this.ui.showHud(levels[index], index);
    if (index === 0) this.ui.showHint('Drag left / right to pick the best gate');
  }

  private toMenu(): void {
    this.state = 'menu';
    this.mode = null;
    this.ui.showMenu();
    // attract mode: the first level plays itself behind the menu
    const demo = this.newMode(levels[0]);
    if (demo instanceof RunnerMode) demo.autopilot = true;
    this.backdrop = demo;
  }

  private update(dt: number): void {
    const active = this.mode ?? this.backdrop;
    if (active) {
      active.update(dt);
      if (this.state === 'playing' && this.mode) {
        this.ui.setProgress(this.mode.progress);
        if (this.mode.outcome !== 'playing') this.finishLevel(this.mode);
      } else if (this.state === 'menu' && active.outcome !== 'playing') {
        // restart the demo whenever it ends
        const demo = this.newMode(levels[0]);
        if (demo instanceof RunnerMode) demo.autopilot = true;
        this.backdrop = demo;
      }
    }
    this.camera.update(dt);
    this.particles.update(dt);
    this.popups.update(dt);
  }

  private finishLevel(mode: GameMode): void {
    const won = mode.outcome === 'won';
    this.state = 'result';
    let stars = 0;
    if (won) {
      const level = levels[this.levelIndex];
      const best = level.mode === 'runner' ? analyzeRunner(level).bestFinalCount : mode.survivors;
      stars = starsFor(mode.survivors, best);
      const prev = this.save.completed[level.id];
      this.save.completed[level.id] = {
        stars: Math.max(prev?.stars ?? 0, stars),
        best: Math.max(prev?.best ?? 0, mode.survivors),
      };
      writeSave(this.save);
    }
    this.ui.setData(levels, this.save, this.params.get('unlock') === 'all');
    this.ui.showResult(won, mode.survivors, this.levelIndex + 1 < levels.length, stars);
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
