import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeomNode, GeomSnapshot } from '../types.js';
import { detectContainerAlignment } from './containerAlignment.js';

function sec(id: string, x: number, w = 1100): GeomNode {
  return {
    id,
    kind: 'section',
    tag: 'section',
    locator: `#${id}`,
    classes: [],
    signature: 'section|',
    siblingIndex: 0,
    box: { x, y: 200, w, h: 200 },
  };
}

const snap = (nodes: GeomNode[]): GeomSnapshot => ({ viewportWidth: 1440, viewportHeight: 900, pageHeight: 2000, nodes });

describe('detectContainerAlignment', () => {
  it('flags a same-width section whose left edge sits off the column', () => {
    const hits = detectContainerAlignment(snap([sec('a', 120), sec('b', 120), sec('c', 120), sec('d', 320)]));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].nodeId, 'd');
    assert.equal(hits[0].kind, 'container-alignment');
    assert.ok(hits[0].evidence.peers.length >= 3);
  });

  it('does not compare a full-bleed band with inset sections', () => {
    const hits = detectContainerAlignment(
      snap([sec('a', 120, 1100), sec('b', 120, 1100), sec('c', 120, 1100), sec('full', 0, 1440)]),
    );
    assert.equal(hits.some((h) => h.nodeId === 'full'), false);
  });
});
