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

  constructor(stage: HTMLElement, overlay: HTMLElement) {
    this.canvas.className = 'gl-canvas';
    this.canvas.hidden = true;
    stage.insertBefore(this.canvas, overlay);
  }

  /** Shows the layer and returns the renderer (created on first call). */
  acquire(): WebGLRenderer {
    if (!this.renderer) {
      this.renderer = new WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        powerPreference: 'high-performance',
      });
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
