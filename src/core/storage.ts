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
}

function isResult(v: unknown): v is LevelResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.stars === 'number' && typeof r.best === 'number';
}

/** localStorage can throw (private mode, blocked cookies), so every access is guarded. */
export function loadSave(): SaveData {
  const fresh: SaveData = { completed: {}, muted: false };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw) as { completed?: Record<string, unknown>; muted?: unknown };
    const completed: Record<string, LevelResult> = {};
    for (const [id, value] of Object.entries(parsed.completed ?? {})) {
      if (isResult(value)) completed[id] = value;
    }
    return { completed, muted: parsed.muted === true };
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
