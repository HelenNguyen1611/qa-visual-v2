import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeomNode, GeomSnapshot } from '../types.js';
import { detectSectionSpacing } from './sectionSpacing.js';

function sec(id: string, y: number, h = 200): GeomNode {
  return {
    id,
    kind: 'section',
    tag: 'section',
    locator: `#${id}`,
    classes: [],
    signature: 'section|',
    siblingIndex: 0,
    box: { x: 80, y, w: 1200, h },
  };
}

const snap = (nodes: GeomNode[]): GeomSnapshot => ({ viewportWidth: 1440, viewportHeight: 900, pageHeight: 4000, nodes });

describe('detectSectionSpacing', () => {
  it('flags a lone huge gap among otherwise even section gaps', () => {
    // gaps: 40, 40, 40, 400
    const nodes = [sec('a', 0), sec('b', 240), sec('c', 480), sec('d', 720), sec('e', 1320)];
    const hits = detectSectionSpacing(snap(nodes));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].nodeId, 'e');
    assert.equal(hits[0].kind, 'section-spacing');
  });

  it('does not flag evenly different gaps', () => {
    const nodes = [sec('a', 0), sec('b', 260), sec('c', 560), sec('d', 900)];
    assert.equal(detectSectionSpacing(snap(nodes)).length, 0);
  });

  it('needs at least 4 top-level sections', () => {
    assert.equal(detectSectionSpacing(snap([sec('a', 0), sec('b', 300), sec('c', 900)])).length, 0);
  });
});
