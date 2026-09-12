import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeomNode, GeomSnapshot } from '../types.js';
import { detectSiblingAlignment } from './siblingAlignment.js';

function item(id: string, x: number, y: number, sib: number): GeomNode {
  return {
    id,
    parentId: 'row',
    siblingIndex: sib,
    kind: 'item',
    tag: 'article',
    locator: `#${id}`,
    classes: ['card'],
    signature: 'article|card',
    box: { x, y, w: 200, h: 180 },
  };
}

const snap = (nodes: GeomNode[]): GeomSnapshot => ({ viewportWidth: 1440, viewportHeight: 900, pageHeight: 900, nodes });

describe('detectSiblingAlignment', () => {
  it('flags a card dropped below the row', () => {
    const hits = detectSiblingAlignment(snap([item('a', 0, 40, 0), item('b', 220, 40, 1), item('c', 440, 40, 2), item('d', 660, 200, 3)]));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].nodeId, 'd');
    assert.equal(hits[0].kind, 'sibling-alignment');
  });

  it('does not compare different signatures', () => {
    const other: GeomNode = { ...item('x', 660, 200, 3), signature: 'article|cta', classes: ['cta'] };
    const hits = detectSiblingAlignment(snap([item('a', 0, 40, 0), item('b', 220, 40, 1), item('c', 440, 40, 2), other]));
    assert.equal(hits.length, 0);
  });
});
