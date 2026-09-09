import type { TextItem } from './browser.js';
import type { Box } from './annotate.js';

/**
 * Turn the text a model quoted into a real box on the page.
 *
 * Why this file exists: asking a vision model for pixel coordinates does not work — it estimates,
 * and a box drawn from an estimate lands on the wrong element, which is worse than no box at all.
 * What the model DOES read accurately is text. So it quotes the text involved and we find where
 * that text actually is, using the browser's own measurements.
 */

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .replace(/[''"""`]/g, "'")
    .trim();

/** Candidate matches for one quoted string, best first. */
function candidates(anchor: string, index: TextItem[]): TextItem[] {
  const a = norm(anchor);
  if (a.length < 2) return [];
  const exact: TextItem[] = [];
  const contains: TextItem[] = [];
  const reverse: TextItem[] = [];
  for (const item of index) {
    const t = norm(item.text);
    if (t === a) exact.push(item);
    else if (a.length >= 4 && t.includes(a)) contains.push(item);
    else if (t.length >= 4 && a.includes(t)) reverse.push(item);
  }
  return [...exact, ...contains, ...reverse];
}

function union(items: Array<{ x: number; y: number; w: number; h: number }>): Box {
  const x0 = Math.min(...items.map((i) => i.x));
  const y0 = Math.min(...items.map((i) => i.y));
  const x1 = Math.max(...items.map((i) => i.x + i.w));
  const y1 = Math.max(...items.map((i) => i.y + i.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface Located {
  box: Box;
  /** how the region was found, shown in the report so a wrong box is recognisable */
  how: string;
  matched: string[];
}

/**
 * Resolve a finding's region from the text it quotes.
 * `yHint` is the model's own y guess — used ONLY to disambiguate between repeated text
 * (e.g. a logo that appears in both header and footer), never as the box itself.
 */
export function locate(anchors: string[] | undefined, index: TextItem[], yHint?: number): Located | null {
  if (!anchors?.length || !index.length) return null;

  const perAnchor = anchors.map((a) => ({ anchor: a, hits: candidates(a, index) })).filter((p) => p.hits.length > 0);
  if (!perAnchor.length) return null;

  // Single anchor: take the hit nearest the hint, else the first.
  if (perAnchor.length === 1) {
    const hits = perAnchor[0].hits;
    const pick = yHint !== undefined ? [...hits].sort((a, b) => Math.abs(a.y - yHint) - Math.abs(b.y - yHint))[0] : hits[0];
    return { box: { x: pick.x, y: pick.y, w: pick.w, h: pick.h }, how: `khớp chữ "${pick.text.slice(0, 40)}"`, matched: [pick.text.slice(0, 40)] };
  }

  // Several anchors: choose the combination that sits closest together — the elements of one
  // finding are near each other, while repeats of the same text are far apart.
  let best: { items: TextItem[]; score: number } | null = null;
  const limit = perAnchor.map((p) => p.hits.slice(0, 6));
  const walk = (i: number, chosen: TextItem[]) => {
    if (i === limit.length) {
      const b = union(chosen);
      const area = Math.max(1, (b.w ?? 0) * (b.h ?? 0));
      const hintPenalty = yHint !== undefined ? Math.abs((b.y ?? 0) - yHint) * 200 : 0;
      const score = area + hintPenalty;
      if (!best || score < best.score) best = { items: [...chosen], score };
      return;
    }
    for (const cand of limit[i]) walk(i + 1, [...chosen, cand]);
  };
  walk(0, []);
  if (!best) return null;

  const chosen = (best as { items: TextItem[]; score: number }).items;
  return {
    box: union(chosen),
    how: `khớp ${chosen.length} chuỗi chữ: ${chosen.map((c) => `"${c.text.slice(0, 24)}"`).join(', ')}`,
    matched: chosen.map((c) => c.text.slice(0, 40)),
  };
}
