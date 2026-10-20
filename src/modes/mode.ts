import type { Sfx } from '../audio/sfx';
import type { UpgradeLevels } from '../core/shop';
import type { Camera } from '../core/camera';
import type { Input } from '../core/input';
import type { ParticleSystem, PopupSystem } from '../core/particles';

export type Outcome = 'playing' | 'won' | 'lost';

/** Everything a mode may use. The game shell owns these; modes never create their own. */
export interface GameContext {
  readonly camera: Camera;
  readonly particles: ParticleSystem;
  readonly popups: PopupSystem;
  readonly sfx: Sfx;
  readonly input: Input;
  /** The player's permanent upgrades (bought in the shop). */
  readonly upgrades: UpgradeLevels;
}

/**
 * A playable variant of the game. The shell calls `update` with a fixed-ish
 * timestep and `render` once per frame; the mode decides what the level data means.
 * To add a mode: implement this interface, register it in `modes/index.ts`, extend
 * the level schema/validator, and drop a JSON file with `"mode": "<id>"` into /src/levels.
 */
export interface GameMode {
  /** `playing` until the mode has finished its end animation. */
  readonly outcome: Outcome;
  /** Level progress for the HUD bar, 0..1. */
  readonly progress: number;
  /** Crowd size at the end (meaningful once `outcome` is not `playing`). */
  readonly survivors: number;
  /** Coins earned in this run (kept even when the run is lost). */
  readonly coinsEarned: number;
  update(dt: number): void;
  render(ctx: CanvasRenderingContext2D): void;
}
