/**
 * Unified input: touch/mouse drag (relative, so the finger never has to sit exactly
 * on the crowd), absolute pointer position and taps (for aiming and menus on the
 * canvas) and keyboard (A/D or arrow keys).
 */
export class Input {
  /** Keyboard axis: -1 (left) .. +1 (right). */
  axis = 0;
  /** True once a mouse has been seen; false again as soon as a finger touches the stage. */
  usesMouse = false;
  /** True while a finger/mouse button is held on the stage. */
  pointerDown = false;
  /** Pointer position in CSS px relative to the stage's top-left corner. */
  pointerX = 0;
  pointerY = 0;
  private dragDx = 0;
  private tap: { x: number; y: number } | null = null;
  private downAt = 0;
  private downX = 0;
  private downY = 0;
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
      this.pointerDown = true;
      this.usesMouse = e.pointerType === 'mouse';
      this.track(target, e);
      this.downAt = performance.now();
      this.downX = this.pointerX;
      this.downY = this.pointerY;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // the pointer is already gone (or synthetic): the drag still works without capture
      }
    });
    on(target, 'pointermove', (e) => {
      // a mouse can steer just by hovering
      if (e.pointerType === 'mouse') {
        this.usesMouse = true;
        this.track(target, e);
      }
      if (e.pointerId !== this.activePointer) return;
      this.dragDx += e.clientX - this.lastX;
      this.lastX = e.clientX;
      this.track(target, e);
    });
    const release = (e: PointerEvent, cancelled: boolean) => {
      if (e.pointerId !== this.activePointer) return;
      this.activePointer = null;
      this.pointerDown = false;
      this.track(target, e);
      const quick = performance.now() - this.downAt < 400;
      const still = Math.hypot(this.pointerX - this.downX, this.pointerY - this.downY) < 14;
      if (!cancelled && quick && still) this.tap = { x: this.pointerX, y: this.pointerY };
    };
    on(target, 'pointerup', (e) => release(e, false));
    on(target, 'pointercancel', (e) => release(e, true));

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
      this.pointerDown = false;
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

  private track(target: HTMLElement, e: PointerEvent): void {
    const rect = target.getBoundingClientRect();
    this.pointerX = e.clientX - rect.left;
    this.pointerY = e.clientY - rect.top;
  }

  /** Returns the last quick tap (stage CSS px) once, or null. */
  consumeTap(): { x: number; y: number } | null {
    const t = this.tap;
    this.tap = null;
    return t;
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
