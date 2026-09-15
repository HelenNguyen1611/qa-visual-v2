import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { flattenFigmaOverlay } from './design.js';

describe('flattenFigmaOverlay', () => {
  it('records the parent frame and the INSTANCE a TEXT sits in', () => {
    const overlay = flattenFigmaOverlay({
      id: 'page',
      type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 1280, height: 800 },
      children: [
        {
          id: 'inst-home-services',
          type: 'INSTANCE',
          absoluteBoundingBox: { x: 80, y: 200, width: 600, height: 200 },
          children: [
            {
              id: 'card-a',
              type: 'FRAME',
              absoluteBoundingBox: { x: 80, y: 200, width: 600, height: 80 },
              children: [
                {
                  id: 't1',
                  type: 'TEXT',
                  characters: 'Marketing strategy',
                  absoluteBoundingBox: { x: 80, y: 200, width: 200, height: 24 },
                },
              ],
            },
            {
              id: 'card-b',
              type: 'FRAME',
              absoluteBoundingBox: { x: 80, y: 300, width: 600, height: 80 },
              children: [
                {
                  id: 't2',
                  type: 'TEXT',
                  characters: 'AI transformation',
                  absoluteBoundingBox: { x: 80, y: 300, width: 200, height: 24 },
                },
              ],
            },
          ],
        },
        {
          id: 'see',
          type: 'INSTANCE',
          absoluteBoundingBox: { x: 80, y: 700, width: 80, height: 20 },
          children: [
            {
              id: 't3',
              type: 'TEXT',
              characters: 'See all',
              absoluteBoundingBox: { x: 80, y: 700, width: 80, height: 20 },
            },
          ],
        },
      ],
    });
    const a = overlay.texts.find((t) => t.text === 'Marketing strategy');
    const b = overlay.texts.find((t) => t.text === 'AI transformation');
    const c = overlay.texts.find((t) => t.text === 'See all');
    assert.equal(a?.parentId, 'card-a');
    assert.equal(b?.parentId, 'card-b');
    assert.equal(a?.instanceId, 'inst-home-services');
    assert.equal(b?.instanceId, 'inst-home-services');
    assert.equal(c?.instanceId, 'see');
    assert.notEqual(a?.parentId, b?.parentId);
  });
});
