import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Run stamps a person marked as important in Previous runs.
 *
 * The reports folder is timestamp-only; a star is the way to keep a baseline or a
 * client-facing run from disappearing into the list. Default is unmarked.
 */
export function starredJsonPath(cwd = process.cwd()) {
  return resolve(cwd, 'starred.json');
}

export function readStarred(cwd = process.cwd()): Set<string> {
  const p = starredJsonPath(cwd);
  if (!existsSync(p)) return new Set();
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    const arr = Array.isArray(d) ? d : d.stamps;
    return new Set(
      Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === 'string' && isRunStamp(x)) : [],
    );
  } catch {
    return new Set();
  }
}

export function writeStarred(stamps: Iterable<string>, cwd = process.cwd()) {
  const list = [...new Set([...stamps].filter(isRunStamp))].sort().reverse();
  writeFileSync(
    starredJsonPath(cwd),
    JSON.stringify(
      {
        _: 'Run stamps marked with a star in Previous runs. Empty means nothing is marked.',
        stamps: list,
      },
      null,
      2,
    ),
  );
}

export function setStarred(stamp: string, on: boolean, cwd = process.cwd()): boolean {
  if (!isRunStamp(stamp)) return false;
  const next = readStarred(cwd);
  if (on) next.add(stamp);
  else next.delete(stamp);
  writeStarred(next, cwd);
  return on;
}

export function isRunStamp(stamp: string): boolean {
  return /^\d{4}-[\w:.-]{4,36}$/.test(stamp);
}
