import { validateLevel } from './validate';
import type { Level } from './schema';

// Every *.json in this folder is a level; files are ordered by file name (01-..., 02-...).
const files = import.meta.glob('./*.json', { eager: true, import: 'default' }) as Record<
  string,
  unknown
>;

function loadAll(): Level[] {
  const levels: Level[] = [];
  const seen = new Set<string>();
  for (const path of Object.keys(files).sort()) {
    const result = validateLevel(files[path]);
    if (!result.ok) {
      throw new Error(`Invalid level file ${path}:\n  ${result.errors.join('\n  ')}`);
    }
    if (seen.has(result.level.id))
      throw new Error(`Duplicate level id "${result.level.id}" (${path})`);
    seen.add(result.level.id);
    levels.push(result.level);
  }
  return levels;
}

export const levels: Level[] = loadAll();
export type { Level } from './schema';
