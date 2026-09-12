import type { TextItem, MediaRegion, ReservedRegion } from './browser.js';
import type { Box } from './annotate.js';
import type { AiFinding } from './report.js';
import type { FigmaOverlay, FigmaOverlayBox } from './design.js';

/**
 * Defects the browser's own measurements can prove, with no model in the loop.
 *
 * The point is not to replace the vision pass — it is to have findings whose truth does not depend
 * on a model having a good day. Two boxes either intersect or they do not; an h1 either renders
 * smaller than the h2 below it or it does not. These run with `--ai none`, cost nothing, and are
 * the only findings in the report that can be re-derived from the numbers.
 *
 * Everything here is deliberately conservative. A measured finding that turns out to be wrong is
 * worse than a missed one, because "measured" is what makes the rest of the report believable.
 */

export interface Measured {
  finding: AiFinding;
  /** the real box on the page, so the crop never has to be resolved from quoted text */
  box: Box;
}

/** Per viewport, so one pathological page cannot fill the report with crops. */
const CAP = { overlap: 4, type: 2, gap: 1, aspect: 2, banner: 1 };

const area = (b: { w: number; h: number }) => Math.max(0, b.w) * Math.max(0, b.h);

type Rect = { x: number; y: number; w: number; h: number };

/** The lines a run actually paints on, falling back to its union box for single-line runs. */
const linesOf = (t: TextItem): Rect[] =>
  t.lines?.length ? t.lines.map(([x, y, w, h]) => ({ x, y, w, h })) : [{ x: t.x, y: t.y, w: t.w, h: t.h }];

function intersection(a: Rect, b: Rect): Rect {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The worst real collision between two runs, or null.
 *
 * Compared line against line, never union against union: the union of a wrapped paragraph covers
 * the whitespace at the end of every line, so two runs that merely follow one another in the flow
 * would otherwise read as a heavy overlap.
 */
function worstCollision(a: TextItem, b: TextItem): { inter: Rect; ratio: number } | null {
  let best: { inter: Rect; ratio: number } | null = null;
  for (const la of linesOf(a)) {
    for (const lb of linesOf(b)) {
      const inter = intersection(la, lb);
      if (inter.w < 4 || inter.h < 4) continue;
      const ratio = area(inter) / Math.max(1, Math.min(area(la), area(lb)));
      if (!best || ratio > best.ratio) best = { inter, ratio };
    }
  }
  return best;
}

const union = (a: TextItem, b: TextItem): Box => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
  h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y),
});

/**
 * Text that is actually on screen.
 *
 * Off-canvas drawers (a mobile menu parked at x = -320) are still "visible" to getComputedStyle,
 * and every one of their items overlaps every other — which is how an overlap check with no
 * horizontal bounds turns one hidden menu into twenty findings.
 */
const onScreen = (t: TextItem, viewportWidth: number) => t.x + t.w > 0 && t.x < viewportWidth;

/**
 * Text drawn on top of other text.
 *
 * Thresholds earn their place: a 4px minimum on both axes ignores boxes that merely touch, and
 * requiring 30% of the SMALLER box rules out a long paragraph whose line box happens to graze a
 * neighbour. What is left is the real thing — a heading sitting across a paragraph.
 */
function overlaps(items: TextItem[], viewportWidth: number): Measured[] {
  const text = items
    // `ariaHidden` is the carousel exclusion: slide 2 and slide 3 are painted, stacked on slide 1,
    // and flagged hidden from assistive tech. Geometrically they collide; visually nothing is wrong.
    .filter((t) => t.tag !== 'img' && !t.ariaHidden && t.w >= 8 && t.h >= 8 && onScreen(t, viewportWidth))
    .sort((a, b) => a.y - b.y);

  const out: Measured[] = [];
  const used = new Set<number>();
  for (let i = 0; i < text.length && out.length < CAP.overlap; i++) {
    if (used.has(i)) continue;
    const a = text[i];
    for (let j = i + 1; j < text.length; j++) {
      const b = text[j];
      if (b.y >= a.y + a.h) break; // sorted by y: nothing after this can reach back up into `a`
      if (used.has(j)) continue;
      const hit = worstCollision(a, b);
      if (!hit || hit.ratio < 0.3) continue;
      const { inter, ratio } = hit;

      used.add(i);
      used.add(j);
      out.push({
        finding: {
          title: 'Text covers other text',
          severity: 'major',
          detail:
            `Live: “${a.text.slice(0, 60)}” and “${b.text.slice(0, 60)}” overlap by ${Math.round(ratio * 100)}%.\n` +
            `Design: Text should not cover other text.`,
          anchors: [a.text.slice(0, 60), b.text.slice(0, 60)],
          y: Math.min(a.y, b.y),
          locatedHow: 'measured on DOM: two text boxes intersect',
          measured: true,
        },
        box: union(a, b),
      });
      break;
    }
  }
  return out;
}

/**
 * A heading level that renders smaller than the level below it.
 *
 * Compared per level using the LARGEST instance of each, because a page legitimately has a small
 * h2 in a sidebar next to a big one in the body. If even the biggest h1 is smaller than the
 * biggest h2, the scale is inverted and no amount of context explains it away.
 */
function typeHierarchy(items: TextItem[], viewportWidth: number): Measured[] {
  const biggest = (level: string): TextItem | undefined =>
    items
      .filter((t) => t.heading === level && t.fontSize && t.w >= 8 && t.h >= 8 && onScreen(t, viewportWidth))
      .sort((a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0))[0];

  const out: Measured[] = [];
  for (const [hi, lo] of [
    ['h1', 'h2'],
    ['h2', 'h3'],
  ] as const) {
    if (out.length >= CAP.type) break;
    const big = biggest(hi);
    const small = biggest(lo);
    if (!big || !small) continue;
    const a = big.fontSize!;
    const b = small.fontSize!;
    if (a >= b - 0.5) continue;
    out.push({
      finding: {
        title: `${hi.toUpperCase()} is smaller than ${lo.toUpperCase()}`,
        severity: 'minor',
        detail:
          `Live: largest ${hi.toUpperCase()} is ${a}px (“${big.text.slice(0, 50)}”); largest ${lo.toUpperCase()} is ${b}px (“${small.text.slice(0, 50)}”).\n` +
          `Design: ${hi.toUpperCase()} should be the same size as ${lo.toUpperCase()}, or larger.`,
        anchors: [big.text.slice(0, 60), small.text.slice(0, 60)],
        y: big.y,
        locatedHow: `measured on DOM: font-size ${a}px vs ${b}px`,
        measured: true,
      },
      box: { x: big.x, y: big.y, w: big.w, h: big.h },
    });
  }
  return out;
}

/** Merge overlapping/touching [from,to] spans so the gaps between them are real gaps. */
function mergeSpans(spans: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const sorted = spans.filter((s) => s.to > s.from).sort((a, b) => a.from - b.from);
  const out: Array<{ from: number; to: number }> = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

/**
 * A hole in the first screen — the part every visitor sees before scrolling.
 *
 * Media counts as content, including CSS background images: a hero photo with no text over it is
 * a full screen, not an empty one, and treating it as empty is the obvious way to make this check
 * useless on half the sites in the world.
 */
function firstScreenGap(
  items: TextItem[],
  media: MediaRegion[],
  reserved: ReservedRegion[],
  viewportWidth: number,
  viewportHeight: number,
): Measured[] {
  const limit = viewportHeight * 1.5; // look a little past the fold, so the last gap has an end
  const spans = [
    ...items.filter((t) => onScreen(t, viewportWidth)).map((t) => ({ from: t.y, to: t.y + t.h })),
    ...media.map((m) => ({ from: m.y, to: m.y + m.h })),
    // Space held open by media that has not painted yet — an effect waiting on scroll or a cursor.
    ...reserved.map((m) => ({ from: m.y, to: m.y + m.h })),
  ]
    .filter((s) => s.from < limit && s.to > 0)
    .map((s) => ({ from: Math.max(0, s.from), to: Math.min(limit, s.to) }));

  const merged = mergeSpans(spans);
  if (!merged.length) return [];

  const threshold = Math.max(150, viewportHeight / 3);
  let worst: { from: number; to: number } | null = null;
  const gaps: Array<{ from: number; to: number }> = [];
  if (merged[0].from > 0) gaps.push({ from: 0, to: merged[0].from });
  for (let i = 1; i < merged.length; i++) gaps.push({ from: merged[i - 1].to, to: merged[i].from });
  for (const g of gaps) {
    if (g.from >= viewportHeight) continue; // the gap has to start inside the first screen
    const clipped = { from: g.from, to: Math.min(g.to, viewportHeight) };
    const size = clipped.to - clipped.from;
    if (size < threshold) continue;
    if (!worst || size > worst.to - worst.from) worst = clipped;
  }
  if (!worst) return [];

  const after = items
    .filter((t) => t.y >= worst!.to - 2 && onScreen(t, viewportWidth))
    .sort((a, b) => a.y - b.y)[0];
  const before = items
    .filter((t) => t.y + t.h <= worst!.from + 2 && onScreen(t, viewportWidth))
    .sort((a, b) => b.y - a.y)[0];
  const anchors = [before?.text, after?.text].filter(Boolean).map((t) => t!.slice(0, 60));
  const size = Math.round(worst.to - worst.from);

  return [
    {
      finding: {
        title: 'Empty gap on the first screen',
        severity: 'minor',
        detail:
          `Live: ${size}px empty gap (${Math.round((size / viewportHeight) * 100)}% of the first screen).\n` +
          `Design: The first screen should be filled with content.`,
        anchors: anchors.length ? anchors : undefined,
        y: Math.round(worst.from),
        locatedHow: `measured on DOM: ${size}px empty on the first screen`,
        measured: true,
      },
      box: { x: 0, y: Math.round(worst.from), w: viewportWidth, h: size },
    },
  ];
}

/** Drop BEM `--modifier` classes so `card--wide` still shares a row with `card`. */
function stripBemModifiers(segment: string): string {
  return segment.replace(/\.[A-Za-z0-9_-]+--[A-Za-z0-9_-]+/g, '');
}

/**
 * Selector without the image and its local wrap (picture/figure) — the shared row/carousel.
 * BEM modifiers are stripped first: the card is often two wrappers above the img, so dropping
 * the last two segments alone would leave `card--wide` as its own group.
 */
export function mediaRowKey(selector: string): string {
  const parts = selector.split(/\s*>\s*/).filter(Boolean).map(stripBemModifiers);
  if (parts.length < 3) return '';
  return parts.slice(0, -2).join(' > ');
}

export function displayedAspect(m: { w: number; h: number }): number {
  return m.h > 0 ? m.w / m.h : 0;
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Index of a single ratio that sits away from a tight cluster of the rest.
 * Two loners, or a spread group, is not a finding.
 */
export function loneAspectOutlier(aspects: number[]): number {
  if (aspects.length < 3) return -1;
  let found = -1;
  for (let i = 0; i < aspects.length; i++) {
    const others = aspects.filter((_, j) => j !== i);
    const med = median(others);
    const cluster = Math.max(0.05, med * 0.06);
    if (others.some((a) => Math.abs(a - med) > cluster)) continue;
    const floor = Math.max(0.08, med * 0.1);
    if (Math.abs(aspects[i] - med) < floor) continue;
    if (found !== -1) return -1;
    found = i;
  }
  return found;
}

/** How much of the box sits inside the viewport — clones parked off-canvas do not count. */
function visibleWidth(m: { x: number; w: number }, viewportWidth: number): number {
  return Math.min(m.x + m.w, viewportWidth) - Math.max(m.x, 0);
}

/**
 * One card image whose displayed box is a different ratio than the others in the same row.
 * Compares layout boxes among peers — not natural-vs-rendered stretch (that is `distortion`).
 */
export function peerImageAspect(media: MediaRegion[], viewportWidth: number): Measured[] {
  const imgs = media.filter((m) => m.kind === 'img' && m.w >= 80 && m.h >= 80 && visibleWidth(m, viewportWidth) >= 80);
  const buckets = new Map<string, MediaRegion[]>();
  for (const m of imgs) {
    const key = mediaRowKey(m.selector);
    if (!key) continue;
    const list = buckets.get(key) ?? [];
    list.push(m);
    buckets.set(key, list);
  }

  const out: Measured[] = [];
  for (const group of buckets.values()) {
    if (out.length >= CAP.aspect) break;
    if (group.length < 3) continue;
    const midY = median(group.map((g) => g.y));
    const midH = median(group.map((g) => g.h));
    const row = group.filter(
      (g) => Math.abs(g.y - midY) <= Math.max(48, midH * 0.25) && Math.abs(g.h - midH) <= Math.max(24, midH * 0.25),
    );
    if (row.length < 3) continue;
    const aspects = row.map(displayedAspect);
    const idx = loneAspectOutlier(aspects);
    if (idx < 0) continue;
    const hit = row[idx];
    const med = median(aspects.filter((_, i) => i !== idx));
    const shown = aspects[idx];
    out.push({
      finding: {
        title: 'Card image is a different shape than the rest of the row',
        severity: 'minor',
        detail:
          `Live: this card is ${Math.round(hit.w)}×${Math.round(hit.h)}px.\n` +
          `Design: the other images in the row are a different shape (${row.length} compared).`,
        y: hit.y,
        locatedHow: `measured on DOM: aspect ${shown.toFixed(2)} vs median ${med.toFixed(2)}`,
        measured: true,
      },
      box: { x: hit.x, y: hit.y, w: hit.w, h: hit.h },
    });
  }
  return out;
}

/**
 * A media surface that is wide but not full-bleed.
 *
 * Full-bleed heroes make the page margin look like "banner padding" (Figma 50 vs DOM 120).
 * The case this check is for is an inset banner: image shorter than the page, text sitting on it.
 */
export function isInsetBanner(box: FigmaOverlayBox, pageW: number): boolean {
  if (pageW < 800 || box.w < 400) return false;
  if (box.w < pageW * 0.55 || box.w > pageW * 0.96) return false;
  return box.x >= 8 || pageW - (box.x + box.w) >= 8;
}

export function overlayGutter(text: FigmaOverlayBox, host: FigmaOverlayBox): number {
  return Math.min(text.x - host.x, host.x + host.w - (text.x + text.w));
}

function containsOverlay(host: FigmaOverlayBox, text: FigmaOverlayBox): boolean {
  if (text.x < host.x - 4 || text.x + text.w > host.x + host.w + 4) return false;
  const overlap = Math.min(text.y + text.h, host.y + host.h) - Math.max(text.y, host.y);
  return overlap >= Math.min(text.h, 12) * 0.5;
}

function tightestHost(text: FigmaOverlayBox, surfaces: FigmaOverlayBox[], pageW: number): FigmaOverlayBox | null {
  const hits = surfaces.filter((s) => isInsetBanner(s, pageW) && containsOverlay(s, text));
  if (!hits.length) return null;
  return hits.slice().sort((a, b) => a.w * a.h - b.w * b.h)[0];
}

export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    const lo = Math.min(a.length, b.length);
    const hi = Math.max(a.length, b.length);
    return lo / hi >= 0.7 ? 0.9 : 0;
  }
  return 0;
}

/** Pairs that win clearly — a repeated CTA is not a pair. */
export function uniqueTextPairs(figma: Array<{ text: string }>, dom: Array<{ text: string }>): Array<{ fi: number; di: number }> {
  const fn = figma.map((t) => normText(t.text));
  const dn = dom.map((t) => normText(t.text));
  const used = new Set<number>();
  const pairs: Array<{ fi: number; di: number }> = [];
  for (let i = 0; i < fn.length; i++) {
    let best = -1;
    let bestS = 0;
    let second = 0;
    for (let j = 0; j < dn.length; j++) {
      if (used.has(j)) continue;
      const s = textScore(fn[i], dn[j]);
      if (s > bestS) {
        second = bestS;
        bestS = s;
        best = j;
      } else if (s > second) second = s;
    }
    if (best < 0 || bestS < 0.85 || bestS - second < 0.2) continue;
    used.add(best);
    pairs.push({ fi: i, di: best });
  }
  return pairs;
}

/**
 * Overlay heading on an inset banner whose distance to the image edge differs from Figma.
 *
 * Inset is the heading box against the image box — not CSS padding, and not a text-wrap wrapper.
 * Full-bleed surfaces are skipped. Only desktop-width viewports: Figma pages are desktop artboards.
 */
export function overlayBannerPad(
  items: TextItem[],
  media: MediaRegion[],
  overlay: FigmaOverlay,
  viewportWidth: number,
): Measured[] {
  if (!overlay.pageWidth || viewportWidth < 1200) return [];
  const headings = items.filter((t) => t.heading && /^h[123]$/.test(t.heading) && !t.ariaHidden && t.w >= 8);
  const surfaces = media.filter((m) => m.kind === 'img' || m.kind === 'background');
  const pairs = uniqueTextPairs(overlay.texts, headings);
  const out: Measured[] = [];
  const used = new Set<FigmaOverlayBox>();
  const scale = viewportWidth / overlay.pageWidth;

  for (const { fi, di } of pairs) {
    if (out.length >= CAP.banner) break;
    const ft = overlay.texts[fi];
    const dt = headings[di];
    const fs = tightestHost(ft, overlay.surfaces, overlay.pageWidth);
    const ds = tightestHost(dt, surfaces, viewportWidth);
    if (!fs || !ds || used.has(ds)) continue;
    const raw = overlayGutter(ft, fs);
    const fg = raw * scale;
    const dg = overlayGutter(dt, ds);
    if (fg < 8 || dg < 8) continue;
    if (fg > fs.w * 0.22 || dg > ds.w * 0.22) continue;
    const delta = Math.abs(dg - fg);
    if (delta < Math.max(16, fg * 0.2)) continue;
    used.add(ds);
    const quote = dt.text.slice(0, 60);
    out.push({
      finding: {
        title: `“${quote}” is too far from the banner edge`,
        severity: 'minor',
        detail:
          `Live: ${Math.round(dg)}px from the image edge.\n` +
          `Design: ${Math.round(fg)}px from the image edge.`,
        anchors: [dt.text.slice(0, 60)],
        y: ds.y,
        locatedHow: `measured on DOM: gutter ${Math.round(dg)}px vs Figma ${Math.round(fg)}px`,
        measured: true,
      },
      box: { x: ds.x, y: ds.y, w: ds.w, h: ds.h },
    });
  }
  return out;
}

/** Every measured check for one viewport of one page. */
export function detectAll(
  items: TextItem[],
  media: MediaRegion[],
  reserved: ReservedRegion[],
  viewportWidth: number,
  viewportHeight: number,
  overlay?: FigmaOverlay,
): Measured[] {
  return [
    ...(items.length ? [...overlaps(items, viewportWidth), ...typeHierarchy(items, viewportWidth)] : []),
    ...firstScreenGap(items, media, reserved, viewportWidth, viewportHeight),
    ...peerImageAspect(media, viewportWidth),
    ...(overlay ? overlayBannerPad(items, media, overlay, viewportWidth) : []),
  ];
}
