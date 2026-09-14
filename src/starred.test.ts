import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRunStamp, readStarred, setStarred, starredJsonPath } from './starred.js';

describe('starred.json', () => {
  it('starts empty and round-trips a mark', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qa-star-'));
    assert.equal(readStarred(cwd).size, 0);
    assert.equal(setStarred('2026-09-14T01-00-00', true, cwd), true);
    assert.deepEqual([...readStarred(cwd)], ['2026-09-14T01-00-00']);
    const body = JSON.parse(readFileSync(starredJsonPath(cwd), 'utf8'));
    assert.deepEqual(body.stamps, ['2026-09-14T01-00-00']);
    setStarred('2026-09-14T01-00-00', false, cwd);
    assert.equal(readStarred(cwd).size, 0);
  });

  it('rejects a path-like stamp', () => {
    assert.equal(isRunStamp('../secret'), false);
    assert.equal(isRunStamp('2026-09-10T01-54-50'), true);
  });
});
