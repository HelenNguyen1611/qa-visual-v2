import type { TextItem } from './browser.js';

/**
 * Work out which parts of a site are template (header / nav / footer) and which are page content,
 * by counting: a text run that appears on most pages belongs to the shared chrome.
 *
 * Pure counting, no AI, no configuration. This is what lets one footer bug be reported once for the
 * whole site instead of once per page.
 */

export const normText = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[''"""`]/g, "'")
    .trim();

/** Text present on at least this share of pages counts as template chrome. */
const SHARE = 0.6;
/** Below this many pages the notion of "shared" is meaningless. */
const MIN_PAGES = 3;

export interface SharedInfo {
  /** normalised text runs that belong to the template */
  texts: Set<string>;
  /** per page: the y bands the template occupies, so the AI can be told to skip them */
  bands: Map<string, Array<{ from: number; to: number; where: 'top' | 'bottom' }>>;
  pageCount: number;
}

export function detectShared(pages: Array<{ url: string; textIndex: TextItem[]; pageHeight: number }>): SharedInfo {
  const info: SharedInfo = { texts: new Set(), bands: new Map(), pageCount: pages.length };
  if (pages.length < MIN_PAGES) return info;

  const count = new Map<string, Set<string>>();
  for (const p of pages) {
    for (const item of p.textIndex) {
      const t = normText(item.text);
      if (t.length < 3) continue;
      if (!count.has(t)) count.set(t, new Set());
      count.get(t)!.add(p.url);
    }
  }
  const threshold = Math.max(MIN_PAGES - 1, Math.ceil(pages.length * SHARE));
  for (const [t, urls] of count) if (urls.size >= threshold) info.texts.add(t);

  // Turn shared text into contiguous y bands at the top and bottom of each page — that is where
  // header and footer live, and it is what we hand the model as "already reviewed, skip".
  for (const p of pages) {
    const hits = p.textIndex
      .filter((i) => info.texts.has(normText(i.text)))
      .map((i) => ({ y: i.y, bottom: i.y + i.h }))
      .sort((a, b) => a.y - b.y);
    if (!hits.length) continue;
    const bands: Array<{ from: number; to: number; where: 'top' | 'bottom' }> = [];

    // header: shared text starting at the very top, extended while gaps stay small
    const topHits = hits.filter((h) => h.y < p.pageHeight * 0.25);
    if (topHits.length) {
      let to = topHits[0].bottom;
      for (const h of topHits) {
        if (h.y - to > 400) break;
        to = Math.max(to, h.bottom);
      }
      if (to > 40) bands.push({ from: 0, to: Math.round(to + 20), where: 'top' });
    }
    // footer: shared text in the last quarter of the page
    const botHits = hits.filter((h) => h.y > p.pageHeight * 0.6);
    if (botHits.length) {
      let from = botHits[botHits.length - 1].y;
      for (let i = botHits.length - 1; i >= 0; i--) {
        if (from - botHits[i].bottom > 400) break;
        from = Math.min(from, botHits[i].y);
      }
      bands.push({ from: Math.max(0, Math.round(from - 20)), to: p.pageHeight, where: 'bottom' });
    }
    info.bands.set(p.url, bands);
  }
  return info;
}

/** Are all of a finding's anchors inside the shared template text? */
export function isTemplateFinding(anchors: string[] | undefined, shared: SharedInfo): boolean {
  if (!anchors?.length || !shared.texts.size) return false;
  return anchors.every((a) => {
    const n = normText(a);
    if (shared.texts.has(n)) return true;
    // an anchor may be a fragment of a shared run, or contain one
    for (const t of shared.texts) if ((n.length >= 4 && t.includes(n)) || (t.length >= 4 && n.includes(t))) return true;
    return false;
  });
}
