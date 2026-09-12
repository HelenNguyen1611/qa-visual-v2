import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaRegion } from './browser.js';
import type { TextItem } from './browser.js';
import type { FigmaOverlay } from './design.js';
import {
  isInsetBanner,
  loneAspectOutlier,
  mediaRowKey,
  overlayBannerPad,
  overlayGutter,
  peerImageAspect,
  uniqueTextPairs,
} from './verify.js';

function img(id: string, x: number, y: number, w: number, h: number, card = 'article.card'): MediaRegion {
  return {
    kind: 'img',
    x,
    y,
    w,
    h,
    selector: `section#row > div.track > ${card} > img.${id}`,
  };
}

function carousel(x: number, y: number, w: number, h: number, card: string): MediaRegion {
  return {
    kind: 'img',
    x,
    y,
    w,
    h,
    selector: `${card} > a.carousel__card-link > div.carousel__media > picture > img.carousel__image`,
  };
}

describe('mediaRowKey', () => {
  it('drops the card and the image so a BEM modifier stays in the same row', () => {
    const a = mediaRowKey('section#ind > div.track > article.carousel__card > img.photo');
    const b = mediaRowKey('section#ind > div.track > article.carousel__card--wide > img.photo');
    assert.equal(a, b);
    assert.equal(a, 'section#ind > div.track');
  });

  it('strips a BEM modifier on the card when picture/link wrappers sit under it', () => {
    const a = mediaRowKey(
      'article.carousel__card > a.carousel__card-link > div.carousel__media > picture > img.carousel__image',
    );
    const b = mediaRowKey(
      'article.carousel__card.carousel__card--wide > a.carousel__card-link > div.carousel__media > picture > img.carousel__image',
    );
    const c = mediaRowKey(
      'article.carousel__card.carousel__card--clone > a.carousel__card-link > div.carousel__media > picture > img.carousel__image',
    );
    assert.equal(a, b);
    assert.equal(a, c);
    assert.equal(a, 'article.carousel__card > a.carousel__card-link > div.carousel__media');
  });

  it('does not invent a row for a lone hero image', () => {
    assert.equal(mediaRowKey('section.hero > img'), '');
  });
});

describe('loneAspectOutlier', () => {
  it('flags a square among landscape peers', () => {
    assert.equal(loneAspectOutlier([0.84, 0.85, 1, 0.86]), 2);
  });

  it('needs three values', () => {
    assert.equal(loneAspectOutlier([0.84, 1]), -1);
  });

  it('does not flag a group that is all different', () => {
    assert.equal(loneAspectOutlier([0.5, 1, 1.6, 2.2]), -1);
  });
});

describe('peerImageAspect', () => {
  it('emits the square card in a four-image row', () => {
    const hits = peerImageAspect(
      [
        img('a', 0, 800, 280, 330),
        img('b', 300, 800, 280, 330),
        img('c', 600, 800, 330, 330, 'article.card--wide'),
        img('d', 940, 800, 280, 330),
      ],
      1440,
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0].box.w, 330);
    assert.match(hits[0].finding.title, /aspect/i);
    assert.equal(hits[0].finding.measured, true);
  });

  it('groups a nested card--wide with its peers and ignores off-canvas clones', () => {
    const hits = peerImageAspect(
      [
        carousel(-1300, 4100, 320, 380, 'article.carousel__card.carousel__card--clone'),
        carousel(140, 4100, 380, 380, 'article.carousel__card.carousel__card--wide'),
        carousel(560, 4100, 320, 380, 'article.carousel__card'),
        carousel(920, 4100, 320, 380, 'article.carousel__card'),
        carousel(1280, 4100, 320, 380, 'article.carousel__card'),
        carousel(2000, 4100, 380, 380, 'article.carousel__card.carousel__card--wide'),
      ],
      1440,
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0].box.x, 140);
    assert.equal(hits[0].box.w, 380);
    assert.equal(hits[0].box.h, 380);
  });

  it('does not compare a hero to a card row', () => {
    const hits = peerImageAspect(
      [
        { kind: 'img', x: 0, y: 0, w: 1440, h: 700, selector: 'section.hero > img' },
        img('a', 0, 800, 280, 330),
        img('b', 300, 800, 280, 330),
      ],
      1440,
    );
    assert.equal(hits.length, 0);
  });

  it('does not flag when every card matches', () => {
    const hits = peerImageAspect(
      [img('a', 0, 800, 280, 330), img('b', 300, 800, 280, 330), img('c', 600, 800, 280, 330)],
      1440,
    );
    assert.equal(hits.length, 0);
  });
});

function heading(text: string, x: number, y: number, w: number, h: number): TextItem {
  return { text, x, y, w, h, tag: 'h2', heading: 'h2' };
}

describe('isInsetBanner', () => {
  it('keeps a wide image that does not span the page', () => {
    assert.equal(isInsetBanner({ x: 120, y: 1900, w: 1200, h: 537 }, 1440), true);
    assert.equal(isInsetBanner({ x: 50, y: 2000, w: 1180, h: 537 }, 1280), true);
  });

  it('rejects a full-bleed hero', () => {
    assert.equal(isInsetBanner({ x: 0, y: 0, w: 1440, h: 900 }, 1440), false);
    assert.equal(isInsetBanner({ x: 0, y: 78, w: 1280, h: 760 }, 1280), false);
  });
});

describe('uniqueTextPairs', () => {
  it('pairs a unique heading and ignores a repeated CTA', () => {
    const pairs = uniqueTextPairs(
      [{ text: 'Our mission' }, { text: 'Learn more' }],
      [{ text: 'Our mission' }, { text: 'Learn more' }, { text: 'Learn more' }],
    );
    assert.deepEqual(pairs, [{ fi: 0, di: 0 }]);
  });
});

describe('overlayBannerPad', () => {
  const overlay: FigmaOverlay = {
    pageWidth: 1280,
    texts: [{ text: 'Our mission', x: 100, y: 2425, w: 530, h: 53 }],
    surfaces: [{ x: 50, y: 2089, w: 1180, h: 537 }],
  };

  it('flags an overlay gutter that is 50 in Figma and 75 on the page', () => {
    assert.equal(overlayGutter({ x: 100, y: 2425, w: 530, h: 53 }, { x: 50, y: 2089, w: 1180, h: 537 }), 50);
    const hits = overlayBannerPad(
      [heading('Our mission', 195, 2256, 530, 53)],
      [{ kind: 'img', x: 120, y: 1945, w: 1200, h: 537, selector: 'div.banner > img' }],
      overlay,
      1440,
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.title, /banner/i);
    assert.match(hits[0].finding.detail, /75px/);
    assert.equal(hits[0].box.w, 1200);
  });

  it('does not compare a heading sitting on a full-bleed hero', () => {
    const hits = overlayBannerPad(
      [heading('Reliable energy for a changing world.', 120, 200, 600, 80)],
      [{ kind: 'img', x: 0, y: 0, w: 1440, h: 900, selector: 'section.hero > img' }],
      {
        pageWidth: 1280,
        texts: [{ text: 'Reliable energy for a changing world.', x: 50, y: 200, w: 568, h: 80 }],
        surfaces: [{ x: 0, y: 78, w: 1280, h: 760 }],
      },
      1440,
    );
    assert.equal(hits.length, 0);
  });

  it('does not flag when the gutter already matches', () => {
    const hits = overlayBannerPad(
      [heading('Our mission', 170, 2256, 530, 53)],
      [{ kind: 'img', x: 120, y: 1945, w: 1200, h: 537, selector: 'div.banner > img' }],
      overlay,
      1440,
    );
    assert.equal(hits.length, 0);
  });
});
