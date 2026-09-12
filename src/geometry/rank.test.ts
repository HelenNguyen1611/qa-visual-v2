import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from './candidate.js';
import { rankCandidates, strongCandidates } from './rank.js';

function cand(delta: number, extra: Partial<Candidate> = {}): Candidate {
  return {
    kind: 'section-spacing',
    status: 'candidate',
    id: extra.id ?? `c:${delta}`,
    nodeId: extra.nodeId ?? 'n',
    locator: extra.locator ?? '#n',
    box: { x: 0, y: 0, w: 100, h: 40 },
    summary: 'x',
    evidence: {
      groupKey: 'g',
      howGrouped: 't',
      signature: 's',
      value: 100 + delta,
      groupMedian: 40,
      delta,
      peers: [
        { id: 'a', locator: '#a', box: { x: 0, y: 0, w: 1, h: 1 }, value: 40 },
        { id: 'b', locator: '#b', box: { x: 0, y: 0, w: 1, h: 1 }, value: 40 },
        { id: 'c', locator: '#c', box: { x: 0, y: 0, w: 1, h: 1 }, value: 40 },
      ],
      viewportWidth: 1440,
      viewportHeight: 900,
    },
    ...extra,
  };
}

describe('rankCandidates', () => {
  it('keeps a large spacing spike and drops a 3px wobble', () => {
    const ranked = rankCandidates([cand(3, { id: 'weak' }), cand(80, { id: 'strong' })]);
    const strong = strongCandidates(ranked);
    assert.equal(strong.some((c) => c.id === 'strong'), true);
    assert.equal(strong.some((c) => c.id === 'weak'), false);
    assert.ok((ranked.find((c) => c.id === 'weak')?.rank ?? 1) < 0.35);
  });

  it('does not discard the raw weak candidate', () => {
    const ranked = rankCandidates([cand(3)]);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].keep, false);
  });
});
