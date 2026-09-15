import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrecision, precisionFromReport } from './harness.js';

describe('precisionFromReport', () => {
  it('splits page / design / AI and counts what a reviewer already rejected', () => {
    const rows = precisionFromReport([
      { measured: true, locatedHow: 'measured on DOM: two text boxes intersect' },
      { measured: true, locatedHow: 'measured on DOM: gap 27px vs Figma 53px', accepted: true },
      { measured: true, locatedHow: 'measured on DOM: unique Figma text has no matching run', accepted: true },
      { measured: true, locatedHow: 'measured on DOM: font-size 42px vs Figma 45.0px' },
      { measured: false },
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.basis, r]));
    assert.equal(by.page.total, 1);
    assert.equal(by.page.signedOff, 0);
    assert.equal(by.design.total, 3);
    assert.equal(by.design.signedOff, 2);
    assert.equal(by.design.falsePositiveRate, 2 / 3);
    assert.equal(by.ai.total, 1);
    assert.match(formatPrecision(rows), /design/);
  });

  it('does not invent a rate on an empty tier', () => {
    const rows = precisionFromReport([]);
    assert.equal(rows.every((r) => r.falsePositiveRate === 0 && r.total === 0), true);
  });
});
