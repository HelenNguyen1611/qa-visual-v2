import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeomNode, GeomSnapshot } from './types.js';
import type { FigmaGeomNode, FigmaGeomTree } from './figmaTree.js';
import { matchFigmaToDom, textScore } from './match.js';

function dom(id: string, text: string, extra: Partial<GeomNode> = {}): GeomNode {
  return {
    id,
    siblingIndex: 0,
    kind: extra.kind ?? 'heading',
    tag: extra.tag ?? 'h2',
    locator: `#${id}`,
    classes: [],
    signature: extra.signature ?? 'h2',
    box: extra.box ?? { x: 40, y: 80, w: 400, h: 40 },
    text,
    ...extra,
  };
}

function figma(id: string, text: string, extra: Partial<FigmaGeomNode> = {}): FigmaGeomNode {
  return {
    id,
    name: text,
    type: extra.type ?? 'TEXT',
    box: extra.box ?? { x: 40, y: 80, w: 200, h: 36 },
    text,
    fontSize: extra.fontSize ?? 28,
    ...extra,
  };
}

function tree(nodes: FigmaGeomNode[]): FigmaGeomTree {
  return { frameId: 'f', frameName: 'Home', frame: { x: 0, y: 0, w: 1440, h: 2400 }, nodes };
}

const snap = (nodes: GeomNode[]): GeomSnapshot => ({ viewportWidth: 1440, viewportHeight: 900, pageHeight: 2400, nodes });

describe('textScore', () => {
  it('scores an exact phrase 1 and rejects thin overlap', () => {
    assert.equal(textScore('clean energy for homes', 'clean energy for homes'), 1);
    assert.equal(textScore('learn more', 'about us'), 0);
  });
});

describe('matchFigmaToDom', () => {
  it('pairs a unique heading', () => {
    const r = matchFigmaToDom(
      snap([dom('a', 'Clean energy for homes'), dom('b', 'Our latest insights')]),
      tree([figma('t1', 'Clean energy for homes'), figma('t2', 'Our latest insights')]),
    );
    assert.equal(r.stats.matched, 2);
    assert.equal(r.pairs[0].how, 'text-unique');
  });

  it('does not pair a Figma TEXT to a section wrapper', () => {
    const r = matchFigmaToDom(
      snap([
        {
          id: 'sec',
          siblingIndex: 0,
          kind: 'section',
          tag: 'section',
          locator: '#sec',
          classes: [],
          signature: 'section',
          box: { x: 0, y: 0, w: 1440, h: 600 },
          text: 'Our mission lives inside this whole band of content',
        },
      ]),
      tree([figma('t1', 'Our mission lives inside this whole band of content')]),
    );
    assert.equal(r.stats.matched, 0);
  });

  it('does not pair a repeated generic CTA', () => {
    const r = matchFigmaToDom(
      snap([dom('a', 'Learn more', { kind: 'item', tag: 'a' }), dom('b', 'Learn more', { kind: 'item', tag: 'a' })]),
      tree([figma('t1', 'Learn more'), figma('t2', 'Learn more')]),
    );
    assert.equal(r.stats.matched, 0);
  });

  it('skips an ambiguous title that matches two DOM nodes equally', () => {
    const r = matchFigmaToDom(
      snap([dom('a', 'Battery storage options'), dom('b', 'Battery storage options')]),
      tree([figma('t1', 'Battery storage options')]),
    );
    assert.equal(r.stats.matched, 0);
    assert.ok(r.stats.ambiguous >= 1);
  });

  it('pairs the only nearby image on both sides', () => {
    const title = figma('t1', 'Insight one unique title', { box: { x: 40, y: 100, w: 200, h: 30 } });
    const img = figma('img', '', {
      type: 'RECTANGLE',
      text: undefined,
      hasImageFill: true,
      box: { x: 40, y: 140, w: 320, h: 180 },
    });
    const r = matchFigmaToDom(
      snap([
        dom('h', 'Insight one unique title', { box: { x: 80, y: 200, w: 300, h: 32 } }),
        {
          id: 'm',
          siblingIndex: 1,
          kind: 'media',
          tag: 'img',
          locator: '#m',
          classes: [],
          signature: 'img',
          box: { x: 80, y: 240, w: 352, h: 198 },
          media: { type: 'img', aspect: 352 / 198 },
        },
      ]),
      tree([title, img]),
    );
    assert.equal(r.stats.matched, 1);
    assert.equal(r.media.length, 1);
    assert.equal(r.media[0].dom.id, 'm');
  });
});
