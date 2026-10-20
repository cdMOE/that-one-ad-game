import { formationSpacing, Swarm, unitRadius, visibleFor } from '../core/swarm';

const ENEMY_MAX_RADIUS = 2.4;
const BOSS_MAX_RADIUS = 3.1;

/** A stationary enemy crowd (or the boss) with its own pre-sized swarm. */
export class EnemyGroup {
  count: number;
  readonly startCount: number;
  x: number;
  y: number;
  dead = false;
  readonly swarm: Swarm;
  private readonly maxRadius: number;
  private spacing = 0.42;

  constructor(
    readonly at: number,
    count: number,
    x: number,
    readonly isBoss = false,
    readonly name = '',
  ) {
    this.count = count;
    this.startCount = count;
    this.x = x;
    this.y = at;
    this.maxRadius = isBoss ? BOSS_MAX_RADIUS : ENEMY_MAX_RADIUS;
    // Enemy counts never grow, so the swarm can be allocated once at its final size.
    this.swarm = new Swarm(Math.max(1, visibleFor(count)));
    this.swarm.setSize(visibleFor(count));
    this.updateSpacing();
    this.swarm.snap(this.x, this.y, this.spacing);
  }

  private updateSpacing(): void {
    this.spacing = formationSpacing(this.swarm.n, this.maxRadius);
  }

  radius(): number {
    return this.dead || this.swarm.n === 0 ? 0 : this.spacing * Math.sqrt(this.swarm.n);
  }

  unitRadius(): number {
    return unitRadius(this.spacing) * (this.isBoss ? 1.35 : 1);
  }

  /** Removes units to match the current counter; reports where they were. */
  sync(onRemove?: (x: number, y: number) => void): void {
    this.swarm.setSize(visibleFor(this.count), onRemove, this.x, this.y);
    this.updateSpacing();
  }

  update(dt: number, time: number): void {
    if (this.dead) return;
    this.swarm.update(dt, this.x, this.y, 0, 0, this.spacing, time);
  }
}
