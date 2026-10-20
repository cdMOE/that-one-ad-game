/**
 * Unified steering input: touch/mouse drag (relative, so the finger never has to
 * sit exactly on the crowd) and keyboard (A/D or arrow keys).
 */
export class Input {
  /** Keyboard axis: -1 (left) .. +1 (right). */
  axis = 0;
  private dragDx = 0;
  private activePointer: number | null = null;
  private lastX = 0;
  private left = false;
  private right = false;
  private readonly cleanup: Array<() => void> = [];

  constructor(target: HTMLElement) {
    target.style.touchAction = 'none';

    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      el.addEventListener(type, fn);
      this.cleanup.push(() => el.removeEventListener(type, fn));
    };

    on(target, 'pointerdown', (e) => {
      // Pointer capture would redirect the click away from buttons, so leave them alone.
      if (this.activePointer !== null || (e.target as Element).closest('button')) return;
      this.activePointer = e.pointerId;
      this.lastX = e.clientX;
      target.setPointerCapture(e.pointerId);
    });
    on(target, 'pointermove', (e) => {
      if (e.pointerId !== this.activePointer) return;
      this.dragDx += e.clientX - this.lastX;
      this.lastX = e.clientX;
    });
    const release = (e: PointerEvent) => {
      if (e.pointerId === this.activePointer) this.activePointer = null;
    };
    on(target, 'pointerup', release);
    on(target, 'pointercancel', release);

    const key = (e: KeyboardEvent, down: boolean) => {
      switch (e.code) {
        case 'ArrowLeft':
        case 'KeyA':
          this.left = down;
          break;
        case 'ArrowRight':
        case 'KeyD':
          this.right = down;
          break;
        default:
          return;
      }
      this.axis = (this.right ? 1 : 0) - (this.left ? 1 : 0);
      e.preventDefault();
    };
    const kd = (e: KeyboardEvent) => key(e, true);
    const ku = (e: KeyboardEvent) => key(e, false);
    const blur = () => {
      this.left = this.right = false;
      this.axis = 0;
      this.activePointer = null;
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', blur);
    this.cleanup.push(() => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('blur', blur);
    });
  }

  /** Returns the horizontal drag (CSS px) accumulated since the last call. */
  consumeDrag(): number {
    const d = this.dragDx;
    this.dragDx = 0;
    return d;
  }

  dispose(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup.length = 0;
  }
}
