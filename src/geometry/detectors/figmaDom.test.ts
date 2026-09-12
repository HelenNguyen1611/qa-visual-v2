import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeomNode, GeomSnapshot } from '../types.js';
import type { FigmaGeomNode, FigmaGeomTree } from '../figmaTree.js';
import { detectFigmaDom } from './figmaDom.js';

function heading(id: string, text: string, x: number, y: number, w = 280): GeomNode {
  return {
    id,
    siblingIndex: 0,
    kind: 'heading',
    tag: 'h2',
    locator: `#${id}`,
    classes: [],
    signature: 'h2',
    box: { x, y, w, h: 36 },
    text,
  };
}

function figmaText(id: string, text: string, x: number, y: number, w = 200): FigmaGeomNode {
  return {
    id,
    name: text,
    type: 'TEXT',
    box: { x, y, w, h: 32 },
    text,
    fontSize: 28,
  };
}

function tree(nodes: FigmaGeomNode[]): FigmaGeomTree {
  return { frameId: 'f', frameName: 'Home', frame: { x: 0, y: 0, w: 1440, h: 3000 }, nodes };
}

const snap = (nodes: GeomNode[], vw = 1440): GeomSnapshot => ({
  viewportWidth: vw,
  viewportHeight: 900,
  pageHeight: 4000,
  content: { x: 120, y: 0, w: 1200, h: 4000, locator: 'main' },
  nodes,
});

const titles = ['Alpha unique heading one', 'Beta unique heading two', 'Gamma unique heading three', 'Delta unique heading four'];

describe('detectFigmaDom', () => {
  it('flags a heading that jumped between two well-placed neighbors', () => {
    const figma = tree([
      figmaText('a', titles[0], 80, 200),
      figmaText('b', titles[1], 80, 600),
      figmaText('c', titles[2], 80, 1000),
      figmaText('d', titles[3], 80, 1400),
    ]);
    const hits = detectFigmaDom(
      snap([
        heading('a', titles[0], 80, 200),
        heading('b', titles[1], 80, 600),
        heading('c', titles[2], 80, 2200),
        heading('d', titles[3], 80, 1400),
      ]),
      figma,
    );
    assert.ok(hits.some((h) => h.nodeId === 'c' && h.evidence.howGrouped === 'figma-y'));
  });

  it('does not compare a narrow viewport to a page-width frame', () => {
    const figma = tree(titles.map((t, i) => figmaText(`f${i}`, t, 80, 200 + i * 400)));
    const hits = detectFigmaDom(
      snap(
        titles.map((t, i) => heading(`d${i}`, t, 80, 200 + i * 400)),
        390,
      ),
      figma,
    );
    assert.equal(hits.length, 0);
  });

  it('does not emit Y candidates with fewer than 4 unique pairs', () => {
    const figma = tree([figmaText('a', titles[0], 80, 200), figmaText('b', titles[1], 80, 600)]);
    const hits = detectFigmaDom(snap([heading('a', titles[0], 80, 200), heading('b', titles[1], 80, 1800)]), figma);
    assert.equal(hits.length, 0);
  });

  it('flags a card shifted in a four-item Figma row', () => {
    const labels = ['Row card unique alpha', 'Row card unique beta', 'Row card unique gamma', 'Row card unique delta'];
    const figma = tree(labels.map((t, i) => figmaText(`f${i}`, t, 80 + i * 300, 800, 180)));
    const xs = [80, 380, 980, 980];
    const hits = detectFigmaDom(
      snap(labels.map((t, i) => heading(`d${i}`, t, xs[i], 900, 180))),
      figma,
    );
    assert.ok(hits.some((h) => h.nodeId === 'd2' && h.evidence.howGrouped === 'figma-x'));
  });

  it('does not interpolate X across nodes that are not on the same row', () => {
    const figma = tree([
      figmaText('nav', 'Unique nav label aa', 500, 20, 80),
      figmaText('a', titles[0], 80, 400, 180),
      figmaText('b', titles[1], 400, 900, 180),
      figmaText('c', titles[2], 720, 1400, 180),
      figmaText('d', titles[3], 80, 1900, 180),
    ]);
    const hits = detectFigmaDom(
      snap([
        heading('nav', 'Unique nav label aa', 600, 10, 90),
        heading('a', titles[0], 80, 500, 180),
        heading('b', titles[1], 400, 1000, 180),
        heading('c', titles[2], 720, 1500, 180),
        heading('d', titles[3], 80, 2000, 180),
      ]),
      figma,
    );
    assert.equal(hits.filter((h) => h.evidence.howGrouped === 'figma-x').length, 0);
  });

  it('does not treat a block-level heading width as an X error', () => {
    const figma = tree(titles.map((t, i) => figmaText(`f${i}`, t, 40 + i * 20, 200 + i * 400, 180)));
    const hits = detectFigmaDom(
      snap(titles.map((t, i) => heading(`d${i}`, t, 120, 200 + i * 400, 1200))),
      figma,
    );
    assert.equal(
      hits.filter((h) => h.evidence.howGrouped === 'figma-x').length,
      0,
    );
  });

  it('flags a nearby image whose aspect drifted from Figma', () => {
    const nodes: FigmaGeomNode[] = [
      figmaText('t', 'Card title unique enough', 40, 100),
      {
        id: 'img',
        name: 'Photo',
        type: 'RECTANGLE',
        box: { x: 40, y: 140, w: 320, h: 180 },
        hasImageFill: true,
      },
    ];
    const hits = detectFigmaDom(
      snap([
        heading('h', 'Card title unique enough', 80, 200, 300),
        {
          id: 'm',
          siblingIndex: 1,
          kind: 'media',
          tag: 'img',
          locator: '#m',
          classes: [],
          signature: 'img',
          box: { x: 80, y: 240, w: 320, h: 80 },
          media: { type: 'img', aspect: 320 / 80 },
        },
      ]),
      tree(nodes),
    );
    assert.ok(hits.some((h) => h.evidence.howGrouped === 'figma-aspect' && h.nodeId === 'm'));
  });
});
