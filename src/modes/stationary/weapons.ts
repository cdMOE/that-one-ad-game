import { gateLabel } from '../../core/rules';
import type { ItemDef, UpgradeStat, WeaponId } from '../../levels/schema';

/**
 * Base stats of a weapon. Every soldier carries one and fires it on its own, so these are
 * per soldier: a squad of ten fires ten bullets per volley.
 */
export interface WeaponStats {
  name: string;
  /** Shots per second per soldier. */
  rate: number;
  /** Damage of one bullet (every pellet of a shot carries it in full). */
  damage: number;
  pellets: number;
  /** Total fan angle (radians) the pellets are spread over. */
  spread: number;
  /**
   * Sideways distance between the parallel lines of a shot with more than one pellet and no fan
   * of its own (see `PELLET_GAP`).
   */
  gap: number;
  /** Bullet speed in world units per second. */
  speed: number;
  /**
   * The bullet goes through the horde, hurting every monster on its way, and only stops at an
   * elite or a lane block.
   */
  pierce?: boolean;
}

/**
 * The pellets of a TRIPLE SHOT fly side by side, this far apart (a third of `SOLDIER_SPACING`), dead
 * straight like a single shot: the squad's beam turns into a solid curtain three times as dense,
 * and it stays exactly where you aim. A fan was stronger on paper and felt weaker: the extra
 * bullets went where the player was not aiming.
 */
const PELLET_GAP = 0.2;

export const WEAPONS: Record<WeaponId, WeaponStats> = {
  pistol: { name: 'Pistol', rate: 2.2, damage: 1, pellets: 1, spread: 0, gap: 0, speed: 20 },
  rifle: { name: 'Rifle', rate: 4.5, damage: 1, pellets: 1, spread: 0, gap: 0, speed: 24 },
  minigun: {
    name: 'Minigun',
    rate: 8,
    damage: 1,
    pellets: 1,
    spread: 0,
    gap: 0,
    speed: 26,
  },
  // the prize of the last level: fewer, heavier shots that cut through the whole column
  laser: {
    name: 'Laser',
    rate: 5,
    damage: 1.6,
    pellets: 1,
    spread: 0,
    gap: 0,
    speed: 40,
    pierce: true,
  },
};

/** The squad's current weapon plus upgrades collected so far. */
export interface WeaponState {
  id: WeaponId;
  rateMul: number;
  damageMul: number;
  extraPellets: number;
}

export function newWeaponState(id: WeaponId): WeaponState {
  return { id, rateMul: 1, damageMul: 1, extraPellets: 0 };
}

export function effectiveWeapon(w: WeaponState): WeaponStats {
  const base = WEAPONS[w.id];
  return {
    ...base,
    rate: base.rate * w.rateMul,
    damage: base.damage * w.damageMul,
    pellets: base.pellets + w.extraPellets,
    gap: !base.spread && base.pellets + w.extraPellets > 1 ? PELLET_GAP : 0,
  };
}

export function applyUpgrade(w: WeaponState, stat: UpgradeStat, value: number): void {
  if (stat === 'rate') w.rateMul += value;
  else if (stat === 'damage') w.damageMul += value;
  else w.extraPellets += Math.round(value);
}

/** Text for a power-up: a big title and a small caption. */
export function itemLabel(c: ItemDef): { title: string; sub: string } {
  switch (c.kind) {
    case 'crowd':
      return { title: gateLabel(c), sub: 'SOLDIERS' };
    case 'upgrade':
      if (c.stat === 'pellets') {
        return Math.round(c.value) === 2
          ? { title: 'TRIPLE', sub: 'SHOT' }
          : { title: `+${Math.round(c.value)}`, sub: 'SPREAD' };
      }
      return {
        title: `+${Math.round(c.value * 100)}%`,
        sub: c.stat === 'rate' ? 'FIRE RATE' : 'DAMAGE',
      };
    case 'weapon':
      return { title: WEAPONS[c.weapon].name.toUpperCase(), sub: 'WEAPON' };
  }
}
