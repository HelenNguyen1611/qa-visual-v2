import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeomNode, GeomSnapshot } from '../types.js';
import { detectAspectRatio } from './aspectRatio.js';

function mediaNode(
  id: string,
  parentId: string,
  box: { x: number; y: number; w: number; h: number },
  extra: Partial<GeomNode> = {},
): GeomNode {
  return {
    id,
    parentId,
    siblingIndex: extra.siblingIndex ?? 0,
    kind: 'media',
    tag: 'img',
    locator: `#${id}`,
    classes: [],
    signature: extra.signature ?? 'img|',
    box,
    media: { type: 'img', aspect: box.w / box.h, naturalAspect: 1.5 },
    ...extra,
  };
}

function card(id: string, siblingIndex: number): GeomNode {
  return {
    id,
    parentId: 'row',
    siblingIndex,
    kind: 'item',
    tag: 'article',
    locator: `#${id}`,
    classes: ['card'],
    signature: 'article|card',
    box: { x: siblingIndex * 220, y: 0, w: 200, h: 220 },
  };
}

function snap(nodes: GeomNode[]): GeomSnapshot {
  return { viewportWidth: 1440, viewportHeight: 900, pageHeight: 900, nodes };
}

describe('detectAspectRatio', () => {
  it('emits no candidate when sibling media share a ratio', () => {
    const nodes = [
      mediaNode('a', 'gal', { x: 0, y: 0, w: 150, h: 100 }, { siblingIndex: 0 }),
      mediaNode('b', 'gal', { x: 160, y: 0, w: 150, h: 100 }, { siblingIndex: 1 }),
      mediaNode('c', 'gal', { x: 320, y: 0, w: 152, h: 100 }, { siblingIndex: 2 }),
    ];
    assert.deepEqual(detectAspectRatio(snap(nodes)), []);
  });

  it('flags the sibling whose displayed ratio sits outside the group', () => {
    const nodes = [
      mediaNode('a', 'gal', { x: 0, y: 0, w: 160, h: 90 }, { siblingIndex: 0 }),
      mediaNode('b', 'gal', { x: 170, y: 0, w: 160, h: 90 }, { siblingIndex: 1 }),
      mediaNode('c', 'gal', { x: 340, y: 0, w: 90, h: 160 }, { siblingIndex: 2 }),
    ];
    const hits = detectAspectRatio(snap(nodes));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].status, 'candidate');
    assert.equal(hits[0].kind, 'aspect-ratio');
    assert.equal(hits[0].nodeId, 'c');
    assert.equal(hits[0].locator, '#c');
    assert.equal(hits[0].evidence.howGrouped, 'sibling-media');
    assert.equal(hits[0].evidence.peers.length, 3);
    assert.ok(hits[0].evidence.delta > 0.08);
    assert.ok(hits[0].box.w === 90 && hits[0].box.h === 160);
  });

  it('does not flag a pair — two items cannot name an outlier', () => {
    const nodes = [
      mediaNode('a', 'gal', { x: 0, y: 0, w: 160, h: 90 }),
      mediaNode('b', 'gal', { x: 170, y: 0, w: 90, h: 160 }, { siblingIndex: 1 }),
    ];
    assert.deepEqual(detectAspectRatio(snap(nodes)), []);
  });

  it('compares the same slot across repeated cards', () => {
    const p1 = card('p1', 0);
    const p2 = card('p2', 1);
    const p3 = card('p3', 2);
    const nodes = [
      p1,
      p2,
      p3,
      mediaNode('i1', 'p1', { x: 0, y: 0, w: 200, h: 120 }),
      mediaNode('i2', 'p2', { x: 220, y: 0, w: 200, h: 120 }),
      mediaNode('i3', 'p3', { x: 440, y: 0, w: 200, h: 280 }),
    ];
    const hits = detectAspectRatio(snap(nodes));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].nodeId, 'i3');
    assert.equal(hits[0].evidence.howGrouped, 'slot');
    assert.deepEqual(
      hits[0].evidence.peers.map((p) => p.id).sort(),
      ['i1', 'i2', 'i3'],
    );
  });

  it('groups a modifier card with its siblings and flags its media slot', () => {
    const p1 = card('p1', 0);
    const p2 = card('p2', 1);
    const p3 = card('p3', 2);
    const wide: GeomNode = {
      ...card('p4', 3),
      classes: ['card', 'card--wide'],
      signature: 'article|card.card--wide',
      box: { x: 660, y: 0, w: 240, h: 220 },
    };
    const nodes = [
      p1,
      p2,
      p3,
      wide,
      mediaNode('i1', 'p1', { x: 0, y: 0, w: 200, h: 120 }),
      mediaNode('i2', 'p2', { x: 220, y: 0, w: 200, h: 120 }),
      mediaNode('i3', 'p3', { x: 440, y: 0, w: 200, h: 120 }),
      mediaNode('i4', 'p4', { x: 660, y: 0, w: 240, h: 240 }, { signature: 'img|hero' }),
    ];
    const hits = detectAspectRatio(snap(nodes));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].nodeId, 'i4');
    assert.equal(hits[0].evidence.howGrouped, 'card-media-slot');
    assert.equal(hits[0].evidence.peers.length, 4);
  });

  it('does not let a hidden clone slide join the media slot', () => {
    const p1 = card('p1', 0);
    const p2 = card('p2', 1);
    const p3 = card('p3', 2);
    const clone: GeomNode = { ...card('p4', 3), ariaHidden: true };
    const nodes = [
      p1,
      p2,
      p3,
      clone,
      mediaNode('i1', 'p1', { x: 0, y: 0, w: 200, h: 120 }),
      mediaNode('i2', 'p2', { x: 220, y: 0, w: 200, h: 120 }),
      mediaNode('i3', 'p3', { x: 440, y: 0, w: 200, h: 120 }),
      mediaNode('i4', 'p4', { x: 660, y: 0, w: 90, h: 160 }, { ariaHidden: true }),
    ];
    assert.deepEqual(detectAspectRatio(snap(nodes)), []);
  });

  it('does not compare cards that only share a parent, not a role', () => {
    const a = card('p1', 0);
    const b = card('p2', 1);
    const other: GeomNode = { ...card('p3', 2), classes: ['tile'], signature: 'article|tile' };
    const nodes = [
      a,
      b,
      other,
      mediaNode('i1', 'p1', { x: 0, y: 0, w: 200, h: 120 }),
      mediaNode('i2', 'p2', { x: 220, y: 0, w: 200, h: 120 }),
      mediaNode('i3', 'p3', { x: 440, y: 0, w: 90, h: 160 }),
    ];
    assert.deepEqual(detectAspectRatio(snap(nodes)), []);
  });

  it('skips tiny and aria-hidden media', () => {
    const nodes = [
      mediaNode('a', 'gal', { x: 0, y: 0, w: 160, h: 90 }, { siblingIndex: 0 }),
      mediaNode('b', 'gal', { x: 170, y: 0, w: 160, h: 90 }, { siblingIndex: 1 }),
      mediaNode('c', 'gal', { x: 340, y: 0, w: 90, h: 160 }, { siblingIndex: 2, ariaHidden: true }),
      mediaNode('d', 'gal', { x: 500, y: 0, w: 10, h: 40 }, { siblingIndex: 3 }),
    ];
    assert.deepEqual(detectAspectRatio(snap(nodes)), []);
  });
});
