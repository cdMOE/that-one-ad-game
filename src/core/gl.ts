import { WebGLRenderer } from 'three';
import { COLORS } from '../config';

/**
 * The WebGL canvas that sits behind the 2D overlay canvas. A canvas cannot hold both kinds of
 * context, so 3D modes draw their world here and their text (counters, popups) on the overlay.
 * On a wide desktop window the layer fills the whole window, so the scenery continues beside
 * the phone-shaped game column. The renderer is created on first use and shared by every 3D level, so starting a level never
 * pays for a new GL context.
 */
export class GlLayer {
  readonly canvas = document.createElement('canvas');
  private renderer: WebGLRenderer | null = null;
  /** The canvas covers the whole window (CSS px), the game column is centred in it. */
  width = 1;
  height = 1;
  /** Where the game column starts inside the canvas. */
  offsetX = 0;
  offsetY = 0;
  private dpr = 1;
  /** null until the first `supported` check. */
  private usable: boolean | null = null;
  /**
   * Called when the browser takes the GL context away (GPU reset, too many tabs, an app switch on
   * iOS) and when it gives it back. Three.js restores its state by itself once it is back.
   */
  onContextChange: ((lost: boolean) => void) | null = null;

  constructor(stage: HTMLElement, overlay: HTMLElement) {
    this.canvas.className = 'gl-canvas';
    this.canvas.hidden = true;
    stage.insertBefore(this.canvas, overlay);
    this.canvas.addEventListener('webglcontextlost', () => this.onContextChange?.(true));
    this.canvas.addEventListener('webglcontextrestored', () => this.onContextChange?.(false));
  }

  /**
   * Whether 3D can run here at all: Three.js needs WebGL 2, which old browsers, some locked-down
   * machines and disabled hardware acceleration do not offer. Probed once with a throwaway canvas.
   */
  get supported(): boolean {
    if (this.usable === null) {
      try {
        const probe = document.createElement('canvas').getContext('webgl2');
        this.usable = probe !== null;
        probe?.getExtension('WEBGL_lose_context')?.loseContext(); // give the context back at once
      } catch {
        this.usable = false;
      }
    }
    return this.usable;
  }

  /**
   * Shows the layer and returns the renderer (created on first call). Throws when the renderer
   * cannot be created after all; `supported` is false from then on.
   */
  acquire(): WebGLRenderer {
    if (!this.renderer) {
      try {
        this.renderer = new WebGLRenderer({
          canvas: this.canvas,
          antialias: true,
          powerPreference: 'high-performance',
        });
      } catch (e) {
        this.usable = false;
        throw e;
      }
      this.renderer.setClearColor(COLORS.bg);
      this.applySize();
    }
    this.canvas.hidden = false;
    return this.renderer;
  }

  /** Hides the layer again (the 2D modes draw their own background). */
  release(): void {
    this.canvas.hidden = true;
  }

  resize(stage: HTMLElement, dpr: number): void {
    const rect = stage.getBoundingClientRect();
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.offsetX = rect.left;
    this.offsetY = rect.top;
    this.dpr = dpr;
    this.applySize();
  }

  private applySize(): void {
    if (!this.renderer) return;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.width, this.height, false);
  }
}
