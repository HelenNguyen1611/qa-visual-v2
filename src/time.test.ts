import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TZ, formatQaWhen, nowQa, resolveTz } from './time.js';

describe('resolveTz', () => {
  it('defaults Hanoi aliases to Asia/Ho_Chi_Minh', () => {
    assert.equal(resolveTz(''), DEFAULT_TZ);
    assert.equal(resolveTz('Hanoi'), DEFAULT_TZ);
    assert.equal(resolveTz('Asia/Hanoi'), DEFAULT_TZ);
    assert.equal(resolveTz('Asia/Ho_Chi_Minh'), 'Asia/Ho_Chi_Minh');
  });

  it('falls back when the zone does not exist', () => {
    assert.equal(resolveTz('Not/AZone'), DEFAULT_TZ);
  });
});

describe('nowQa / formatQaWhen', () => {
  it('writes stamp and when in Hà Nội, not UTC', () => {
    const d = new Date('2026-09-12T11:00:00.000Z');
    const clock = nowQa(d, DEFAULT_TZ);
    assert.equal(clock.stamp, '2026-09-12T18-00-00');
    assert.equal(clock.when, '2026-09-12T18:00:00+07:00');
  });

  it('shows old UTC report times as Hà Nội', () => {
    assert.equal(formatQaWhen('2026-09-12T11:34:00.838Z', DEFAULT_TZ), '2026-09-12 18:34');
    assert.equal(formatQaWhen('2026-09-12T19:00:26+07:00', DEFAULT_TZ), '2026-09-12 19:00');
  });
});
