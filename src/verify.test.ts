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
  skipNeighborGap,
  peerImageAspect,
  stretchedImages,
  uniqueTextPairs,
  rewrittenFigmaCopy,
  sameNeighborStack,
  reusedInstanceTexts,
  detectAll,
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

  it('pairs a display title with the matching-size DOM run when counts differ', () => {
    const pairs = uniqueTextPairs(
      [
        { text: 'Projects', y: 40, fontSize: 16 },
        { text: 'Projects', y: 200, fontSize: 45 },
      ],
      [
        { text: 'Projects', y: 48, fontSize: 16 },
        { text: 'Projects', y: 240, fontSize: 42 },
      ],
    );
    assert.deepEqual(
      pairs.sort((a, b) => a.fi - b.fi),
      [
        { fi: 0, di: 0 },
        { fi: 1, di: 1 },
      ],
    );
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

  it('does not flag a homepage teaser that Figma copied onto another frame', () => {
    const hits = missingUniqueFigmaText(
      [run('Built for how brands actually grow today.', 80, 200, 600, 40)],
      {
        pageWidth: 1440,
        texts: [
          { text: 'How we help you', x: 80, y: 400, w: 200, h: 24 },
          { text: 'See all', x: 400, y: 80, w: 80, h: 20 },
        ],
        surfaces: [],
      },
      1440,
      [run('How we help you', 1100, 800, 180, 24)],
    );
    assert.equal(
      hits.some((h) => /How we help you/.test(h.finding.title)),
      false,
    );
    assert.equal(hits.some((h) => /See all/.test(h.finding.title)), true);
  });

  it('does not flag a card title the CMS rewrote', () => {
    const hits = missingUniqueFigmaText(
      [run('Designed at pace to match cultural trends', 80, 400, 280, 40)],
      {
        pageWidth: 1440,
        texts: [
          { text: 'Content to match cultural trends', x: 80, y: 400, w: 280, h: 40 },
          { text: 'See all', x: 400, y: 80, w: 80, h: 20 },
        ],
        surfaces: [],
      },
      1440,
    );
    assert.equal(
      hits.some((h) => /cultural trends/.test(h.finding.title)),
      false,
    );
    assert.equal(hits.some((h) => /See all/.test(h.finding.title)), true);
    assert.equal(
      rewrittenFigmaCopy(
        'content to match cultural trends',
        'designed at pace to match cultural trends',
      ),
      true,
    );
  });

  it('does not flag a title the CMS split across heading and description', () => {
    const hits = missingUniqueFigmaText(
      [
        run('AI transformation', 80, 400, 280, 24),
        run('Business consulting', 80, 428, 280, 20),
      ],
      {
        pageWidth: 1440,
        texts: [
          { text: 'AI business consulting & transformation', x: 80, y: 400, w: 280, h: 40 },
          { text: 'See all', x: 400, y: 80, w: 80, h: 20 },
        ],
        surfaces: [],
      },
      1440,
    );
    assert.equal(
      hits.some((h) => /consulting/.test(h.finding.title)),
      false,
    );
    assert.equal(hits.some((h) => /See all/.test(h.finding.title)), true);
    assert.equal(
      rewrittenFigmaCopy(
        'ai business consulting transformation',
        'ai transformation business consulting',
      ),
      true,
    );
  });

  it('does not flag copy that lives in a closed filter or on another page of the run', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        { text: 'Marketing strategy', x: 80, y: 120, w: 200, h: 20 },
        { text: 'Management, monitoring & reporting', x: 80, y: 160, w: 320, h: 20 },
        { text: 'AI transformation', x: 80, y: 200, w: 180, h: 20 },
        { text: 'See all', x: 400, y: 80, w: 80, h: 20 },
      ],
      surfaces: [],
    };
    const hits = missingUniqueFigmaText(
      [run('Flagship projects', 80, 80, 300, 40)],
      overlay,
      1440,
      [],
      [
        'Filter by All Brand Experience Marketing strategy Integrity',
        '02 Marketing strategy Driven by intelligent systems',
        '05 Management, monitoring & reporting',
        '06 AI transformation Business consulting',
      ].join(' '),
    );
    assert.equal(
      hits.some((h) => /Marketing strategy|Management|AI transformation/.test(h.finding.title)),
      false,
    );
    assert.equal(hits.some((h) => /See all/.test(h.finding.title)), true);
  });

  it('does not flag titles that live inside a reused Figma instance', () => {
    const inst = 'inst-home-services';
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        { text: 'Marketing strategy', x: 80, y: 120, w: 200, h: 20, instanceId: inst },
        { text: 'Management, monitoring & reporting', x: 80, y: 160, w: 320, h: 20, instanceId: inst },
        { text: 'AI transformation', x: 80, y: 200, w: 180, h: 20, instanceId: inst },
        { text: 'See all', x: 400, y: 80, w: 80, h: 20, instanceId: 'btn-see' },
      ],
      surfaces: [],
    };
    assert.equal(reusedInstanceTexts(overlay).has('marketing strategy'), true);
    assert.equal(reusedInstanceTexts(overlay).has('see all'), false);
    const hits = missingUniqueFigmaText([run('Flagship projects', 80, 80, 300, 40)], overlay, 1440);
    assert.equal(
      hits.some((h) => /Marketing strategy|Management|AI transformation/.test(h.finding.title)),
      false,
    );
    assert.equal(hits.some((h) => /See all/.test(h.finding.title)), true);
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
  it('flags a title-to-lead gap that grew by a full line', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        { text: 'Insight archive', x: 80, y: 100, w: 400, h: 40 },
        { text: 'Stories from the studio', x: 80, y: 160, w: 500, h: 24 },
      ],
      surfaces: [],
    };
    const hits = overlayNeighborGap(
      [run('Insight archive', 80, 100, 400, 40), run('Stories from the studio', 80, 204, 500, 24)],
      overlay,
      1440,
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.detail, /64px/);
    assert.match(hits[0].finding.detail, /20px/);
  });

  it('uses the Figma neighbour, not the next unique pair in Y order', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1280,
      texts: [
        { text: 'Insight archive', x: 80, y: 100, w: 400, h: 40 },
        { text: 'Unrelated sidebar', x: 700, y: 130, w: 200, h: 20 },
        { text: 'Stories from the studio', x: 80, y: 160, w: 500, h: 24 },
      ],
      surfaces: [],
    };
    const hits = overlayNeighborGap(
      [
        run('Insight archive', 80, 100, 400, 40),
        run('Unrelated sidebar', 900, 400, 200, 20),
        run('Stories from the studio', 80, 204, 500, 24),
      ],
      overlay,
      1440,
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.detail, /64px/);
    assert.match(hits[0].finding.detail, /20px/);
  });

  it('measures H1→lead gap after a role pair when copy is wrapped', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1280,
      texts: [
        { text: 'We keep our finger on the modern marketing pulse so you don’t have to.', x: 80, y: 180, w: 800, h: 100, fontSize: 45 },
        { text: 'Learn more about AI for marketing in the journal lead.', x: 80, y: 300, w: 700, h: 40, fontSize: 16 },
      ],
      surfaces: [],
    };
    const hits = overlayNeighborGap(
      [
        run('We keep our finger on the modern', 80, 186, 700, 50, { heading: 'h1', fontSize: 45 }),
        run('marketing pulse so you don’t have to.', 80, 240, 700, 50, { heading: 'h1', fontSize: 45 }),
        run('Different live lead copy about the studio.', 80, 352, 700, 40, { fontSize: 16 }),
      ],
      overlay,
      1440,
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.detail, /20px/);
  });

  it('does not treat a same-column pair thousands of pixels apart as a neighbour', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1280,
      texts: [
        { text: 'Software development and cyber security', x: 80, y: 400, w: 400, h: 24, fontSize: 16 },
        { text: '226 Lygon Street,', x: 80, y: 429, w: 200, h: 20, fontSize: 16 },
      ],
      surfaces: [],
    };
    const hits = overlayNeighborGap(
      [
        run('Software development and cyber security', 80, 400, 400, 24, { fontSize: 16 }),
        run('226 Lygon Street,', 80, 2900, 200, 20, { fontSize: 16 }),
      ],
      overlay,
      1440,
    );
    assert.equal(hits.length, 0);
  });

  it('does not flag 27px live vs 53px Figma — line-height vs TEXT bounds, not a spacing bug', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        { text: 'If so, you know introducing AI into your business', x: 720, y: 200, w: 480, h: 140, fontSize: 32 },
        { text: 'You operate under tight legal and compliance controls', x: 720, y: 393, w: 480, h: 80, fontSize: 16 },
      ],
      surfaces: [],
    };
    const hits = overlayNeighborGap(
      [
        run('If so, you know introducing AI into your business', 720, 200, 480, 166, { heading: 'h1', fontSize: 32 }),
        run('You operate under tight legal and compliance controls', 720, 393, 480, 80, { fontSize: 16 }),
      ],
      overlay,
      1440,
    );
    assert.equal(hits.length, 0);
    assert.equal(skipNeighborGap(27, 53), true);
  });

  it('does not flag 47px live vs 24px Figma on a stacked service list', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        { text: 'Full-stack web & mobile development — frontend, backend', x: 80, y: 400, w: 600, h: 22, fontSize: 16 },
        { text: 'Cloud infrastructure, CI/CD & DevOps for continuous delivery', x: 80, y: 446, w: 600, h: 22, fontSize: 16 },
      ],
      surfaces: [],
    };
    const hits = overlayNeighborGap(
      [
        run('Full-stack web & mobile development — frontend, backend', 80, 400, 600, 22, { fontSize: 16 }),
        run('Cloud infrastructure, CI/CD & DevOps for continuous delivery', 80, 469, 600, 22, { fontSize: 16 }),
      ],
      overlay,
      1440,
    );
    assert.equal(hits.length, 0);
    assert.equal(skipNeighborGap(47, 24), true);
  });

  it('does not pair a description in one card with a title in another', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        { text: 'Driven by intelligent systems', x: 80, y: 400, w: 400, h: 20, fontSize: 16, parentId: 'card-02' },
        { text: 'Software development and cyber security', x: 80, y: 454, w: 400, h: 24, fontSize: 16, parentId: 'card-07' },
      ],
      surfaces: [],
    };
    const hits = overlayNeighborGap(
      [
        run('Driven by intelligent systems', 80, 400, 400, 20, { fontSize: 16, host: 'div.woo-service' }),
        run('Software development and cyber security', 80, 527, 400, 24, { fontSize: 16, host: 'div.woo-service-other' }),
      ],
      overlay,
      1440,
    );
    assert.equal(hits.length, 0);
    assert.equal(
      sameNeighborStack(
        { x: 80, y: 400, w: 400, h: 20, parentId: 'card-02' },
        { x: 80, y: 454, w: 400, h: 24, parentId: 'card-07' },
      ),
      false,
    );
  });
});

describe('overlayRowAlign', () => {
  it('flags a stacked title whose live left edge drifted from the column', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        { text: 'How we help you', x: 80, y: 400, w: 300, h: 32 },
        { text: 'Trusted by the best', x: 80, y: 847, w: 300, h: 32 },
      ],
      surfaces: [],
    };
    const hits = overlayRowAlign(
      [run('How we help you', 80, 400, 300, 32), run('Trusted by the best', 104, 847, 300, 32)],
      overlay,
      1440,
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.title, /line up/);
    assert.match(hits[0].finding.detail, /share a left edge/);
  });

  it('does not flag two column headings whose live pitch differs from Figma', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1280,
      texts: [
        { text: 'Marketing strategy', x: 80, y: 500, w: 400, h: 24, fontSize: 16 },
        { text: 'AI transformation', x: 700, y: 500, w: 400, h: 24, fontSize: 16 },
      ],
      surfaces: [],
    };
    const hits = overlayRowAlign(
      [
        run('Marketing strategy', 80, 520, 400, 24, { fontSize: 16 }),
        run('AI transformation', 676, 520, 400, 24, { fontSize: 16 }),
      ],
      overlay,
      1440,
    );
    assert.equal(hits.length, 0);
  });

  it('does not flag a two-column grid whose live pitch is consistent', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1280,
      texts: [
        { text: 'Marketing strategy', x: 80, y: 500, w: 400, h: 24, fontSize: 16 },
        { text: 'AI transformation', x: 700, y: 500, w: 400, h: 24, fontSize: 16 },
        { text: 'Driven by intelligent systems', x: 80, y: 620, w: 400, h: 24, fontSize: 16 },
        { text: 'Business consulting', x: 700, y: 620, w: 400, h: 24, fontSize: 16 },
      ],
      surfaces: [],
    };
    const hits = overlayRowAlign(
      [
        run('Marketing strategy', 80, 520, 400, 24, { fontSize: 16 }),
        run('AI transformation', 676, 520, 400, 24, { fontSize: 16 }),
        run('Driven by intelligent systems', 80, 640, 400, 24, { fontSize: 16 }),
        run('Business consulting', 676, 640, 400, 24, { fontSize: 16 }),
      ],
      overlay,
      1440,
    );
    assert.equal(hits.length, 0);
  });

  it('does not compare two left-edge headings that already line up on the page', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        { text: 'How we help you', x: 80, y: 400, w: 300, h: 32 },
        { text: 'Trusted by the best', x: 80, y: 847, w: 300, h: 32 },
      ],
      surfaces: [],
    };
    const hits = overlayRowAlign(
      [run('How we help you', 80, 400, 300, 32), run('Trusted by the best', 80, 847, 300, 32)],
      overlay,
      1440,
    );
    assert.equal(hits.length, 0);
  });

  it('does not compare header nav labels on the same Figma row', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1280,
      texts: [
        { text: 'Menu', x: 80, y: 24, w: 60, h: 20, fontSize: 16 },
        { text: 'Projects', x: 344, y: 24, w: 80, h: 20, fontSize: 16 },
      ],
      surfaces: [],
    };
    const hits = overlayRowAlign(
      [run('Menu', 80, 24, 60, 20, { fontSize: 16 }), run('Projects', 215, 24, 80, 20, { fontSize: 16 })],
      overlay,
      1440,
    );
    assert.equal(hits.length, 0);
  });

  it('does not flag right-aligned CTAs whose left edges differ by string length', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        { text: 'Learn more', x: 1200, y: 200, w: 90, h: 20, fontSize: 16 },
        { text: 'About us', x: 1218, y: 900, w: 72, h: 20, fontSize: 16 },
      ],
      surfaces: [],
    };
    const hits = overlayRowAlign(
      [
        run('Learn more', 1240, 200, 90, 20, { fontSize: 16 }),
        run('About us', 1258, 900, 72, 20, { fontSize: 16 }),
      ],
      overlay,
      1440,
    );
    assert.equal(hits.length, 0);
  });

  it('does not flag right-aligned job titles whose left edges differ by string length', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1280,
      texts: [
        { text: 'Founder Managing Director', x: 900, y: 400, w: 220, h: 20, fontSize: 16 },
        { text: 'Marketing Co-ordinator', x: 938, y: 480, w: 182, h: 20, fontSize: 16 },
      ],
      surfaces: [],
    };
    const hits = overlayRowAlign(
      [
        run('Founder Managing Director', 980, 420, 220, 20, { fontSize: 16 }),
        run('Marketing Co-ordinator', 1018, 500, 182, 20, { fontSize: 16 }),
      ],
      overlay,
      1440,
    );
    assert.equal(hits.length, 0);
  });

  it('flags a right-aligned CTA whose live right edge drifted', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        { text: 'Learn more', x: 1200, y: 200, w: 90, h: 20, fontSize: 16 },
        { text: 'About us', x: 1218, y: 900, w: 72, h: 20, fontSize: 16 },
      ],
      surfaces: [],
    };
    const hits = overlayRowAlign(
      [
        run('Learn more', 1240, 200, 90, 20, { fontSize: 16 }),
        run('About us', 1234, 900, 72, 20, { fontSize: 16 }),
      ],
      overlay,
      1440,
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.detail, /right edges/);
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
      texts: [{ text: 'Our work stretches across the mix', x: 80, y: 100, w: 400, h: 50, fontSize: 45, fontWeight: 400, lineHeight: 58 }],
      surfaces: [],
    };
    const hits = overlayTypeCompare(
      [run('Our work stretches across the mix', 80, 100, 400, 50, { fontSize: 42, fontWeight: 400, lineHeight: 54 })],
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

  it('compares CSS px to the 1280 design, not a 1440-scaled size', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1280,
      texts: [{ text: 'Our work stretches across the mix', x: 80, y: 100, w: 400, h: 50, fontSize: 45, fontWeight: 400, lineHeight: 58 }],
      surfaces: [],
    };
    const miss = overlayTypeCompare(
      [run('Our work stretches across the mix', 80, 100, 400, 50, { fontSize: 42, fontWeight: 400, lineHeight: 54 })],
      overlay,
      1440,
    );
    assert.equal(miss.length, 1);
    assert.match(miss[0].finding.detail, /42px/);
    assert.match(miss[0].finding.detail, /45px/);
    const match = overlayTypeCompare(
      [run('Our work stretches across the mix', 80, 100, 400, 50, { fontSize: 45, fontWeight: 400, lineHeight: 58 })],
      overlay,
      1440,
    );
    assert.equal(match.length, 0);
  });

  it('pairs a display heading to the page H1 when the copy differs', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        { text: 'Our work stretches across the entire mix.', x: 80, y: 180, w: 900, h: 50, fontSize: 45, fontWeight: 500, lineHeight: 58 },
      ],
      surfaces: [],
    };
    const hits = overlayTypeCompare(
      [run('A totally different headline that wraps', 80, 186, 900, 50, { heading: 'h1', fontSize: 42, fontWeight: 500, lineHeight: 54 })],
      overlay,
      1440,
    );
    assert.equal(hits.length, 1);
    assert.match(hits[0].finding.title, /size/);
    assert.match(hits[0].finding.detail, /42px/);
    assert.match(hits[0].finding.detail, /45px/);
  });

  it('keeps the display heading and Submit when smaller type diffs also exist', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        { text: 'Tiny one', x: 80, y: 80, w: 80, h: 16, fontSize: 14, fontWeight: 400 },
        { text: 'Tiny two', x: 80, y: 100, w: 80, h: 16, fontSize: 14, fontWeight: 400 },
        { text: 'Tiny three', x: 80, y: 120, w: 80, h: 16, fontSize: 14, fontWeight: 400 },
        { text: 'Our work stretches across the mix.', x: 80, y: 200, w: 900, h: 50, fontSize: 45, fontWeight: 500 },
        { text: 'Submit', x: 80, y: 800, w: 120, h: 24, fontSize: 16, fontWeight: 500 },
      ],
      surfaces: [],
    };
    const hits = overlayTypeCompare(
      [
        run('Tiny one', 80, 80, 80, 16, { fontSize: 18, fontWeight: 400 }),
        run('Tiny two', 80, 100, 80, 16, { fontSize: 18, fontWeight: 400 }),
        run('Tiny three', 80, 120, 80, 16, { fontSize: 18, fontWeight: 400 }),
        run('A totally different headline that wraps', 80, 210, 900, 50, { heading: 'h1', fontSize: 42, fontWeight: 500 }),
        run('Submit', 80, 800, 120, 24, { fontSize: 16, fontWeight: 400 }),
      ],
      overlay,
      1440,
    );
    assert.ok(hits.some((h) => /size/.test(h.finding.title) && /42px/.test(h.finding.detail)));
    assert.ok(hits.some((h) => /weight/.test(h.finding.title) && /Submit/.test(h.finding.title)));
  });
});

describe('detectAll', () => {
  it('does not also flag a gap when the same heading already has a line-height finding', () => {
    const overlay: FigmaOverlay = {
      pageWidth: 1440,
      texts: [
        {
          text: 'Where imagination and intelligence work as one.',
          x: 80,
          y: 200,
          w: 600,
          h: 80,
          fontSize: 40,
          fontWeight: 400,
          lineHeight: 52,
        },
        { text: 'About us', x: 80, y: 300, w: 200, h: 24, fontSize: 16 },
      ],
      surfaces: [],
    };
    const hits = detectAll(
      [
        run('Where imagination and intelligence work as one.', 80, 200, 600, 116, {
          heading: 'h1',
          fontSize: 40,
          fontWeight: 400,
          lineHeight: 58,
        }),
        run('About us', 80, 396, 200, 24, { fontSize: 16 }),
      ],
      [],
      [],
      1440,
      900,
      overlay,
    );
    assert.ok(hits.some((h) => /line-height/.test(h.finding.title)));
    assert.equal(
      hits.some((h) => /sit (closer|farther)/.test(h.finding.title)),
      false,
    );
  });
});
