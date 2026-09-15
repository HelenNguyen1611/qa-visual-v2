import type { TextItem, MediaRegion, ReservedRegion } from './browser.js';
import type { Box } from './annotate.js';
import type { AiFinding } from './report.js';
import type { FigmaOverlay, FigmaOverlayBox, FigmaOverlayText } from './design.js';

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
const CAP = { overlap: 4, type: 2, gap: 1, aspect: 2, banner: 1, missing: 4, distort: 2, overlayGap: 3, overlayAlign: 3, overlayType: 3, overlayBase: 2 };

/** Neighbour-gap after ink trim. A leftover of ~16px is still line-box noise. */
const NEIGHBOR_GAP_MIN = 16;
const ALIGN_DELTA = 16;
const BASE_DELTA = 20;
const SIZE_DELTA = 2.5;
const WEIGHT_DELTA = 100;
const LH_RATIO_DELTA = 0.12;

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
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MONTH =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/;

/**
 * Form labels, filter chips, dates, and contact meta — not “a control the design drew and the
 * site hid”. Unique-text missing is for CTAs and named chrome, not CMS chrome.
 */
export function isNonContentChrome(raw: string): boolean {
  const n = normText(raw);
  if (!n) return true;
  const words = n.split(' ').filter(Boolean);
  if (/@/.test(raw) || /(?:\+|00)\d[\d\s.-]{6,}/.test(raw)) return true;
  if (/\b(20\d{2}|19\d{2})\b/.test(n) && (MONTH.test(n) || (/\b\d{1,2}\b/.test(n) && words.length <= 5))) return true;
  if (/\brequired field\b/.test(n)) return true;
  if (/\b(email|phone|password|username|postcode|zip|message)\b/.test(n) && words.length <= 4) return true;
  if (/\b(full|first|last|company|street)\s+(name|address)\b/.test(n)) return true;
  if (words.length === 1 && n.length <= 16) {
    return !/^(see|all|more|next|submit|discover|contact|join|apply|shop|buy|book|search|login|subscribe)$/.test(n);
  }
  return false;
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

/** Pairs that win clearly — a repeated CTA is not a pair. Same label, different sizes (nav vs H1) match by fontSize then Y; 1-vs-many same size stays skipped. */
export function uniqueTextPairs(
  figma: Array<{ text: string; y?: number; fontSize?: number }>,
  dom: Array<{ text: string; y?: number; fontSize?: number }>,
): Array<{ fi: number; di: number }> {
  const fn = figma.map((t) => normText(t.text));
  const dn = dom.map((t) => normText(t.text));
  const usedF = new Set<number>();
  const usedD = new Set<number>();
  const pairs: Array<{ fi: number; di: number }> = [];
  const yOf = (row: { y?: number } | undefined) => row?.y ?? 0;
  const sizeOf = (row: { fontSize?: number } | undefined) => row?.fontSize ?? 0;

  const groups = new Map<string, { f: number[]; d: number[] }>();
  for (let i = 0; i < fn.length; i++) {
    if (fn[i].length < 3) continue;
    const g = groups.get(fn[i]) ?? { f: [], d: [] };
    g.f.push(i);
    groups.set(fn[i], g);
  }
  for (let j = 0; j < dn.length; j++) {
    const g = groups.get(dn[j]);
    if (g) g.d.push(j);
  }

  for (const g of groups.values()) {
    if (!g.f.length || !g.d.length) continue;
    const unusedD = new Set(g.d);
    const fs = g.f.slice().sort((a, b) => sizeOf(figma[b]) - sizeOf(figma[a]) || yOf(figma[a]) - yOf(figma[b]));
    for (const fi of fs) {
      const want = sizeOf(figma[fi]);
      const cands = [...unusedD];
      if (!cands.length) break;
      cands.sort((a, b) => {
        const da = Math.abs(sizeOf(dom[a]) - want);
        const db = Math.abs(sizeOf(dom[b]) - want);
        if (da !== db) return da - db;
        return yOf(dom[a]) - yOf(dom[b]);
      });
      const best = cands[0];
      const second = cands[1];
      const bestDiff = Math.abs(sizeOf(dom[best]) - want);
      const secondDiff = second != null ? Math.abs(sizeOf(dom[second]) - want) : Infinity;
      if (g.f.length === 1 && second != null && bestDiff <= 8 && secondDiff <= 8 && Math.abs(bestDiff - secondDiff) < 4) continue;
      if (want >= 20 && sizeOf(dom[best]) >= 20 && bestDiff > 8) continue;
      unusedD.delete(best);
      usedF.add(fi);
      usedD.add(best);
      pairs.push({ fi, di: best });
    }
  }

  for (let i = 0; i < fn.length; i++) {
    if (usedF.has(i)) continue;
    let best = -1;
    let bestS = 0;
    let second = 0;
    for (let j = 0; j < dn.length; j++) {
      if (usedD.has(j)) continue;
      const s = textScore(fn[i], dn[j]);
      if (s > bestS) {
        second = bestS;
        bestS = s;
        best = j;
      } else if (s > second) second = s;
    }
    if (best < 0 || bestS < 0.85 || bestS - second < 0.2) continue;
    usedF.add(i);
    usedD.add(best);
    pairs.push({ fi: i, di: best });
  }
  return pairs;
}

const overlayScale = (overlay: FigmaOverlay, viewportWidth: number) =>
  overlay.pageWidth > 0 ? viewportWidth / overlay.pageWidth : 1;

function visibleCopy(items: TextItem[], viewportWidth: number): TextItem[] {
  return items.filter((t) => t.tag !== 'img' && !t.ariaHidden && t.w >= 8 && t.h >= 4 && onScreen(t, viewportWidth));
}

function overlapX(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
}

function overlapY(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

function sharesBand(text: Rect, surface: Rect): boolean {
  return overlapX(text, surface) >= 8 || overlapY(text, surface) >= Math.min(text.h, 12) * 0.5;
}

function sameColumn(a: Rect, b: Rect): boolean {
  const o = overlapX(a, b);
  return o >= Math.min(a.w, b.w) * 0.35;
}

type StackKey = Rect & { parentId?: string; instanceId?: string; host?: string };

/**
 * Same visual stack — a title and its lead, not a description in card 02 and a title in card 07.
 *
 * Tree wins when we have it. Without it, left edges have to nearly match: a 35% X-overlap is how
 * a two-up service list leaked across columns.
 */
export function sameNeighborStack(a: StackKey, b: StackKey): boolean {
  if (a.parentId && b.parentId) return a.parentId === b.parentId && sameColumn(a, b);
  if (a.instanceId && b.instanceId) return a.instanceId === b.instanceId && sameColumn(a, b);
  if (a.host && b.host) return a.host === b.host && sameColumn(a, b);
  return sameColumn(a, b) && Math.abs(a.x - b.x) <= 48 && overlapX(a, b) >= Math.min(a.w, b.w) * 0.5;
}

/**
 * Half-leading on one side of a line box, or 0 when the box is already tight (Figma TEXT).
 *
 * CSS `line-height` inflates the DOM rect; Figma `absoluteBoundingBox` usually does not. Subtracting
 * the same pad from both sides would invent a gap that neither designer drew.
 */
export function halfLeading(t: { h: number; fontSize?: number; lineHeight?: number; lines?: unknown[] }): number {
  const fs = t.fontSize;
  const lh = t.lineHeight;
  if (!fs || !lh || lh <= fs + 1) return 0;
  const n = t.lines?.length || Math.max(1, Math.round(t.h / lh));
  const loose = lh * n;
  if (t.h < loose * 0.85) return 0;
  return (lh - fs) / 2;
}

/** Gap between the ink of `a` (above) and the ink of `b` (below). */
export function inkGap(
  a: { y: number; h: number; fontSize?: number; lineHeight?: number; lines?: unknown[] },
  b: { y: number; h: number; fontSize?: number; lineHeight?: number; lines?: unknown[] },
): number {
  return b.y + halfLeading(b) - (a.y + a.h - halfLeading(a));
}

/** True when the remaining delta is still box-model noise, not a layout break. */
export function skipNeighborGap(gapD: number, gapF: number): boolean {
  const delta = Math.abs(gapD - gapF);
  if (delta < NEIGHBOR_GAP_MIN) return true;
  const lo = Math.min(gapD, gapF);
  const hi = Math.max(gapD, gapF);
  if (lo >= 12 && hi <= 72 && delta <= 28) return true;
  return false;
}

/**
 * Strings that live inside a fat INSTANCE (a reused block, not a one-label button).
 *
 * The Projects frame drawing the homepage service list is the case: those titles are not missing
 * from /projects — they were never this page’s copy.
 */
export function reusedInstanceTexts(overlay: { texts: Array<{ text: string; instanceId?: string }> }): Set<string> {
  const byInst = new Map<string, Set<string>>();
  for (const t of overlay.texts) {
    if (!t.instanceId) continue;
    const n = normText(t.text);
    if (!n) continue;
    const set = byInst.get(t.instanceId) ?? new Set();
    set.add(n);
    byInst.set(t.instanceId, set);
  }
  const skip = new Set<string>();
  for (const set of byInst.values()) {
    if (set.size >= 3) for (const n of set) skip.add(n);
  }
  return skip;
}

function scaledBox(f: FigmaOverlayBox, scale: number): Box {
  return { x: Math.round(f.x * scale), y: Math.round(f.y * scale), w: Math.round(f.w * scale), h: Math.round(f.h * scale) };
}

type OverlayPair = { f: FigmaOverlayText; d: TextItem };

function mergeWrappedHeading(vis: TextItem[], start: TextItem): TextItem {
  const band = vis
    .filter(
      (t) =>
        t.heading === start.heading &&
        t.fontSize === start.fontSize &&
        t.y >= start.y - 2 &&
        t.y <= start.y + Math.max(80, start.h * 2) &&
        Math.abs(t.x - start.x) < 48,
    )
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (band.length <= 1) return start;
  const x0 = Math.min(...band.map((t) => t.x));
  const y0 = Math.min(...band.map((t) => t.y));
  const x1 = Math.max(...band.map((t) => t.x + t.w));
  const y1 = Math.max(...band.map((t) => t.y + t.h));
  return { ...start, text: band.map((t) => t.text).join(' '), x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function headingRolePair(overlay: FigmaOverlay, vis: TextItem[], taken: OverlayPair[]): OverlayPair | undefined {
  const f = overlay.texts
    .filter((t) => (t.fontSize ?? 0) >= 32 && t.y >= 80)
    .sort((a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0) || a.y - b.y)[0];
  const h1 = vis
    .filter((t) => t.heading === 'h1' && (t.fontSize ?? 0) >= 28 && !t.ariaHidden)
    .sort((a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0) || a.y - b.y)[0];
  if (!f || !h1) return undefined;
  if (taken.some((p) => p.f === f || p.d === h1)) return undefined;
  return { f, d: mergeWrappedHeading(vis, h1) };
}

function twoColRows<T extends Rect>(cands: T[]): T[][] {
  const rows: T[][] = [];
  const seen = new Set<T>();
  for (const a of cands) {
    if (seen.has(a)) continue;
    const row = cands.filter((b) => sameFigmaRow(a, b)).sort((x, y) => x.x - y.x);
    if (row.length !== 2) continue;
    if (Math.abs(row[1].x - row[0].x) < 180) continue;
    row.forEach((t) => seen.add(t));
    rows.push(row);
  }
  return rows.sort((a, b) => a[0].y - b[0].y);
}

function sameRowStructuralPairs(overlay: FigmaOverlay, vis: TextItem[], taken: OverlayPair[]): OverlayPair[] {
  const usedF = new Set(taken.map((p) => p.f));
  const usedD = new Set(taken.map((p) => p.d));
  const candF = overlay.texts.filter(
    (t) =>
      !usedF.has(t) &&
      t.y >= 200 &&
      (t.fontSize ?? 0) >= 14 &&
      (t.fontSize ?? 0) <= 28 &&
      !isNonContentChrome(t.text) &&
      t.w >= 40,
  );
  const candD = vis.filter((t) => !usedD.has(t) && !t.ariaHidden && t.w >= 40 && !isNonContentChrome(t.text));
  const out: OverlayPair[] = [];
  const fRows = twoColRows(candF);
  const buckets = new Map<number, typeof fRows>();
  for (const row of fRows) {
    const size = Math.round(row[0].fontSize ?? 16);
    const list = buckets.get(size) ?? [];
    list.push(row);
    buckets.set(size, list);
  }
  for (const [size, rows] of buckets) {
    const dRows = twoColRows(
      candD.filter((t) => t.fontSize == null || Math.abs((t.fontSize ?? 0) - size) <= 6),
    ).filter((dr) => !usedD.has(dr[0]) && !usedD.has(dr[1]));
    if (rows.length !== dRows.length || !rows.length) continue;
    for (let i = 0; i < rows.length; i++) {
      out.push({ f: rows[i][0], d: dRows[i][0] }, { f: rows[i][1], d: dRows[i][1] });
      usedD.add(dRows[i][0]);
      usedD.add(dRows[i][1]);
    }
  }
  return out;
}

function overlayPairs(items: TextItem[], overlay: FigmaOverlay, viewportWidth: number): OverlayPair[] {
  const vis = visibleCopy(items, viewportWidth);
  const unique = uniqueTextPairs(overlay.texts, vis).map(({ fi, di }) => ({ f: overlay.texts[fi], d: vis[di] }));
  const role = headingRolePair(overlay, vis, unique);
  const taken = role ? [...unique, role] : unique;
  const row = sameRowStructuralPairs(overlay, vis, taken);
  const first = [...(role ? [role] : []), ...row];
  const rest = unique.filter((p) => !first.some((q) => q.f === p.f || q.d === p.d));
  return [...first, ...rest];
}

function bestDomScore(needle: string, items: TextItem[]): number {
  let best = 0;
  for (const t of items) {
    const s = textScore(needle, normText(t.text));
    if (s > best) best = s;
  }
  return best;
}

/**
 * Same card, different CMS sentence.
 *
 * “Content to match cultural trends” vs “Designed at pace to match cultural trends”.
 * “AI business consulting & transformation” vs live split “AI transformation” + “Business consulting”.
 * Short CTAs (“See all”) stay out: they have fewer than 3 content words.
 */
export function rewrittenFigmaCopy(figmaNorm: string, hay: string): boolean {
  const words = figmaNorm.split(' ').filter((w) => w.length >= 4);
  if (words.length < 3) return false;
  const hit = words.filter((w) => hay.includes(w)).length;
  return hit / words.length >= 0.6;
}

/**
 * A short unique string in the Figma frame with no counterpart on the page.
 *
 * Body copy is allowed to differ (placeholder vs CMS). This is for chrome the design names once:
 * “See all”, a section CTA, a heading that display:none removed.
 */
export function missingUniqueFigmaText(
  items: TextItem[],
  overlay: FigmaOverlay,
  viewportWidth: number,
  siteItems: TextItem[] = [],
  siteHay = '',
): Measured[] {
  if (!overlay.pageWidth || viewportWidth < 1200) return [];
  const copy = visibleCopy(items, viewportWidth);
  // Other pages in the same run count: Figma inner frames reuse homepage teasers
  // (“How we help you” lives on Home, but the Services file still draws the instance).
  const present = siteItems.length ? [...copy, ...siteItems] : copy;
  const hay = normText(
    present.map((t) => t.text).join(' ') + ' ' + siteHay,
  );
  const reused = reusedInstanceTexts(overlay);
  const norms = overlay.texts.map((t) => normText(t.text));
  const scale = overlayScale(overlay, viewportWidth);
  const out: Measured[] = [];

  for (let i = 0; i < overlay.texts.length && out.length < CAP.missing; i++) {
    const n = norms[i];
    const f = overlay.texts[i];
    if (n.length < 6 || n.length > 48) continue;
    if (n.split(' ').filter(Boolean).length > 8) continue;
    if (isNonContentChrome(f.text)) continue;
    if (reused.has(n)) continue;
    if (norms.some((other, j) => j !== i && textScore(n, other) >= 0.85)) continue;
    if (bestDomScore(n, present) >= 0.85) continue;
    if (n.length >= 12 && hay.includes(n)) continue;
    if (rewrittenFigmaCopy(n, hay)) continue;
    const quote = f.text.replace(/\s+/g, ' ').trim().slice(0, 60);
    out.push({
      finding: {
        title: `“${quote}” is missing`,
        severity: 'minor',
        detail: `Live: “${quote}” is not on the page.\nDesign: “${quote}” is in the frame.`,
        anchors: [quote],
        y: Math.round(f.y * scale),
        locatedHow: 'measured on DOM: unique Figma text has no matching run',
        measured: true,
      },
      box: scaledBox(f, scale),
    });
  }
  return out;
}

/** An img whose displayed box does not match its file’s aspect — object-fit:fill, a squashed still. */
export function stretchedImages(media: MediaRegion[]): Measured[] {
  const hits = media
    .filter((m) => m.kind === 'img' && (m.distortion ?? 0) > 0.15 && m.w >= 80 && m.h >= 80)
    .sort((a, b) => (b.distortion ?? 0) - (a.distortion ?? 0));
  const out: Measured[] = [];
  for (const m of hits.slice(0, CAP.distort)) {
    const pct = Math.round((m.distortion ?? 0) * 100);
    out.push({
      finding: {
        title: 'Image is stretched',
        severity: 'minor',
        detail:
          `Live: this image’s box is stretched (${pct}% off its file).\n` +
          `Design: images keep the proportions of the file.`,
        y: m.y,
        locatedHow: `measured on DOM: aspect distortion ${pct}%`,
        measured: true,
      },
      box: { x: m.x, y: m.y, w: m.w, h: m.h },
    });
  }
  return out;
}

function sameFigmaRow(a: Rect, b: Rect): boolean {
  if (Math.abs(a.y - b.y) <= 16) return true;
  const minH = Math.min(a.h, b.h);
  return minH >= 8 && overlapY(a, b) / minH >= 0.5;
}

const rightEdge = (r: Rect) => r.x + r.w;

type AlignAxis = 'left' | 'right';

/**
 * Which edge a designer lined up — left-aligned headings vs right-aligned CTAs / roles.
 *
 * TEXT boxes hug the glyphs, so two right-rail labels of different length share a right edge and
 * naturally differ on the left. Calling that "same column" and then comparing live left edges is
 * how “Learn more” vs “About us” and job titles became findings.
 */
function sharedAlignAxis(a: Rect, b: Rect): AlignAxis | undefined {
  const dL = Math.abs(a.x - b.x);
  const dR = Math.abs(rightEdge(a) - rightEdge(b));
  const tight = Math.min(dL, dR);
  if (tight > ALIGN_DELTA) return undefined;
  return dR < dL ? 'right' : 'left';
}

/**
 * Two unique strings stacked in the same Figma column whose gap grew or shrank vs the live pair.
 *
 * Neighbours are taken from the Figma tree (same column, 4–72px gap), then mapped to DOM.
 * CSS spacing is compared in px — not multiplied by the 1280→1440 screenshot scale.
 */
export function overlayNeighborGap(items: TextItem[], overlay: FigmaOverlay, viewportWidth: number): Measured[] {
  if (!overlay.pageWidth || viewportWidth < 1200) return [];
  const vis = visibleCopy(items, viewportWidth);
  const pairs = overlayPairs(items, overlay, viewportWidth);
  const byF = new Map<FigmaOverlayText, OverlayPair>();
  for (const p of pairs) byF.set(p.f, p);
  const usedDom = new Set(pairs.map((p) => p.d));
  const out: Measured[] = [];
  const used = new Set<string>();
  const order = overlay.texts
    .map((_, i) => i)
    .sort((i, j) => (overlay.texts[j].fontSize ?? 0) - (overlay.texts[i].fontSize ?? 0) || i - j);
  for (const i of order) {
    if (out.length >= CAP.overlayGap) break;
    const aF = overlay.texts[i];
    let bestJ = -1;
    let bestGap = Infinity;
    for (let j = 0; j < overlay.texts.length; j++) {
      if (i === j) continue;
      if (!sameNeighborStack(aF, overlay.texts[j])) continue;
      const gapF = inkGap(aF, overlay.texts[j]);
      if (gapF < 4 || gapF > 72) continue;
      if (gapF < bestGap) {
        bestGap = gapF;
        bestJ = j;
      }
    }
    if (bestJ < 0) continue;
    const key = i < bestJ ? `${i}:${bestJ}` : `${bestJ}:${i}`;
    if (used.has(key)) continue;
    used.add(key);
    const a = byF.get(aF);
    if (!a) continue;
    const bF = overlay.texts[bestJ];
    if (isNonContentChrome(aF.text) || isNonContentChrome(bF.text)) continue;
    let b = byF.get(bF);
    if (!b) {
      const want = bF.fontSize ?? 0;
      const geo = vis
        .filter(
          (t) =>
            !usedDom.has(t) &&
            t.y >= a.d.y + a.d.h - 2 &&
            t.y <= a.d.y + a.d.h + bestGap + 48 &&
            sameNeighborStack(a.d, t) &&
            (want < 8 || t.fontSize == null || Math.abs((t.fontSize ?? 0) - want) <= 8),
        )
        .sort((x, y) => x.y - y.y)[0];
      if (geo) {
        b = { f: bF, d: geo };
        usedDom.add(geo);
      }
    }
    if (!b) continue;
    if (isNonContentChrome(a.d.text) || isNonContentChrome(b.d.text)) continue;
    const aDom = a.d.heading ? mergeWrappedHeading(vis, a.d) : a.d;
    const bDom = b.d.heading ? mergeWrappedHeading(vis, b.d) : b.d;
    const aLines = linesOf(aDom);
    const bLines = linesOf(bDom);
    const aLast = aLines[aLines.length - 1];
    const gapD = inkGap(
      { ...aLast, fontSize: aDom.fontSize, lineHeight: aDom.lineHeight },
      { ...bLines[0], fontSize: bDom.fontSize, lineHeight: bDom.lineHeight },
    );
    if (gapD < 0) continue;
    if (gapD > 96 || gapD > bestGap + 48) continue;
    if (skipNeighborGap(gapD, bestGap)) continue;
    const qa = a.d.text.slice(0, 40);
    const qb = b.d.text.slice(0, 40);
    out.push({
      finding: {
        title:
          gapD > bestGap
            ? `“${qa}” and “${qb}” sit farther apart than in the design`
            : `“${qa}” and “${qb}” sit closer than in the design`,
        severity: 'minor',
        detail: `Live: ${Math.round(gapD)}px between them.\nDesign: ${Math.round(bestGap)}px between them.`,
        anchors: [a.d.text.slice(0, 60), b.d.text.slice(0, 60)],
        y: a.d.y,
        locatedHow: `measured on DOM: gap ${Math.round(gapD)}px vs Figma ${Math.round(bestGap)}px`,
        measured: true,
      },
      box: union(a.d, b.d),
    });
  }
  return out;
}

/**
 * Two unique strings stacked in the same Figma column whose live shared edge drifted.
 *
 * A two-column row (pitch 620px in a 1280 frame vs 596px on a 1440 shot) is not a misalignment —
 * every row sharing that pitch is a grid. This check never compares that pitch to Figma. It only
 * asks whether items that share a Figma edge still share that same edge on the page.
 */
export function overlayRowAlign(items: TextItem[], overlay: FigmaOverlay, viewportWidth: number): Measured[] {
  if (!overlay.pageWidth || viewportWidth < 1200) return [];
  const pairs = overlayPairs(items, overlay, viewportWidth);
  const out: Measured[] = [];
  for (let i = 0; i < pairs.length && out.length < CAP.overlayAlign; i++) {
    for (let j = i + 1; j < pairs.length && out.length < CAP.overlayAlign; j++) {
      const a = pairs[i];
      const b = pairs[j];
      if (sameFigmaRow(a.f, b.f)) continue;
      const axis = sharedAlignAxis(a.f, b.f);
      if (!axis) continue;
      if (Math.min(a.f.y, b.f.y) < 120) continue;
      if (isNonContentChrome(a.f.text) || isNonContentChrome(b.f.text)) continue;
      if (isNonContentChrome(a.d.text) || isNonContentChrome(b.d.text)) continue;
      const dxD =
        axis === 'right'
          ? Math.abs(rightEdge(b.d) - rightEdge(a.d))
          : Math.abs(b.d.x - a.d.x);
      if (dxD < ALIGN_DELTA || dxD > 80) continue;
      const qa = a.d.text.slice(0, 40);
      const qb = b.d.text.slice(0, 40);
      const edge = axis === 'right' ? 'right' : 'left';
      out.push({
        finding: {
          title: `“${qa}” and “${qb}” do not line up`,
          severity: 'minor',
          detail: `Live: their ${edge} edges are ${Math.round(dxD)}px apart.\nDesign: they share a ${edge} edge.`,
          anchors: [a.d.text.slice(0, 60), b.d.text.slice(0, 60)],
          y: Math.min(a.d.y, b.d.y),
          locatedHow: `measured on DOM: same-column ${edge} ${Math.round(dxD)}px apart vs Figma`,
          measured: true,
        },
        box: union(a.d, b.d),
      });
    }
  }
  return out;
}

/**
 * Copy that shares a bottom edge with a photo in Figma, but not on the page
 * (flex-start + a pushed image).
 */
export function overlayTextImageBaseline(
  items: TextItem[],
  media: MediaRegion[],
  overlay: FigmaOverlay,
  viewportWidth: number,
): Measured[] {
  if (!overlay.pageWidth || viewportWidth < 1200) return [];
  const scale = overlayScale(overlay, viewportWidth);
  const pairs = overlayPairs(items, overlay, viewportWidth);
  const liveSurfaces = media.filter((m) => (m.kind === 'img' || m.kind === 'background') && m.w >= 200 && m.h >= 120);
  const out: Measured[] = [];

  for (const p of pairs) {
    if (out.length >= CAP.overlayBase) break;
    const fb = p.f.y + p.f.h;
    const host = overlay.surfaces
      .filter((s) => sharesBand(p.f, s) && Math.abs(s.y + s.h - fb) <= 8 && p.f.y >= s.y + s.h * 0.4)
      .sort((a, b) => a.w * a.h - b.w * b.h)[0];
    if (!host) continue;
    const wantW = host.w * scale;
    const wantH = host.h * scale;
    const live = liveSurfaces
      .filter((s) => sharesBand(p.d, s) && Math.abs(s.y + s.h / 2 - (p.d.y + p.d.h / 2)) <= wantH * 1.1)
      .sort((a, b) => Math.abs(a.w - wantW) + Math.abs(a.h - wantH) - (Math.abs(b.w - wantW) + Math.abs(b.h - wantH)))[0];
    if (!live) continue;
    const delta = Math.abs(p.d.y + p.d.h - (live.y + live.h));
    if (delta < BASE_DELTA) continue;
    const quote = p.d.text.slice(0, 60);
    out.push({
      finding: {
        title: `“${quote}” does not share a bottom edge with the photo`,
        severity: 'minor',
        detail: `Live: copy and photo bottoms are ${Math.round(delta)}px apart.\nDesign: they share a bottom edge.`,
        anchors: [quote],
        y: Math.min(p.d.y, live.y),
        locatedHow: `measured on DOM: bottom delta ${Math.round(delta)}px vs aligned in Figma`,
        measured: true,
      },
      box: {
        x: Math.min(p.d.x, live.x),
        y: Math.min(p.d.y, live.y),
        w: Math.max(p.d.x + p.d.w, live.x + live.w) - Math.min(p.d.x, live.x),
        h: Math.max(p.d.y + p.d.h, live.y + live.h) - Math.min(p.d.y, live.y),
      },
    });
  }
  return out;
}

/** Unique paired strings whose size, weight, or line-height drifted from the Figma style. */
function overlayTypeRank(p: OverlayPair): number {
  if ((p.f.fontSize ?? 0) >= 32) return 0;
  if (/^(submit|see all|discover|learn more)$/i.test(normText(p.d.text))) return 1;
  return 2;
}

export function overlayTypeCompare(items: TextItem[], overlay: FigmaOverlay, viewportWidth: number): Measured[] {
  if (!overlay.pageWidth || viewportWidth < 1200) return [];
  const out: Measured[] = [];
  const ranked = overlayPairs(items, overlay, viewportWidth)
    .slice()
    .sort((a, b) => overlayTypeRank(a) - overlayTypeRank(b) || (b.f.fontSize ?? 0) - (a.f.fontSize ?? 0));
  for (const p of ranked) {
    if (out.length >= CAP.overlayType) break;
    if (isNonContentChrome(p.f.text) || isNonContentChrome(p.d.text)) continue;
    const cta = /^(submit|see all|discover|learn more)$/i.test(normText(p.d.text));
    if ((p.f.fontSize ?? 0) < 32 && !cta) continue;
    const wantSize = p.f.fontSize;
    const gotSize = p.d.fontSize;
    const wantW = p.f.fontWeight;
    const gotW = p.d.fontWeight;
    const wantRatio = p.f.fontSize && p.f.lineHeight ? p.f.lineHeight / p.f.fontSize : undefined;
    const gotRatio = p.d.fontSize && p.d.lineHeight ? p.d.lineHeight / p.d.fontSize : undefined;
    const quote = p.d.text.slice(0, 60);

    // CSS px vs Figma px. The 1280 artboard is the size spec — a 1440 screenshot must not
    // grow or shrink the type. Do not scale the threshold by viewport / artboard.
    if (wantSize != null && gotSize != null && Math.abs(gotSize - wantSize) >= SIZE_DELTA) {
      out.push({
        finding: {
          title: `“${quote}” is a different size than the design`,
          severity: 'minor',
          detail: `Live: ${Math.round(gotSize)}px.\nDesign: ${Math.round(wantSize)}px.`,
          anchors: [quote],
          y: p.d.y,
          locatedHow: `measured on DOM: font-size ${gotSize}px vs Figma ${wantSize.toFixed(1)}px`,
          measured: true,
        },
        box: { x: p.d.x, y: p.d.y, w: p.d.w, h: p.d.h },
      });
      continue;
    }
    if (wantW != null && gotW != null && Math.abs(gotW - wantW) >= WEIGHT_DELTA) {
      out.push({
        finding: {
          title: `“${quote}” is a different weight than the design`,
          severity: 'minor',
          detail: `Live: weight ${gotW}.\nDesign: weight ${wantW}.`,
          anchors: [quote],
          y: p.d.y,
          locatedHow: `measured on DOM: font-weight ${gotW} vs Figma ${wantW}`,
          measured: true,
        },
        box: { x: p.d.x, y: p.d.y, w: p.d.w, h: p.d.h },
      });
      continue;
    }
    if (wantRatio != null && gotRatio != null && Math.abs(gotRatio - wantRatio) >= LH_RATIO_DELTA) {
      out.push({
        finding: {
          title:
            gotRatio > wantRatio
              ? `“${quote}” has looser line-height than the design`
              : `“${quote}” has tighter line-height than the design`,
          severity: 'minor',
          detail: `Live: line-height ${gotRatio.toFixed(2)}.\nDesign: line-height ${wantRatio.toFixed(2)}.`,
          anchors: [quote],
          y: p.d.y,
          locatedHow: `measured on DOM: line-height ratio ${gotRatio.toFixed(2)} vs Figma ${wantRatio.toFixed(2)}`,
          measured: true,
        },
        box: { x: p.d.x, y: p.d.y, w: p.d.w, h: p.d.h },
      });
    }
  }
  return out;
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

export interface OverlayNeedleTrace {
  needle: string;
  figmaFound: boolean;
  figmaText?: string;
  figmaFontSize?: number;
  figmaFontWeight?: number;
  figmaLineHeight?: number;
  figmaLineRatio?: number;
  figmaY?: number;
  figmaH?: number;
  figmaX?: number;
  domFound: boolean;
  domText?: string;
  domFontSize?: number;
  domFontWeight?: number;
  domLineHeight?: number;
  domLineRatio?: number;
  domY?: number;
  domH?: number;
  domX?: number;
  pairScore: number;
  paired: boolean;
  skip: string;
  sizeDelta?: number;
  lhRatioDelta?: number;
  gapToNextFigma?: number;
  gapToNextDom?: number;
}

/** Why a Figma string did or did not become a measured finding — for pairing debug, not the report. */
export function traceOverlayNeedle(
  overlay: FigmaOverlay,
  items: TextItem[],
  viewportWidth: number,
  needle: string,
): OverlayNeedleTrace {
  const n = normText(needle);
  const vis = visibleCopy(items, viewportWidth);
  let fi = -1;
  let fScore = 0;
  let fRank = -1;
  for (let i = 0; i < overlay.texts.length; i++) {
    const s = textScore(n, normText(overlay.texts[i].text));
    const rank = overlay.texts[i].fontSize ?? overlay.texts[i].h;
    if (s > fScore + 0.01 || (s >= 0.5 && Math.abs(s - fScore) <= 0.01 && rank > fRank)) {
      fScore = s;
      fi = i;
      fRank = rank;
    }
  }
  const f = fi >= 0 && fScore >= 0.5 ? overlay.texts[fi] : undefined;
  let di = -1;
  let dScore = 0;
  let dRank = -1;
  for (let i = 0; i < vis.length; i++) {
    const s = textScore(n, normText(vis[i].text));
    const rank = vis[i].fontSize ?? vis[i].h;
    if (s > dScore + 0.01 || (s >= 0.5 && Math.abs(s - dScore) <= 0.01 && rank > dRank)) {
      dScore = s;
      di = i;
      dRank = rank;
    }
  }
  const d = di >= 0 && dScore >= 0.5 ? vis[di] : undefined;
  const paired = f
    ? uniqueTextPairs(overlay.texts, vis).some((p) => p.fi === fi && vis[p.di] === d)
    : false;
  const pairScore = f && d ? textScore(normText(f.text), normText(d.text)) : Math.max(fScore, dScore);
  const fRatio = f?.fontSize && f.lineHeight ? f.lineHeight / f.fontSize : undefined;
  const dRatio = d?.fontSize && d.lineHeight ? d.lineHeight / d.fontSize : undefined;
  let skip = 'ok';
  if (!f) skip = 'no Figma node (score < 0.5)';
  else if (!d) skip = 'no DOM run (score < 0.5)';
  else if (!paired) skip = `not a uniqueTextPair (score ${pairScore.toFixed(2)}; need 0.85 and unique)`;
  else if (f.fontSize == null && f.lineHeight == null) skip = 'paired; Figma style missing (no fontSize/lineHeight on overlay)';
  else skip = 'paired';

  let gapToNextFigma: number | undefined;
  let gapToNextDom: number | undefined;
  if (f) {
    let bestJ = -1;
    let bestGap = Infinity;
    for (let j = 0; j < overlay.texts.length; j++) {
      if (j === fi) continue;
      if (!sameColumn(f, overlay.texts[j])) continue;
      const gapF = overlay.texts[j].y - (f.y + f.h);
      if (gapF < 4 || gapF > 72) continue;
      if (gapF < bestGap) {
        bestGap = gapF;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      gapToNextFigma = bestGap;
      const nextPair = uniqueTextPairs(overlay.texts, vis).find((p) => p.fi === bestJ);
      if (d && nextPair) {
        const nd = vis[nextPair.di];
        gapToNextDom = nd.y - (d.y + d.h);
      }
    }
  }

  return {
    needle,
    figmaFound: Boolean(f),
    figmaText: f?.text,
    figmaFontSize: f?.fontSize,
    figmaFontWeight: f?.fontWeight,
    figmaLineHeight: f?.lineHeight,
    figmaLineRatio: fRatio,
    figmaY: f?.y,
    figmaH: f?.h,
    figmaX: f?.x,
    domFound: Boolean(d),
    domText: d?.text,
    domFontSize: d?.fontSize,
    domFontWeight: d?.fontWeight,
    domLineHeight: d?.lineHeight,
    domLineRatio: dRatio,
    domY: d?.y,
    domH: d?.h,
    domX: d?.x,
    pairScore,
    paired,
    skip,
    sizeDelta: f?.fontSize != null && d?.fontSize != null ? Math.abs(d.fontSize - f.fontSize) : undefined,
    lhRatioDelta: fRatio != null && dRatio != null ? Math.abs(dRatio - fRatio) : undefined,
    gapToNextFigma,
    gapToNextDom,
  };
}

/** Every measured check for one viewport of one page. */
export function detectAll(
  items: TextItem[],
  media: MediaRegion[],
  reserved: ReservedRegion[],
  viewportWidth: number,
  viewportHeight: number,
  overlay?: FigmaOverlay,
  siteItems: TextItem[] = [],
  siteHay = '',
): Measured[] {
  return [
    ...(items.length ? [...overlaps(items, viewportWidth), ...typeHierarchy(items, viewportWidth)] : []),
    ...firstScreenGap(items, media, reserved, viewportWidth, viewportHeight),
    ...peerImageAspect(media, viewportWidth),
    ...stretchedImages(media),
    ...(overlay
      ? (() => {
          const typeHits = overlayTypeCompare(items, overlay, viewportWidth);
          const typeKeys = new Set(typeHits.flatMap((m) => (m.finding.anchors ?? []).map((a) => normText(a))));
          const gaps = overlayNeighborGap(items, overlay, viewportWidth).filter(
            (g) => !(g.finding.anchors ?? []).some((a) => typeKeys.has(normText(a))),
          );
          return [
            ...missingUniqueFigmaText(items, overlay, viewportWidth, siteItems, siteHay),
            ...gaps,
            ...overlayRowAlign(items, overlay, viewportWidth),
            ...overlayTextImageBaseline(items, media, overlay, viewportWidth),
            ...typeHits,
            ...overlayBannerPad(items, media, overlay, viewportWidth),
          ];
        })()
      : []),
  ];
}
