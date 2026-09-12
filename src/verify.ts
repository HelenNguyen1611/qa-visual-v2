import type { TextItem, MediaRegion, ReservedRegion } from './browser.js';
import type { Box } from './annotate.js';
import type { AiFinding } from './report.js';

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
const CAP = { overlap: 4, type: 2, gap: 1 };

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
          title: 'Chữ chồng lên nhau',
          severity: 'major',
          detail:
            `Hai khối chữ đè lên nhau ${Math.round(ratio * 100)}% (vùng chồng ${Math.round(inter.w)}×${Math.round(inter.h)}px): ` +
            `“${a.text.slice(0, 60)}” và “${b.text.slice(0, 60)}”. Đo trực tiếp trên DOM, không phải nhận xét từ ảnh.`,
          anchors: [a.text.slice(0, 60), b.text.slice(0, 60)],
          y: Math.min(a.y, b.y),
          locatedHow: 'đo trên DOM: hai box chữ giao nhau',
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
        title: `Cỡ chữ sai phân cấp: ${hi.toUpperCase()} nhỏ hơn ${lo.toUpperCase()}`,
        severity: 'minor',
        detail:
          `${hi.toUpperCase()} lớn nhất trên trang là ${a}px (“${big.text.slice(0, 50)}”), ` +
          `trong khi ${lo.toUpperCase()} lớn nhất là ${b}px (“${small.text.slice(0, 50)}”). ` +
          `Cấp trên phải lớn hơn hoặc bằng cấp dưới. Đo bằng computed style.`,
        anchors: [big.text.slice(0, 60), small.text.slice(0, 60)],
        y: big.y,
        locatedHow: `đo trên DOM: font-size ${a}px vs ${b}px`,
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
        title: 'Khoảng trống lớn ở màn hình đầu',
        severity: 'minor',
        detail:
          `Không có chữ hay media nào trong dải y = ${Math.round(worst.from)} … ${Math.round(worst.to)} ` +
          `(${size}px, chiếm ${Math.round((size / viewportHeight) * 100)}% màn hình đầu cao ${viewportHeight}px). ` +
          `Đo trên DOM: đã tính cả ảnh, video, ảnh nền CSS, và cả media đang ẩn chờ hiệu ứng, là nội dung.`,
        anchors: anchors.length ? anchors : undefined,
        y: Math.round(worst.from),
        locatedHow: `đo trên DOM: trống ${size}px trong màn hình đầu`,
        measured: true,
      },
      box: { x: 0, y: Math.round(worst.from), w: viewportWidth, h: size },
    },
  ];
}

/** Every measured check for one viewport of one page. */
export function detectAll(
  items: TextItem[],
  media: MediaRegion[],
  reserved: ReservedRegion[],
  viewportWidth: number,
  viewportHeight: number,
): Measured[] {
  if (!items.length) return [];
  return [
    ...overlaps(items, viewportWidth),
    ...typeHierarchy(items, viewportWidth),
    ...firstScreenGap(items, media, reserved, viewportWidth, viewportHeight),
  ];
}
