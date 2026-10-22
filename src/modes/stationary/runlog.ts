import type { UpgradeKind, UpgradeLevels } from '../../core/shop';
import type { RunTrace } from './sim';

/**
 * A log of the shooter runs played in this browser, so a playtest can be laid next to the bot's
 * runs (see `npm run simulate:campaign`): what was owned, how the run went, what was bought after
 * it. It stays on the device; `?debug` shows a button on the menu that saves it as a file.
 */
export interface RunEntry {
  /** When the run ended (ISO time). */
  at: string;
  level: string;
  /** 1 for the first run of the level since the log began (or since the last reset). */
  attempt: number;
  upgrades: UpgradeLevels;
  /** Coins in the wallet when the run began. */
  wallet: number;
  /** `left`: quit from the pause screen. */
  result: 'won' | 'lost' | 'left';
  /** How far it got (0..1, the HUD bar). */
  reached: number;
  /** Real seconds played. */
  seconds: number;
  /** Coins it paid (first-clear bonus aside). */
  earned: number;
  /** The squad at the end and at its biggest. */
  squad: { end: number; peak: number };
  /** Health left (0..1) of the elite that ended a lost run, null otherwise. */
  wallLeft: number | null;
  trace: RunTrace;
  /** Upgrades bought before the next run. */
  bought: UpgradeKind[];
}

/** Progress was reset here: the runs after it are a new playthrough. */
export interface ResetMark {
  at: string;
  reset: true;
}

export type LogItem = RunEntry | ResetMark;

const KEY = 'that-one-ad-game:runs';
/** Oldest entries go first beyond this, so the log never crowds out the save. */
const MAX_ITEMS = 400;

const isRun = (item: LogItem): item is RunEntry => !('reset' in item);

/** localStorage can throw (private mode, blocked cookies), so every access is guarded. */
export function loadRunLog(): LogItem[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as LogItem[]) : [];
  } catch {
    return [];
  }
}

function writeRunLog(log: LogItem[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(log.slice(-MAX_ITEMS)));
  } catch {
    // ignore: the log is a testing aid
  }
}

/** Adds a run; `attempt` and `bought` are filled in here. */
export function logRun(entry: Omit<RunEntry, 'attempt' | 'bought'>): void {
  const log = loadRunLog();
  let attempt = 1;
  for (let i = log.length - 1; i >= 0; i--) {
    const item = log[i];
    if (!isRun(item)) break;
    if (item.level === entry.level) attempt++;
  }
  log.push({ ...entry, attempt, bought: [] });
  writeRunLog(log);
}

/** A purchase belongs to the run before it (it was paid for with that run's coins). */
export function logPurchase(kind: UpgradeKind): void {
  const log = loadRunLog();
  const last = log[log.length - 1];
  if (!last || !isRun(last)) return;
  last.bought.push(kind);
  writeRunLog(log);
}

export function logReset(): void {
  const log = loadRunLog();
  log.push({ at: new Date().toISOString(), reset: true });
  writeRunLog(log);
}

export function runCount(): number {
  return loadRunLog().filter(isRun).length;
}

/** Saves the log as a JSON file through the browser's download. */
export function downloadRunLog(): void {
  const blob = new Blob([JSON.stringify(loadRunLog(), null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `runlog-${new Date().toISOString().slice(0, 16).replace(':', '-')}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
