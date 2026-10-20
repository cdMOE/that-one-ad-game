import { noUpgrades, UPGRADE_KINDS, type UpgradeLevels } from './shop';

const KEY = 'that-one-ad-game:v2';

export interface LevelResult {
  /** 1-3 stars, the best ever earned. */
  stars: number;
  /** Most survivors ever left alive. */
  best: number;
}

export interface SaveData {
  completed: Record<string, LevelResult>;
  muted: boolean;
  /** Coins in the wallet. */
  coins: number;
  /** Levels of the permanent upgrades. */
  upgrades: UpgradeLevels;
}

function isResult(v: unknown): v is LevelResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.stars === 'number' && typeof r.best === 'number';
}

/** localStorage can throw (private mode, blocked cookies), so every access is guarded. */
export function loadSave(): SaveData {
  const fresh: SaveData = { completed: {}, muted: false, coins: 0, upgrades: noUpgrades() };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw) as {
      completed?: Record<string, unknown>;
      muted?: unknown;
      coins?: unknown;
      upgrades?: Record<string, unknown>;
    };
    const completed: Record<string, LevelResult> = {};
    for (const [id, value] of Object.entries(parsed.completed ?? {})) {
      if (isResult(value)) completed[id] = value;
    }
    const upgrades = noUpgrades();
    for (const kind of UPGRADE_KINDS) {
      const v = parsed.upgrades?.[kind];
      if (typeof v === 'number' && v >= 0) upgrades[kind] = Math.floor(v);
    }
    const coins =
      typeof parsed.coins === 'number' && parsed.coins > 0 ? Math.floor(parsed.coins) : 0;
    return { completed, muted: parsed.muted === true, coins, upgrades };
  } catch {
    return fresh;
  }
}

export function writeSave(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // ignore: progress just will not persist
  }
}
