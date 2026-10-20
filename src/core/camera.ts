import { VIEW_WIDTH } from '../config';

/**
 * Maps world space to canvas CSS pixels. World x is lateral, world y is the
 * distance along the track (forward = up on screen). The player sits at
 * `originY`; `dist` is the world y currently shown there.
 */
export class Camera {
  scale = 1;
  width = 0;
  height = 0;
  originX = 0;
  originY = 0;
  dist = 0;
  shakeX = 0;
  shakeY = 0;
  private shakePower = 0;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.scale = width / VIEW_WIDTH;
    this.originX = width / 2;
    this.originY = height * 0.74;
  }

  /** Adds screen shake; strength is in world units and decays quickly. */
  shake(strength: number): void {
    this.shakePower = Math.min(0.6, Math.max(this.shakePower, strength));
  }

  update(dt: number): void {
    this.shakePower *= Math.exp(-9 * dt);
    if (this.shakePower < 0.004) {
      this.shakePower = 0;
      this.shakeX = 0;
      this.shakeY = 0;
      return;
    }
    const px = this.shakePower * this.scale;
    this.shakeX = (Math.random() * 2 - 1) * px;
    this.shakeY = (Math.random() * 2 - 1) * px;
  }

  sx(x: number): number {
    return this.originX + x * this.scale + this.shakeX;
  }

  sy(y: number): number {
    return this.originY - (y - this.dist) * this.scale + this.shakeY;
  }

  /** World distance visible ahead of the player. */
  get ahead(): number {
    return this.originY / this.scale;
  }

  /** World distance visible behind the player. */
  get behind(): number {
    return (this.height - this.originY) / this.scale;
  }
}
