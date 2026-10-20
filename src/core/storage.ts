const KEY = 'that-one-ad-game:v1';

export interface SaveData {
  /** Best number of survivors per completed level id. */
  completed: Record<string, number>;
  muted: boolean;
}

/** localStorage can throw (private mode, blocked cookies), so every access is guarded. */
export function loadSave(): SaveData {
  const fresh: SaveData = { completed: {}, muted: false };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    return {
      completed: typeof parsed.completed === 'object' && parsed.completed ? parsed.completed : {},
      muted: parsed.muted === true,
    };
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
