import type { FigmaFrame } from './design.js';
import type { PageTarget } from './pages.js';

/**
 * Pair each URL with the Figma frame that is its design.
 *
 * The rule that matters most: a WRONG pairing is far worse than no pairing. Comparing /about/
 * against the Home design produces a flood of "missing element / wrong order" findings that look
 * like real bugs. So we only pair when the best candidate is both good enough AND clearly better
 * than the runner-up; otherwise the page runs without design comparison.
 */

/** Frame names like "Inside Page", "Detail", "Single" are templates for a whole class of URLs, not one page. */
const TEMPLATE_HINT = /inside page|inside-page|detail|single|template|article|post/i;
/** Frames that are not page designs at all. */
const NOT_A_PAGE = /preloader|components?$|thank ?you|^ty$|\/ ?ty$|cover|style ?guide|typography|colou?rs?$|icons?$|logo/i;

const strip = (s: string) =>
  s
    .toLowerCase()
    .replace(/^\s*\d+\s*[\/.\-–]\s*/, '') // "01 / Homepage" → "homepage"
    .replace(/\b(page|desktop|mobile|tablet|final|v\d+(\.\d+)?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const tokens = (s: string) => new Set(strip(s).split(' ').filter((t) => t.length > 1));

function slugWords(url: string): string {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '');
    if (!p || p === '') return 'home homepage index';
    return p.replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  } catch {
    return url;
  }
}

/** 0..1 similarity between a URL and a frame name. */
function score(url: string, frame: FigmaFrame): number {
  const a = slugWords(url);
  const b = strip(frame.name);
  if (!a || !b) return 0;
  if (a === b) return 1;

  // Homepage is a special case: the path is empty, the frame is usually called home/homepage.
  const isHome = /^(home|homepage|index)$/.test(a.split(' ')[0]) && a.split(' ').length <= 3;
  if (isHome && /^(home|homepage|index)/.test(b)) return 1;

  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) {
    if (tb.has(t)) hit++;
    else for (const u of tb) if (t.length > 3 && u.length > 3 && (u.startsWith(t) || t.startsWith(u))) { hit += 0.7; break; }
  }
  const overlap = hit / Math.max(ta.size, tb.size);
  // A frame whose name fully contains the slug (or vice versa) is a strong signal.
  if (b.includes(a) || a.includes(b)) return Math.max(overlap, 0.85);
  return overlap;
}

export interface Mapped extends PageTarget {
  frame?: FigmaFrame;
  score: number;
  /** the runner-up score, so an ambiguous pairing is visible */
  runnerUp: number;
  isTemplate: boolean;
  /** why it paired, or why it did not */
  how: string;
}

const MIN_SCORE = 0.5;
const MIN_MARGIN = 0.15;

export function mapUrlsToFrames(urls: string[], frames: FigmaFrame[]): Mapped[] {
  const usable = frames.filter((f) => !NOT_A_PAGE.test(f.name));
  const claimed = new Set<string>();
  const out: Mapped[] = [];

  // Score every pair once, then assign best-first so a strong pairing wins its frame.
  const pairs: Array<{ url: string; frame: FigmaFrame; s: number }> = [];
  for (const url of urls) for (const frame of usable) pairs.push({ url, frame, s: score(url, frame) });
  pairs.sort((a, b) => b.s - a.s);

  const chosen = new Map<string, { frame: FigmaFrame; s: number; runnerUp: number }>();
  for (const url of urls) {
    const mine = pairs.filter((p) => p.url === url).sort((a, b) => b.s - a.s);
    const best = mine[0];
    const second = mine[1];
    if (!best) {
      // No design frames at all — still return the URL so it gets captured and swept.
      chosen.set(url, { frame: undefined as any, s: 0, runnerUp: 0 });
      continue;
    }
    const isTemplate = TEMPLATE_HINT.test(best.frame.name);
    // A template frame may serve several URLs; a page frame may not.
    const free = isTemplate || !claimed.has(best.frame.id);
    if (best.s >= MIN_SCORE && best.s - (second?.s ?? 0) >= MIN_MARGIN && free) {
      chosen.set(url, { frame: best.frame, s: best.s, runnerUp: second?.s ?? 0 });
      if (!isTemplate) claimed.add(best.frame.id);
    } else {
      chosen.set(url, { frame: undefined as any, s: best.s, runnerUp: second?.s ?? 0 });
    }
  }

  for (const url of urls) {
    const c = chosen.get(url)!;
    const isTemplate = c.frame ? TEMPLATE_HINT.test(c.frame.name) : false;
    let how: string;
    if (c.frame) {
      how = `khớp tên "${c.frame.name}" (điểm ${c.s.toFixed(2)}, kế tiếp ${c.runnerUp.toFixed(2)})${isTemplate ? ' — frame dạng template, dùng chung cho nhiều trang' : ''}`;
    } else if (!usable.length) {
      how = 'chưa có design để so — chỉ chụp và kiểm responsive';
    } else if (c.s < MIN_SCORE) {
      how = `không frame nào đủ giống (cao nhất ${c.s.toFixed(2)} < ${MIN_SCORE}) — bỏ phần so design`;
    } else {
      how = `mơ hồ: hai frame giống nhau xấp xỉ (${c.s.toFixed(2)} vs ${c.runnerUp.toFixed(2)}) — bỏ phần so design để tránh ghép sai`;
    }
    out.push({
      url,
      frame: c.frame,
      figmaNodeId: c.frame?.id,
      frameName: c.frame?.name,
      score: c.s,
      runnerUp: c.runnerUp,
      isTemplate,
      how,
    });
  }
  return out;
}

/**
 * A page whose design comparison returns an implausible pile of "missing element / wrong order"
 * findings is usually not a broken page — it is a wrong pairing. Better to say so than to present
 * the noise as bugs.
 */
export function looksMispaired(titles: string[]): boolean {
  if (titles.length < 5) return false;
  const structural = titles.filter((t) => /thiếu|không có|mất|thứ tự|khác hoàn toàn|sai bố cục|không xuất hiện/i.test(t)).length;
  return structural >= 4 && structural / titles.length >= 0.6;
}
