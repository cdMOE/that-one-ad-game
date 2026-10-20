import { gateLabel } from '../../core/rules';
import type { ChoiceDef, UpgradeStat, WeaponId } from '../../levels/schema';

/** Base stats of a weapon. `damage` is per soldier and volley, so a bigger squad hits harder. */
export interface WeaponStats {
  name: string;
  /** Volleys per second. */
  rate: number;
  /** Damage per soldier per volley (shared by all pellets of the volley). */
  damage: number;
  pellets: number;
  /** Total fan angle (radians) the pellets are spread over. */
  spread: number;
  /** Random aim error (radians). */
  jitter: number;
  /** Bullet speed in world units per second. */
  speed: number;
}

export const WEAPONS: Record<WeaponId, WeaponStats> = {
  pistol: { name: 'Pistol', rate: 3, damage: 0.5, pellets: 1, spread: 0, jitter: 0.02, speed: 24 },
  rifle: { name: 'Rifle', rate: 6, damage: 0.35, pellets: 1, spread: 0, jitter: 0.05, speed: 28 },
  shotgun: {
    name: 'Shotgun',
    rate: 1.8,
    damage: 1.6,
    pellets: 5,
    spread: 0.5,
    jitter: 0.05,
    speed: 22,
  },
  minigun: {
    name: 'Minigun',
    rate: 12,
    damage: 0.2,
    pellets: 1,
    spread: 0,
    jitter: 0.14,
    speed: 30,
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

export interface EffectiveWeapon extends WeaponStats {
  /** Damage per volley per soldier after upgrades. */
  total: number;
}

export function effectiveWeapon(w: WeaponState): EffectiveWeapon {
  const base = WEAPONS[w.id];
  return {
    ...base,
    rate: base.rate * w.rateMul,
    damage: base.damage * w.damageMul,
    pellets: base.pellets + w.extraPellets,
    total: base.damage * w.damageMul,
  };
}

export function applyUpgrade(w: WeaponState, stat: UpgradeStat, value: number): void {
  if (stat === 'rate') w.rateMul += value;
  else if (stat === 'damage') w.damageMul += value;
  else w.extraPellets += Math.round(value);
}

/** Text for a choice card: a big title and a small caption. */
export function choiceLabel(c: ChoiceDef): { title: string; sub: string } {
  switch (c.kind) {
    case 'crowd':
      return { title: gateLabel(c), sub: 'SQUAD' };
    case 'upgrade':
      if (c.stat === 'pellets')
        return { title: `+${Math.round(c.value)}`, sub: 'PELLETS PER SHOT' };
      return {
        title: `+${Math.round(c.value * 100)}%`,
        sub: c.stat === 'rate' ? 'FIRE RATE' : 'DAMAGE',
      };
    case 'weapon':
      return { title: WEAPONS[c.weapon].name.toUpperCase(), sub: 'NEW WEAPON' };
  }
}
