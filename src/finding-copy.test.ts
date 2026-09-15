import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findingBasis, findingCompare, findingStatus, findingTitle } from './finding-copy.js';

describe('findingCompare', () => {
  it('keeps Design / Live lines', () => {
    const c = findingCompare('Design: 56px from the image edge.\nLive: 75px from the image edge.');
    assert.equal(c.design, '56px from the image edge');
    assert.equal(c.live, '75px from the image edge');
  });

  it('splits the old banner sentence', () => {
    const c = findingCompare(
      'Overlay text “Our mission” is 75px from the image edge on the page, Figma 50px (×1.13 → 56px). Measured as text inset on the image surface, not a text-wrap wrapper.',
    );
    assert.equal(c.live, '“Our mission” is 75px from the image edge');
    assert.equal(c.design, '56px from the image edge');
  });

  it('splits In the design / On the live site', () => {
    const c = findingCompare(
      "In the design, the 'Our mission' heading is near the top-left of the banner image. On the live site, the text is pushed to the bottom edge of the container.",
    );
    assert.match(c.design ?? '', /top-left/i);
    assert.match(c.live ?? '', /bottom/i);
  });
});

describe('findingTitle', () => {
  it('rewrites the old banner title', () => {
    assert.equal(
      findingTitle(
        'Banner inset differs from Figma',
        'Overlay text “Our mission” is 75px from the image edge on the page, Figma 50px.',
      ),
      '“Our mission” is too far from the banner edge',
    );
  });
});

describe('findingStatus', () => {
  it('says new this run, not measured', () => {
    assert.equal(
      findingStatus({ severity: 'minor', viewports: ['desktop'], isNew: true }),
      'Minor · Desktop · new this run',
    );
  });
});

describe('findingBasis', () => {
  it('keeps a page-only measurement out of the design tier', () => {
    assert.equal(
      findingBasis({ measured: true, locatedHow: 'measured on DOM: two text boxes intersect' }),
      'page',
    );
    assert.equal(
      findingBasis({ measured: true, locatedHow: 'measured on DOM: 323px empty on the first screen' }),
      'page',
    );
    assert.equal(
      findingBasis({ measured: true, locatedHow: 'measured on DOM: aspect distortion 22%' }),
      'page',
    );
  });

  it('sends every Figma comparison to the tier that asks for a second look', () => {
    assert.equal(
      findingBasis({ measured: true, locatedHow: 'measured on DOM: gap 27px vs Figma 53px' }),
      'design',
    );
    assert.equal(
      findingBasis({ measured: true, locatedHow: 'measured on DOM: unique Figma text has no matching run' }),
      'design',
    );
    assert.equal(
      findingBasis({ measured: true, locatedHow: 'measured on DOM: same-column left 24px apart vs Figma' }),
      'design',
    );
  });

  it('treats an unproved or unlocated finding conservatively', () => {
    assert.equal(findingBasis({ measured: false }), 'ai');
    assert.equal(findingBasis({}), 'ai');
    assert.equal(findingBasis({ measured: true }), 'design');
  });
});
