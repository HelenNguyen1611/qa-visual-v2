import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { flattenFigmaTree } from './figmaTree.js';

describe('flattenFigmaTree', () => {
  it('keeps TEXT and image fills, relative to the frame origin', () => {
    const tree = flattenFigmaTree(
      {
        id: 'f',
        name: 'Home',
        type: 'FRAME',
        absoluteBoundingBox: { x: 100, y: 50, width: 1440, height: 2000 },
        children: [
          {
            id: 't1',
            name: 'Title',
            type: 'TEXT',
            characters: 'Unique heading here',
            style: { fontSize: 32 },
            absoluteBoundingBox: { x: 140, y: 90, width: 200, height: 40 },
          },
          {
            id: 'img',
            name: 'Photo',
            type: 'RECTANGLE',
            fills: [{ type: 'IMAGE' }],
            absoluteBoundingBox: { x: 140, y: 140, width: 320, height: 180 },
          },
          {
            id: 'icon',
            name: 'Icon',
            type: 'VECTOR',
            absoluteBoundingBox: { x: 140, y: 330, width: 16, height: 16 },
          },
        ],
      },
      'f',
    );
    assert.ok(tree);
    assert.equal(tree!.frame.w, 1440);
    assert.equal(tree!.nodes.length, 2);
    assert.equal(tree!.nodes[0].box.x, 40);
    assert.equal(tree!.nodes[0].box.y, 40);
    assert.equal(tree!.nodes[1].hasImageFill, true);
  });

  it('keeps an inner FRAME so a content block can be mapped', () => {
    const tree = flattenFigmaTree(
      {
        id: 'f',
        name: 'Home',
        type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 1280, height: 2000 },
        children: [
          {
            id: 'col',
            name: 'Copy',
            type: 'FRAME',
            paddingTop: 24,
            paddingBottom: 24,
            paddingLeft: 32,
            paddingRight: 32,
            absoluteBoundingBox: { x: 100, y: 200, width: 480, height: 300 },
            children: [
              {
                id: 't1',
                name: 'H',
                type: 'TEXT',
                characters: 'Unique heading here',
                absoluteBoundingBox: { x: 132, y: 224, width: 400, height: 40 },
              },
            ],
          },
        ],
      },
      'f',
    );
    assert.ok(tree);
    const col = tree!.nodes.find((n) => n.id === 'col');
    assert.ok(col);
    assert.equal(col!.type, 'FRAME');
    assert.deepEqual(col!.padding, { top: 24, right: 32, bottom: 24, left: 32 });
  });

  it('returns undefined when the root has no box', () => {
    assert.equal(flattenFigmaTree({ id: 'x', name: 'Empty', type: 'FRAME' }, 'x'), undefined);
  });
});
