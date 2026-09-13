import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaRegion } from './browser.js';
import type { TextItem } from './browser.js';
import type { FigmaOverlay } from './design.js';
import {
  isInsetBanner,
  isNonContentChrome,
  loneAspectOutlier,
  mediaRowKey,
  missingUniqueFigmaText,
  overlayBannerPad,
  overlayGutter,
  overlayNeighborGap,
  overlayRowAlign,
  overlayTextImageBaseline,
  overlayTypeCompare,
  peerImageAspect,
  stretchedImages,
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
    assert.match(hits[0].finding.title, /shape|row|card/i);
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

  it('zips nav + heading when both sides have the same count', () => {
    const pairs = uniqueTextPairs(
      [
        { text: 'Projects', y: 40 },
        { text: 'Projects', y: 200 },
      ],
      [
        { text: 'Projects', y: 48 },
        { text: 'Projects', y: 240 },
      ],
    );
    assert.deepEqual(pairs, [
      { fi: 0, di: 0 },
      { fi: 1, di: 1 },
    ]);
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
    assert.match(hits[0].finding.title, /Our mission|banner/i);
    assert.match(hits[0].finding.detail, /75px/);
    assert.match(hits[0].finding.detail, /Live:/);
    assert.match(hits[0].finding.detail, /Design:/);
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

function run(text: string, x: number, y: number, w: number, h: number, extra: Partial<TextItem> = {}): TextItem {
  return { text, x, y, w, h, tag: 'p', ...extra };
}

describe('missingUniqueFigmaText', () => {
  const overlay: FigmaOverlay = {
    pageWidth: 1440,
    texts: [
      { text: 'See all', x: 1200, y: 800, w: 80, h: 20 },
      { text: 'Learn more', x: 100, y: 400, w: 120, h: 20 },
      { text: 'Learn more', x: 400, y: 400, w: 120, h: 20 },
    ],
    surfaces: [],
  };

  it('flags a unique short label that is not on the page', () => {
    const hits = missingUniqueFigmaText([run('Flagship projects', 80, 800, 300, 40), run('Learn more', 100, 400, 120, 20)], overlay, 1440);
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.title, /See all/);
    assert.equal(hits[0].finding.measured, true);
  });

  it('does not flag a unique label that is present', () => {
    const hits = missingUniqueFigmaText(
      [run('See all', 1200, 800, 80, 20), run('Learn more', 100, 400, 120, 20)],
      overlay,
      1440,
    );
    assert.equal(hits.length, 0);
  });

  it('does not flag a repeated CTA that is missing', () => {
    const hits = missingUniqueFigmaText([run('Flagship projects', 80, 800, 300, 40)], overlay, 1440);
    assert.equal(
      hits.some((h) => /Learn more/.test(h.finding.title)),
      false,
    );
  });

  it('does not flag a long heading whose words are already on the page', () => {
    const hits = missingUniqueFigmaText(
      [
        run('Marketing strategy driven by', 80, 200, 400, 24),
        run('intelligent systems', 80, 230, 400, 24),
      ],
      {
        pageWidth: 1440,
        texts: [{ text: 'Marketing strategy driven by intelligent systems', x: 80, y: 200, w: 500, h: 48 }],
        surfaces: [],
      },
      1440,
    );
    assert.equal(hits.length, 0);
  });

  it('does not flag form labels, chips, or dates', () => {
    const hits = missingUniqueFigmaText(
      [run('Contact', 80, 40, 80, 20)],
      {
        pageWidth: 1440,
        texts: [
          { text: 'Full name', x: 80, y: 200, w: 120, h: 20 },
          { text: 'Industry', x: 80, y: 240, w: 80, h: 20 },
          { text: '17 July 2026', x: 80, y: 280, w: 120, h: 20 },
          { text: 'See all', x: 400, y: 80, w: 80, h: 20 },
        ],
        surfaces: [],
      },
      1440,
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.title, /See all/);
  });
});

describe('isNonContentChrome', () => {
  it('keeps CTAs and drops form / chip / date strings', () => {
    assert.equal(isNonContentChrome('See all'), false);
    assert.equal(isNonContentChrome('Learn more'), false);
    assert.equal(isNonContentChrome('Full name'), true);
    assert.equal(isNonContentChrome('Email address'), true);
    assert.equal(isNonContentChrome('Industry'), true);
    assert.equal(isNonContentChrome('17 July 2026'), true);
    assert.equal(isNonContentChrome('hello@wooagency.com.au'), true);
  });
});

describe('stretchedImages', () => {
  it('emits a card whose displayed aspect drifted more than 15%', () => {
    const hits = stretchedImages([
      { kind: 'img', x: 0, y: 200, w: 600, h: 200, distortion: 0.22, selector: 'article > img' },
      { kind: 'img', x: 0, y: 800, w: 280, h: 330, distortion: 0.02, selector: 'article > img.ok' },
    ]);
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.title, /stretch/i);
    assert.match(hits[0].finding.detail, /22%/);
  });
});

describe('overlayNeighborGap', () => {
  it('flags a title-to-lead gap that grew by 12px', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        { text: 'Insights', x: 80, y: 100, w: 400, h: 40 },
        { text: 'Stories from the studio', x: 80, y: 160, w: 500, h: 24 },
      ],
      surfaces: [],
    };
    const hits = overlayNeighborGap(
      [run('Insights', 80, 100, 400, 40), run('Stories from the studio', 80, 172, 500, 24)],
      overlay,
      1440,
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.detail, /32px/);
    assert.match(hits[0].finding.detail, /20px/);
  });

  it('uses the Figma neighbour, not the next unique pair in Y order', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1280,
      texts: [
        { text: 'Insights', x: 80, y: 100, w: 400, h: 40 },
        { text: 'Unrelated sidebar', x: 700, y: 130, w: 200, h: 20 },
        { text: 'Stories from the studio', x: 80, y: 160, w: 500, h: 24 },
      ],
      surfaces: [],
    };
    const hits = overlayNeighborGap(
      [
        run('Insights', 80, 100, 400, 40),
        run('Unrelated sidebar', 900, 400, 200, 20),
        run('Stories from the studio', 80, 172, 500, 24),
      ],
      overlay,
      1440,
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.detail, /32px/);
    assert.match(hits[0].finding.detail, /20px/);
  });
});

describe('overlayRowAlign', () => {
  it('flags a second title that is inset 16px vs its Figma peer', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        { text: 'First project', x: 80, y: 500, w: 400, h: 32 },
        { text: 'Second project', x: 760, y: 500, w: 400, h: 32 },
      ],
      surfaces: [],
    };
    const hits = overlayRowAlign(
      [run('First project', 80, 500, 400, 32), run('Second project', 776, 500, 400, 32)],
      overlay,
      1440,
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.title, /line up/);
  });

  it('does not compare two left-edge headings that are not on the same Figma row', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        { text: 'How we help you', x: 80, y: 100, w: 300, h: 32 },
        { text: 'Trusted by the best', x: 80, y: 166, w: 300, h: 32 },
      ],
      surfaces: [],
    };
    const hits = overlayRowAlign(
      [run('How we help you', 80, 100, 300, 32), run('Trusted by the best', 80, 847, 300, 32)],
      overlay,
      1440,
    );
    assert.equal(hits.length, 0);
  });
});

describe('overlayTextImageBaseline', () => {
  it('flags copy that no longer shares the photo bottom', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [{ text: 'Our Vision', x: 80, y: 860, w: 400, h: 40 }],
      surfaces: [{ x: 700, y: 400, w: 600, h: 500 }],
    };
    const hits = overlayTextImageBaseline(
      [run('Our Vision', 80, 420, 400, 40)],
      [{ kind: 'img', x: 700, y: 400, w: 600, h: 500, selector: 'section > img' }],
      overlay,
      1440,
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.title, /bottom/);
  });
});

describe('overlayTypeCompare', () => {
  it('flags a heading that rendered 3px smaller', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [{ text: 'Projects', x: 80, y: 100, w: 400, h: 50, fontSize: 45, fontWeight: 400, lineHeight: 58 }],
      surfaces: [],
    };
    const hits = overlayTypeCompare(
      [run('Projects', 80, 100, 400, 50, { fontSize: 42, fontWeight: 400, lineHeight: 54 })],
      overlay,
      1440,
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.title, /size/);
  });

  it('flags a weight drop of 100', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [{ text: 'Submit', x: 80, y: 400, w: 120, h: 24, fontSize: 16, fontWeight: 500, lineHeight: 20 }],
      surfaces: [],
    };
    const hits = overlayTypeCompare(
      [run('Submit', 80, 400, 120, 24, { fontSize: 16, fontWeight: 400, lineHeight: 20 })],
      overlay,
      1440,
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.title, /weight/);
  });

  it('compares CSS px, not a 1280→1440 scaled size', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1280,
      texts: [{ text: 'Projects', x: 80, y: 100, w: 400, h: 50, fontSize: 45, fontWeight: 400, lineHeight: 58 }],
      surfaces: [],
    };
    const miss = overlayTypeCompare(
      [run('Projects', 80, 100, 400, 50, { fontSize: 42, fontWeight: 400, lineHeight: 54 })],
      overlay,
      1440,
    );
    assert.equal(miss.length, 1);
    const match = overlayTypeCompare(
      [run('Projects', 80, 100, 400, 50, { fontSize: 45, fontWeight: 400, lineHeight: 58 })],
      overlay,
      1440,
    );
    assert.equal(match.length, 0);
  });
});
