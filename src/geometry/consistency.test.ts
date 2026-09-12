import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeomNode } from './types.js';
import {
  alignChildSlots,
  childrenOf,
  equivalentKey,
  findOutliers,
  gapY,
  groupByRole,
  groupEquivalent,
  mad,
  median,
  nearlyEqual,
  primaryMediaOf,
  roleSignature,
} from './consistency.js';

function node(partial: Partial<GeomNode> & Pick<GeomNode, 'id' | 'signature'>): GeomNode {
  return {
    siblingIndex: 0,
    kind: 'item',
    tag: 'div',
    locator: `#${partial.id}`,
    classes: [],
    box: { x: 0, y: 0, w: 100, h: 80 },
    ...partial,
  };
}

describe('nearlyEqual', () => {
  it('treats a 1px drift as render noise', () => {
    assert.equal(nearlyEqual(100, 101), true);
  });

  it('treats a 2% drift as render noise', () => {
    assert.equal(nearlyEqual(200, 203), true);
  });

  it('flags a clear miss', () => {
    assert.equal(nearlyEqual(100, 140), false);
  });
});

describe('median / mad', () => {
  it('median of an odd list is the middle', () => {
    assert.equal(median([3, 1, 2]), 2);
  });

  it('median of an even list averages the two middles', () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  it('mad is 0 when every value matches', () => {
    assert.equal(mad([10, 10, 10]), 0);
  });
});

describe('findOutliers', () => {
  it('needs at least 3 values', () => {
    assert.deepEqual(findOutliers([10, 80]), []);
  });

  it('ignores a 2px wobble in a tight cluster', () => {
    assert.deepEqual(findOutliers([100, 100, 102, 101]), []);
  });

  it('flags the value that sits far from the cluster', () => {
    const hits = findOutliers([100, 100, 101, 180]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].index, 3);
    assert.equal(hits[0].value, 180);
    assert.equal(hits[0].center, 100.5);
  });

  it('accepts a tighter abs for aspect-style ratios', () => {
    const hits = findOutliers([1.5, 1.5, 1.52, 2.4], { abs: 0.08, rel: 0.05, minGroup: 3 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].value, 2.4);
  });

  it('does not flag a group that is all different but evenly spread', () => {
    // 10, 20, 30, 40 — median 25, large MAD, none is a lone spike
    assert.equal(findOutliers([10, 20, 30, 40]).length, 0);
  });
});

describe('groupEquivalent', () => {
  const a = node({ id: 'a', parentId: 'p', signature: 'article|card', siblingIndex: 0, box: { x: 0, y: 0, w: 200, h: 100 } });
  const b = node({ id: 'b', parentId: 'p', signature: 'article|card', siblingIndex: 1, box: { x: 220, y: 0, w: 200, h: 100 } });
  const c = node({ id: 'c', parentId: 'p', signature: 'article|other', siblingIndex: 2, box: { x: 440, y: 0, w: 200, h: 100 } });
  const hidden = node({
    id: 'h',
    parentId: 'p',
    signature: 'article|card',
    siblingIndex: 3,
    ariaHidden: true,
    box: { x: 0, y: 0, w: 200, h: 100 },
  });

  it('groups by parent + signature', () => {
    const groups = groupEquivalent([a, b, c]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].key, equivalentKey(a));
    assert.deepEqual(
      groups[0].nodes.map((n) => n.id),
      ['a', 'b'],
    );
  });

  it('drops aria-hidden copies so stacked slides are not a set', () => {
    const groups = groupEquivalent([a, b, hidden]);
    assert.equal(groups[0].nodes.length, 2);
  });

  it('keeps hidden nodes when asked', () => {
    const groups = groupEquivalent([a, hidden], { skipHidden: false });
    assert.equal(groups[0].nodes.length, 2);
  });
});

describe('groupByRole', () => {
  it('treats a BEM modifier as the same repeated card', () => {
    const a = node({
      id: 'a',
      parentId: 'row',
      tag: 'article',
      classes: ['card'],
      signature: 'article|card',
      siblingIndex: 0,
    });
    const b = node({
      id: 'b',
      parentId: 'row',
      tag: 'article',
      classes: ['card'],
      signature: 'article|card',
      siblingIndex: 1,
    });
    const wide = node({
      id: 'w',
      parentId: 'row',
      tag: 'article',
      classes: ['card', 'card--wide'],
      signature: 'article|card.card--wide',
      siblingIndex: 2,
    });
    const other = node({
      id: 't',
      parentId: 'row',
      tag: 'article',
      classes: ['tile'],
      signature: 'article|tile',
      siblingIndex: 3,
    });
    assert.equal(roleSignature(wide), 'article|card');
    const groups = groupByRole([a, b, wide, other]);
    assert.equal(groups.length, 1);
    assert.deepEqual(
      groups[0].nodes.map((n) => n.id),
      ['a', 'b', 'w'],
    );
  });

  it('finds nested media under a card', () => {
    const card = node({ id: 'p', signature: 'article|card' });
    const wrap = node({ id: 'w', parentId: 'p', signature: 'div|media' });
    const img = node({
      id: 'i',
      parentId: 'w',
      kind: 'media',
      signature: 'img|hero',
      media: { type: 'img', aspect: 1.5 },
    });
    const hit = primaryMediaOf(card, [card, wrap, img], (n) => Boolean(n.media));
    assert.equal(hit?.id, 'i');
  });
});

describe('alignChildSlots', () => {
  const p1 = node({ id: 'p1', parentId: 'root', signature: 'article|card', siblingIndex: 0 });
  const p2 = node({ id: 'p2', parentId: 'root', signature: 'article|card', siblingIndex: 1 });
  const p3 = node({ id: 'p3', parentId: 'root', signature: 'article|card', siblingIndex: 2 });
  const img1 = node({ id: 'i1', parentId: 'p1', signature: 'img|', kind: 'media', siblingIndex: 0, box: { x: 0, y: 0, w: 200, h: 100 } });
  const h21 = node({ id: 't1', parentId: 'p1', signature: 'h2|', kind: 'heading', siblingIndex: 1, box: { x: 0, y: 110, w: 200, h: 24 } });
  const img2 = node({ id: 'i2', parentId: 'p2', signature: 'img|', kind: 'media', siblingIndex: 0, box: { x: 220, y: 0, w: 200, h: 100 } });
  const h22 = node({ id: 't2', parentId: 'p2', signature: 'h2|', kind: 'heading', siblingIndex: 1, box: { x: 220, y: 110, w: 200, h: 24 } });
  const img3 = node({ id: 'i3', parentId: 'p3', signature: 'img|', kind: 'media', siblingIndex: 0, box: { x: 440, y: 0, w: 200, h: 160 } });
  const nodes = [p1, p2, p3, img1, h21, img2, h22, img3];

  it('lists direct children in sibling order', () => {
    assert.deepEqual(
      childrenOf('p1', nodes).map((n) => n.id),
      ['i1', 't1'],
    );
  });

  it('zips matching children across parents, leaving a hole when one card has no title', () => {
    const slots = alignChildSlots([p1, p2, p3], nodes);
    const imgs = slots.find((s) => s.key === 'img|');
    const titles = slots.find((s) => s.key === 'h2|');
    assert.ok(imgs);
    assert.ok(titles);
    assert.deepEqual(
      imgs.nodes.map((n) => n?.id),
      ['i1', 'i2', 'i3'],
    );
    assert.deepEqual(
      titles.nodes.map((n) => n?.id),
      ['t1', 't2', undefined],
    );
  });

  it('disambiguates two children that share a signature', () => {
    const a1 = node({ id: 'a1', parentId: 'p1', signature: 'img|', siblingIndex: 0 });
    const a2 = node({ id: 'a2', parentId: 'p1', signature: 'img|', siblingIndex: 1 });
    const b1 = node({ id: 'b1', parentId: 'p2', signature: 'img|', siblingIndex: 0 });
    const b2 = node({ id: 'b2', parentId: 'p2', signature: 'img|', siblingIndex: 1 });
    const slots = alignChildSlots([p1, p2], [p1, p2, a1, a2, b1, b2]);
    assert.equal(slots.length, 2);
    assert.equal(slots[0].key, 'img|#0');
    assert.equal(slots[1].key, 'img|#1');
    assert.deepEqual(
      slots[0].nodes.map((n) => n?.id),
      ['a1', 'b1'],
    );
  });
});

describe('gapY', () => {
  it('is the space between the bottom of a and the top of b', () => {
    const a = node({ id: 'a', signature: 's', box: { x: 0, y: 0, w: 10, h: 40 } });
    const b = node({ id: 'b', signature: 's', box: { x: 0, y: 64, w: 10, h: 20 } });
    assert.equal(gapY(a, b), 24);
  });
});
