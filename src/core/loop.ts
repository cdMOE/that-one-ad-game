const MAX_STEP = 1 / 30;
const MAX_FRAME = 0.1;

/**
 * requestAnimationFrame loop. The simulation runs in steps of at most 1/30 s (a long
 * frame is split instead of making the physics explode), then one draw per frame.
 */
export class Loop {
  private raf = 0;
  private last = 0;
  /** Smoothed frames per second, for the debug overlay. */
  fps = 60;

  constructor(
    private readonly update: (dt: number) => void,
    private readonly draw: () => void,
  ) {}

  start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const frame = (now: number) => {
      this.raf = requestAnimationFrame(frame);
      let dt = Math.min(MAX_FRAME, (now - this.last) / 1000);
      this.last = now;
      if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;
      while (dt > 0) {
        const step = Math.min(dt, MAX_STEP);
        this.update(step);
        dt -= step;
      }
      this.draw();
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
