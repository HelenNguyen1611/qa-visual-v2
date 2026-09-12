import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeomNode, GeomSnapshot } from '../types.js';
import { detectComponentGap } from './componentGap.js';

function card(id: string, sib: number): GeomNode {
  return {
    id,
    parentId: 'row',
    siblingIndex: sib,
    kind: 'item',
    tag: 'article',
    locator: `#${id}`,
    classes: ['card'],
    signature: 'article|card',
    box: { x: sib * 220, y: 0, w: 200, h: 300 },
  };
}

function kid(id: string, parentId: string, sib: number, y: number, sig: string, h = 80): GeomNode {
  return {
    id,
    parentId,
    siblingIndex: sib,
    kind: sig.startsWith('img') ? 'media' : 'heading',
    tag: sig.startsWith('img') ? 'img' : 'h2',
    locator: `#${id}`,
    classes: [],
    signature: sig,
    box: { x: 0, y, w: 200, h },
    media: sig.startsWith('img') ? { type: 'img', aspect: 2.5 } : undefined,
  };
}

const snap = (nodes: GeomNode[]): GeomSnapshot => ({ viewportWidth: 1440, viewportHeight: 900, pageHeight: 900, nodes });

describe('detectComponentGap', () => {
  it('flags a card whose img→title gap is far from the others', () => {
    const nodes = [
      card('p1', 0),
      card('p2', 1),
      card('p3', 2),
      kid('i1', 'p1', 0, 0, 'img|'),
      kid('t1', 'p1', 1, 96, 'h2|', 24),
      kid('i2', 'p2', 0, 0, 'img|'),
      kid('t2', 'p2', 1, 96, 'h2|', 24),
      kid('i3', 'p3', 0, 0, 'img|'),
      kid('t3', 'p3', 1, 220, 'h2|', 24),
    ];
    const hits = detectComponentGap(snap(nodes));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].nodeId, 't3');
    assert.equal(hits[0].kind, 'component-gap');
  });
});
