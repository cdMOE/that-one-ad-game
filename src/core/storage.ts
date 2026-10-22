import { COIN_SCALE, noUpgrades, UPGRADE_KINDS, UPGRADES, type UpgradeLevels } from './shop';

const KEY = 'that-one-ad-game:v2';

/**
 * How `SaveData.progress` is measured. Records of an older measure are dropped on load: since
 * bosses count by their health, an old 99% stood for "reached the boss" and would be a record no
 * run could beat until the boss was nearly down.
 */
const PROGRESS_VERSION = 2;

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
  /** Furthest any run of a level got (0..1, the HUD progress), so a lost run can show a record. */
  progress: Record<string, number>;
}

function isResult(v: unknown): v is LevelResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.stars === 'number' && typeof r.best === 'number';
}

/** localStorage can throw (private mode, blocked cookies), so every access is guarded. */
export function loadSave(): SaveData {
  const fresh: SaveData = {
    completed: {},
    muted: false,
    coins: 0,
    upgrades: noUpgrades(),
    progress: {},
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw) as {
      completed?: Record<string, unknown>;
      muted?: unknown;
      coins?: unknown;
      coinScale?: unknown;
      upgrades?: Record<string, unknown>;
      progress?: Record<string, unknown>;
      progressVersion?: unknown;
    };
    const completed: Record<string, LevelResult> = {};
    for (const [id, value] of Object.entries(parsed.completed ?? {})) {
      if (isResult(value)) completed[id] = value;
    }
    const upgrades = noUpgrades();
    for (const kind of UPGRADE_KINDS) {
      const v = parsed.upgrades?.[kind];
      if (typeof v === 'number' && v >= 0) {
        upgrades[kind] = Math.min(UPGRADES[kind].maxLevel, Math.floor(v));
      }
    }
    const progress: Record<string, number> = {};
    const records = parsed.progressVersion === PROGRESS_VERSION ? parsed.progress : undefined;
    for (const [id, value] of Object.entries(records ?? {})) {
      if (typeof value === 'number' && value > 0) progress[id] = Math.min(1, value);
    }
    // saves from before the coin inflation (or a different scale) are converted, not lost
    const savedScale =
      typeof parsed.coinScale === 'number' && parsed.coinScale > 0 ? parsed.coinScale : 1;
    const coins =
      typeof parsed.coins === 'number' && parsed.coins > 0
        ? Math.floor((parsed.coins * COIN_SCALE) / savedScale)
        : 0;
    return { completed, muted: parsed.muted === true, coins, upgrades, progress };
  } catch {
    return fresh;
  }
}

export function writeSave(data: SaveData): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...data, coinScale: COIN_SCALE, progressVersion: PROGRESS_VERSION }),
    );
  } catch {
    // ignore: progress just will not persist
  }
}

/** Throws away all progress (levels, records, coins, upgrades) in place; the sound setting stays. */
export function resetSave(save: SaveData): void {
  save.completed = {};
  save.progress = {};
  save.coins = 0;
  // the upgrades object is shared with the running game, so it is cleared instead of replaced
  for (const kind of UPGRADE_KINDS) save.upgrades[kind] = 0;
  writeSave(save);
}
