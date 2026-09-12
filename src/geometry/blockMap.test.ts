import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeomNode, GeomSnapshot } from './types.js';
import type { FigmaGeomNode, FigmaGeomTree } from './figmaTree.js';
import { matchFigmaToDom } from './match.js';
import { insetOf, mapBlocks, sideFloor } from './blockMap.js';
import { detectFigmaDom } from './detectors/figmaDom.js';

function dom(id: string, text: string, box: GeomNode['box'], extra: Partial<GeomNode> = {}): GeomNode {
  return {
    id,
    siblingIndex: 0,
    kind: extra.kind ?? 'heading',
    tag: extra.tag ?? 'h2',
    locator: `#${id}`,
    classes: [],
    signature: extra.signature ?? 'h2',
    box,
    text,
    ...extra,
  };
}

function figma(id: string, extra: Partial<FigmaGeomNode> & { text?: string }): FigmaGeomNode {
  return {
    id,
    name: extra.name ?? extra.text ?? id,
    type: extra.type ?? 'TEXT',
    box: extra.box ?? { x: 0, y: 0, w: 100, h: 20 },
    text: extra.text,
    fontSize: extra.fontSize,
    padding: extra.padding,
    parentId: extra.parentId,
    hasImageFill: extra.hasImageFill,
  };
}

const title = 'Unique heading for the copy block';
const body = 'Unique description about the energy platform';

function tree(nodes: FigmaGeomNode[]): FigmaGeomTree {
  return { frameId: 'page', frameName: 'Home', frame: { x: 0, y: 0, w: 1280, h: 2400 }, nodes };
}

const snap = (nodes: GeomNode[], vw = 1440): GeomSnapshot => ({
  viewportWidth: vw,
  viewportHeight: 900,
  pageHeight: 4000,
  nodes,
});

describe('insetOf', () => {
  it('measures the space from a parent to the union of children', () => {
    const pad = insetOf({ x: 0, y: 0, w: 200, h: 100 }, [{ x: 20, y: 10, w: 160, h: 70 }]);
    assert.deepEqual(pad, { top: 10, right: 20, bottom: 20, left: 20 });
  });
});

describe('sideFloor', () => {
  it('is render slack, not an 80px size rule', () => {
    assert.ok(sideFloor(24, 500) < 10);
    assert.ok(sideFloor(24, 500) >= 2);
  });
});

describe('mapBlocks', () => {
  it('maps a copy frame to the matching DOM wrapper via two unique texts', () => {
    const figmaNodes = [
      figma('col', {
        type: 'FRAME',
        name: 'Copy',
        box: { x: 100, y: 200, w: 400, h: 220 },
        padding: { top: 20, right: 20, bottom: 20, left: 20 },
      }),
      figma('h', { text: title, box: { x: 120, y: 220, w: 360, h: 40 }, parentId: 'col' }),
      figma('p', { text: body, box: { x: 120, y: 280, w: 360, h: 80 }, parentId: 'col' }),
    ];
    const nodes = [
      dom('wrap', '', { x: 120, y: 240, w: 450, h: 280 }, { kind: 'container', tag: 'div', signature: 'div|copy', text: undefined }),
      dom('h', title, { x: 160, y: 280, w: 370, h: 44 }),
      dom('p', body, { x: 160, y: 340, w: 370, h: 90 }, { kind: 'item', tag: 'p', signature: 'p|' }),
    ];
    const s = snap(nodes);
    const t = tree(figmaNodes);
    const pairs = matchFigmaToDom(s, t).pairs;
    assert.equal(pairs.length, 2);
    const mapped = mapBlocks(s, t, pairs);
    assert.equal(mapped.blocks.length, 1);
    assert.equal(mapped.blocks[0].dom.id, 'wrap');
    assert.equal(mapped.blocks[0].figma.id, 'col');
    assert.ok(mapped.blocks[0].confidence >= 0.72);
  });

  it('does not use a full-width section as the block when texts sit in one column', () => {
    const figmaNodes = [
      figma('col', { type: 'FRAME', box: { x: 700, y: 200, w: 400, h: 220 }, padding: { top: 16, right: 16, bottom: 16, left: 16 } }),
      figma('h', { text: title, box: { x: 716, y: 216, w: 360, h: 40 }, parentId: 'col' }),
      figma('p', { text: body, box: { x: 716, y: 270, w: 360, h: 80 }, parentId: 'col' }),
    ];
    const nodes = [
      dom('sec', '', { x: 0, y: 200, w: 1440, h: 400 }, { kind: 'section', tag: 'section', signature: 'section|', text: undefined }),
      dom('h', title, { x: 800, y: 240, w: 400, h: 40 }),
      dom('p', body, { x: 800, y: 300, w: 400, h: 80 }, { kind: 'item', tag: 'p', signature: 'p|' }),
    ];
    const mapped = mapBlocks(snap(nodes), tree(figmaNodes), matchFigmaToDom(snap(nodes), tree(figmaNodes)).pairs);
    assert.equal(mapped.blocks.length, 0);
    assert.ok(mapped.skipped.some((s) => s.reason === 'dom-block-missing'));
  });

  it('does not climb a padded Figma parent when the DOM side is still the text wrap', () => {
    const figmaNodes = [
      figma('content', {
        type: 'FRAME',
        name: 'Content',
        box: { x: 80, y: 180, w: 560, h: 260 },
        padding: { top: 0, right: 20, bottom: 0, left: 100 },
      }),
      figma('wrap', { type: 'FRAME', name: 'Text Wrap', box: { x: 180, y: 180, w: 440, h: 260 }, parentId: 'content' }),
      figma('h', { text: title, box: { x: 188, y: 188, w: 420, h: 40 }, parentId: 'wrap' }),
      figma('p', { text: body, box: { x: 188, y: 248, w: 420, h: 80 }, parentId: 'wrap' }),
    ];
    const nodes = [
      dom('sec', '', { x: 0, y: 160, w: 1440, h: 400 }, { kind: 'section', tag: 'section', signature: 'section|', text: undefined }),
      dom('wrap', '', { x: 200, y: 200, w: 490, h: 280 }, { kind: 'container', tag: 'div', signature: 'div|copy', text: undefined }),
      dom('h', title, { x: 208, y: 208, w: 470, h: 44 }),
      dom('p', body, { x: 208, y: 268, w: 470, h: 90 }, { kind: 'item', tag: 'p', signature: 'p|' }),
    ];
    const mapped = mapBlocks(snap(nodes), tree(figmaNodes), matchFigmaToDom(snap(nodes), tree(figmaNodes)).pairs);
    assert.equal(mapped.blocks.length, 1);
    assert.equal(mapped.blocks[0].figma.id, 'wrap');
    assert.equal(mapped.blocks[0].dom.id, 'wrap');
    assert.equal(mapped.blocks[0].figmaLevel, 'text-wrapper');
    assert.ok(mapped.blocks[0].figmaPad.left < 20);
  });

  it('rejects a Figma section/content frame against a DOM text column', () => {
    const figmaNodes = [
      figma('content', { type: 'FRAME', name: 'Content', box: { x: 40, y: 200, w: 700, h: 280 } }),
      figma('img', { type: 'RECTANGLE', box: { x: 40, y: 200, w: 240, h: 280 }, hasImageFill: true }),
      figma('h', { text: title, box: { x: 320, y: 220, w: 400, h: 40 } }),
      figma('p', { text: body, box: { x: 320, y: 280, w: 400, h: 80 } }),
    ];
    const nodes = [
      dom('wrap', '', { x: 360, y: 240, w: 450, h: 220 }, { kind: 'container', tag: 'div', signature: 'div|copy', text: undefined }),
      dom('h', title, { x: 368, y: 248, w: 430, h: 40 }),
      dom('p', body, { x: 368, y: 308, w: 430, h: 80 }, { kind: 'item', tag: 'p', signature: 'p|' }),
    ];
    const mapped = mapBlocks(snap(nodes), tree(figmaNodes), matchFigmaToDom(snap(nodes), tree(figmaNodes)).pairs);
    assert.equal(mapped.blocks.length, 0);
    assert.ok(mapped.skipped.some((s) => s.reason.startsWith('level-mismatch')));
  });
});

describe('mapChildInsets', () => {
  it('measures box inset of a mapped text wrap inside a mapped content parent', () => {
    const figmaNodes = [
      figma('content', { type: 'FRAME', name: 'Content', box: { x: 80, y: 180, w: 700, h: 280 } }),
      figma('img', { type: 'RECTANGLE', box: { x: 80, y: 180, w: 240, h: 280 }, hasImageFill: true, parentId: 'content' }),
      figma('wrap', { type: 'FRAME', name: 'Text Wrap', box: { x: 340, y: 190, w: 420, h: 250 }, parentId: 'content' }),
      figma('h', { text: title, box: { x: 348, y: 198, w: 400, h: 40 }, parentId: 'wrap' }),
      figma('p', { text: body, box: { x: 348, y: 258, w: 400, h: 80 }, parentId: 'wrap' }),
    ];
    const nodes = [
      dom('row', '', { x: 100, y: 200, w: 780, h: 320 }, { kind: 'container', tag: 'div', signature: 'div|row', text: undefined }),
      dom('img', '', { x: 100, y: 200, w: 200, h: 300 }, { kind: 'media', tag: 'img', signature: 'img', media: { type: 'img', aspect: 200 / 300 } }),
      dom('wrap', '', { x: 520, y: 240, w: 340, h: 250 }, { kind: 'container', tag: 'div', signature: 'div|copy', text: undefined, parentId: 'row' }),
      dom('h', title, { x: 528, y: 248, w: 320, h: 44 }),
      dom('p', body, { x: 528, y: 308, w: 320, h: 90 }, { kind: 'item', tag: 'p', signature: 'p|' }),
    ];
    const mapped = mapBlocks(snap(nodes), tree(figmaNodes), matchFigmaToDom(snap(nodes), tree(figmaNodes)).pairs);
    assert.equal(mapped.blocks[0]?.figma.id, 'wrap');
    assert.equal(mapped.blocks[0]?.dom.id, 'wrap');
    assert.equal(mapped.insets.length, 1);
    assert.equal(mapped.insets[0].parentFigma.id, 'content');
    assert.equal(mapped.insets[0].parentDom.id, 'row');
    assert.equal(mapped.insets[0].parentFigmaLevel, 'section');
    assert.equal(mapped.insets[0].parentDomLevel, 'section');
    assert.ok(mapped.insets[0].domInset.left > mapped.insets[0].figmaInset.left);
  });

  it('does not compare a Figma content parent to a DOM text wrap', () => {
    const figmaNodes = [
      figma('content', { type: 'FRAME', name: 'Content', box: { x: 80, y: 180, w: 700, h: 280 } }),
      figma('img', { type: 'RECTANGLE', box: { x: 80, y: 180, w: 240, h: 280 }, hasImageFill: true, parentId: 'content' }),
      figma('wrap', { type: 'FRAME', name: 'Text Wrap', box: { x: 340, y: 190, w: 420, h: 250 }, parentId: 'content' }),
      figma('h', { text: title, box: { x: 348, y: 198, w: 400, h: 40 }, parentId: 'wrap' }),
      figma('p', { text: body, box: { x: 348, y: 258, w: 400, h: 80 }, parentId: 'wrap' }),
    ];
    const nodes = [
      dom('sec', '', { x: 0, y: 160, w: 1440, h: 400 }, { kind: 'section', tag: 'section', signature: 'section|', text: undefined }),
      dom('wrap', '', { x: 800, y: 200, w: 490, h: 260 }, { kind: 'container', tag: 'div', signature: 'div|copy', text: undefined }),
      dom('h', title, { x: 808, y: 208, w: 470, h: 44 }),
      dom('p', body, { x: 808, y: 268, w: 470, h: 90 }, { kind: 'item', tag: 'p', signature: 'p|' }),
    ];
    const mapped = mapBlocks(snap(nodes), tree(figmaNodes), matchFigmaToDom(snap(nodes), tree(figmaNodes)).pairs);
    assert.equal(mapped.blocks[0]?.figma.id, 'wrap');
    assert.equal(mapped.insets.length, 0);
    assert.ok(mapped.insetSkipped.length >= 1);
    assert.ok(
      mapped.insetSkipped.every((s) => s.reason.startsWith('parent-mismatch') || s.reason.startsWith('parent-missing')),
    );
  });

  it('emits an inset candidate from boxes when CSS padding on the child is 0', () => {
    const figmaNodes = [
      figma('content', { type: 'FRAME', name: 'Content', box: { x: 80, y: 180, w: 700, h: 280 } }),
      figma('img', { type: 'RECTANGLE', box: { x: 80, y: 180, w: 240, h: 280 }, hasImageFill: true, parentId: 'content' }),
      figma('wrap', { type: 'FRAME', name: 'Text Wrap', box: { x: 340, y: 190, w: 420, h: 250 }, parentId: 'content' }),
      figma('h', { text: title, box: { x: 348, y: 198, w: 400, h: 40 }, parentId: 'wrap' }),
      figma('p', { text: body, box: { x: 348, y: 258, w: 400, h: 80 }, parentId: 'wrap' }),
    ];
    const nodes = [
      dom('row', '', { x: 100, y: 200, w: 780, h: 320 }, { kind: 'container', tag: 'div', signature: 'div|row', text: undefined }),
      dom('img', '', { x: 100, y: 200, w: 200, h: 300 }, { kind: 'media', tag: 'img', signature: 'img', media: { type: 'img', aspect: 200 / 300 } }),
      dom(
        'wrap',
        '',
        { x: 540, y: 240, w: 340, h: 250 },
        { kind: 'container', tag: 'div', signature: 'div|copy', text: undefined, parentId: 'row', padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      ),
      dom('h', title, { x: 548, y: 248, w: 320, h: 44 }),
      dom('p', body, { x: 548, y: 308, w: 320, h: 90 }, { kind: 'item', tag: 'p', signature: 'p|' }),
    ];
    const hits = detectFigmaDom(snap(nodes), tree(figmaNodes));
    const inset = hits.find((h) => h.evidence.howGrouped === 'figma-inset');
    assert.ok(inset);
    assert.equal(inset!.evidence.parentFigmaId, 'content');
    assert.equal(inset!.evidence.childFigmaId, 'wrap');
    assert.equal(inset!.evidence.parentLocator, '#row');
    assert.equal(inset!.evidence.childLocator, '#wrap');
    assert.ok((inset!.evidence.sides?.left?.delta ?? 0) > 20);
  });
});

describe('mapLayoutOwners', () => {
  it('maps a padded media+copy frame instead of the text wrap for spacing', () => {
    const figmaNodes = [
      figma('sec', {
        type: 'INSTANCE',
        name: 'Media Section',
        box: { x: 0, y: 200, w: 1280, h: 400 },
        padding: { top: 50, right: 50, bottom: 50, left: 50 },
      }),
      figma('img', { type: 'RECTANGLE', box: { x: 50, y: 250, w: 540, h: 300 }, hasImageFill: true, parentId: 'sec' }),
      figma('wrap', { type: 'FRAME', name: 'Text Wrap', box: { x: 700, y: 280, w: 480, h: 220 }, parentId: 'sec' }),
      figma('h', { text: title, box: { x: 710, y: 290, w: 460, h: 40 }, parentId: 'wrap' }),
      figma('p', { text: body, box: { x: 710, y: 350, w: 460, h: 80 }, parentId: 'wrap' }),
    ];
    const nodes = [
      dom('frame', '', { x: 0, y: 220, w: 1440, h: 420 }, {
        kind: 'container',
        tag: 'div',
        signature: 'div|media-frame',
        text: undefined,
        padding: { top: 50, right: 50, bottom: 50, left: 75 },
      }),
      dom('img', '', { x: 75, y: 270, w: 540, h: 300 }, { kind: 'media', tag: 'img', signature: 'img', media: { type: 'img', aspect: 540 / 300 } }),
      dom('wrap', '', { x: 720, y: 300, w: 540, h: 220 }, { kind: 'container', tag: 'div', signature: 'div|copy', text: undefined }),
      dom('h', title, { x: 728, y: 308, w: 520, h: 44 }),
      dom('p', body, { x: 728, y: 368, w: 520, h: 90 }, { kind: 'item', tag: 'p', signature: 'p|' }),
    ];
    const mapped = mapBlocks(snap(nodes), tree(figmaNodes), matchFigmaToDom(snap(nodes), tree(figmaNodes)).pairs);
    assert.equal(mapped.blocks[0]?.figma.id, 'wrap');
    assert.equal(mapped.owners.length, 1);
    assert.equal(mapped.owners[0].figma.id, 'sec');
    assert.equal(mapped.owners[0].dom.id, 'frame');
    assert.equal(mapped.owners[0].role, 'layout-owner');
    assert.equal(mapped.owners[0].figmaPad.left, 50);
    assert.equal(mapped.owners[0].domPad.left, 75);

    const hits = detectFigmaDom(snap(nodes), tree(figmaNodes));
    const pad = hits.find((h) => h.evidence.howGrouped === 'figma-padding' && h.evidence.structuralRole === 'layout-owner');
    assert.ok(pad);
    assert.equal(pad!.evidence.figmaId, 'sec');
    assert.equal(pad!.locator, '#frame');
    assert.equal(pad!.evidence.figmaValue, 50);
    assert.equal(pad!.evidence.value, 75);
    assert.equal(Math.round(pad!.evidence.delta), 25);
  });

  it('maps a padded image-fill frame from a single heading pair', () => {
    const heading = 'Unique banner heading for the overlay';
    const figmaNodes = [
      figma('banner', {
        type: 'INSTANCE',
        name: 'Full Width Banner',
        box: { x: 0, y: 400, w: 1280, h: 540 },
        padding: { top: 50, right: 50, bottom: 50, left: 50 },
      }),
      figma('shot', {
        type: 'FRAME',
        name: 'Media',
        box: { x: 50, y: 450, w: 1180, h: 440 },
        padding: { top: 50, right: 50, bottom: 50, left: 50 },
        hasImageFill: true,
        parentId: 'banner',
      }),
      figma('copy', { type: 'FRAME', name: 'Copy', box: { x: 100, y: 700, w: 520, h: 140 }, parentId: 'shot' }),
      figma('h', { text: heading, box: { x: 100, y: 700, w: 520, h: 48 }, parentId: 'copy' }),
    ];
    const nodes = [
      dom('frame', '', { x: 120, y: 420, w: 1200, h: 500 }, {
        kind: 'container',
        tag: 'div',
        signature: 'div|media-frame',
        text: undefined,
        padding: { top: 75, right: 75, bottom: 75, left: 75 },
      }),
      dom('img', '', { x: 120, y: 420, w: 1200, h: 500 }, { kind: 'media', tag: 'img', signature: 'img', media: { type: 'img', aspect: 1200 / 500 } }),
      dom('h', heading, { x: 195, y: 700, w: 530, h: 50 }, { kind: 'heading', tag: 'h2', signature: 'h2' }),
    ];
    const mapped = mapBlocks(snap(nodes), tree(figmaNodes), matchFigmaToDom(snap(nodes), tree(figmaNodes)).pairs);
    assert.equal(mapped.owners.length, 1);
    assert.equal(mapped.owners[0].figmaPad.left, 50);
    assert.equal(mapped.owners[0].domPad.left, 75);
    assert.equal(mapped.owners[0].dom.id, 'frame');
    const hits = detectFigmaDom(snap(nodes), tree(figmaNodes));
    const pad = hits.find((h) => h.evidence.howGrouped === 'figma-padding' && h.evidence.structuralRole === 'layout-owner');
    assert.ok(pad);
    assert.equal(pad!.evidence.figmaValue, 50);
    assert.equal(pad!.evidence.value, 75);
    assert.equal(Math.round(pad!.evidence.delta), 25);
  });

  it('does not treat a padded text column as the layout owner', () => {
    const figmaNodes = [
      figma('content', {
        type: 'FRAME',
        name: 'Content',
        box: { x: 80, y: 180, w: 560, h: 260 },
        padding: { top: 0, right: 20, bottom: 0, left: 100 },
      }),
      figma('wrap', { type: 'FRAME', name: 'Text Wrap', box: { x: 180, y: 180, w: 440, h: 260 }, parentId: 'content' }),
      figma('h', { text: title, box: { x: 188, y: 188, w: 420, h: 40 }, parentId: 'wrap' }),
      figma('p', { text: body, box: { x: 188, y: 248, w: 420, h: 80 }, parentId: 'wrap' }),
    ];
    const nodes = [
      dom('wrap', '', { x: 200, y: 200, w: 490, h: 280 }, { kind: 'container', tag: 'div', signature: 'div|copy', text: undefined }),
      dom('h', title, { x: 208, y: 208, w: 470, h: 44 }),
      dom('p', body, { x: 208, y: 268, w: 470, h: 90 }, { kind: 'item', tag: 'p', signature: 'p|' }),
    ];
    const mapped = mapBlocks(snap(nodes), tree(figmaNodes), matchFigmaToDom(snap(nodes), tree(figmaNodes)).pairs);
    assert.equal(mapped.blocks[0]?.figma.id, 'wrap');
    assert.equal(mapped.owners.length, 0);
    assert.ok(mapped.ownerSkipped.some((s) => s.reason.startsWith('owner-missing')));
  });
});

describe('detectFigmaDom padding', () => {
  it('emits a padding candidate when DOM inset is larger than Figma', () => {
    const figmaNodes = [
      figma('col', { type: 'FRAME', box: { x: 100, y: 200, w: 400, h: 200 }, padding: { top: 16, right: 16, bottom: 16, left: 16 } }),
      figma('h', { text: title, box: { x: 116, y: 216, w: 368, h: 36 }, parentId: 'col' }),
      figma('p', { text: body, box: { x: 116, y: 268, w: 368, h: 80 }, parentId: 'col' }),
    ];
    const nodes = [
      dom('wrap', '', { x: 100, y: 200, w: 450, h: 280 }, { kind: 'container', tag: 'div', signature: 'div|copy', text: undefined }),
      dom('h', title, { x: 164, y: 264, w: 322, h: 40 }),
      dom('p', body, { x: 164, y: 324, w: 322, h: 90 }, { kind: 'item', tag: 'p', signature: 'p|' }),
    ];
    const hits = detectFigmaDom(snap(nodes), tree(figmaNodes));
    const pad = hits.find((h) => h.evidence.howGrouped === 'figma-padding');
    assert.ok(pad);
    assert.equal(pad!.evidence.figmaId, 'col');
    assert.ok((pad!.evidence.confidence ?? 0) >= 0.72);
    assert.ok(pad!.evidence.sides);
  });

  it('does not need three peers to emit a heading-description gap', () => {
    const figmaNodes = [
      figma('col', { type: 'FRAME', box: { x: 100, y: 200, w: 400, h: 200 }, padding: { top: 8, right: 8, bottom: 8, left: 8 } }),
      figma('h', { text: title, box: { x: 108, y: 208, w: 380, h: 36 }, parentId: 'col' }),
      figma('p', { text: body, box: { x: 108, y: 252, w: 380, h: 80 }, parentId: 'col' }),
    ];
    const nodes = [
      dom('wrap', '', { x: 112, y: 225, w: 450, h: 260 }, { kind: 'container', tag: 'div', signature: 'div|copy', text: undefined }),
      dom('h', title, { x: 128, y: 241, w: 418, h: 40 }),
      dom('p', body, { x: 128, y: 321, w: 418, h: 90 }, { kind: 'item', tag: 'p', signature: 'p|' }),
    ];
    const hits = detectFigmaDom(snap(nodes), tree(figmaNodes));
    assert.ok(hits.some((h) => h.evidence.howGrouped === 'figma-heading-gap'));
  });
});
