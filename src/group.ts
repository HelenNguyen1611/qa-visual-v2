import type { AiFinding } from './report.js';
import { isTemplateFinding, normText, type SharedInfo } from './shared.js';

/**
 * Collapse the same defect reported many times into one entry.
 *
 * Two kinds of duplication happen:
 *   1. Within one page — the same bug is found at mobile, at tablet, and again by the
 *      desktop↔mobile self-check.
 *   2. Across pages — a header/footer bug exists on every page of the site.
 *
 * The key is the set of text anchors the model quoted. Anchors are stable across pages precisely
 * because a shared component IS the same component, so identical anchors mean the same defect —
 * no matter how differently the model worded its title each time.
 */

export interface Occurrence {
  url: string;
  viewport: string;
  finding: AiFinding;
}

export interface GroupedFinding {
  /** the clearest wording seen for this defect */
  title: string;
  detail: string;
  severity: AiFinding['severity'];
  anchors?: string[];
  /** 'template' = shared header/nav/footer, fix once for the whole site */
  scope: 'template' | 'page';
  /** pages where it was actually observed */
  pages: string[];
  viewports: string[];
  /** best available crop, taken from the first occurrence that resolved a box */
  crop?: string;
  locatedHow?: string;
  /** how many raw findings were folded into this one */
  merged: number;
  num?: number;
  /** at least one occurrence was proved by measurement, not asserted by a model */
  measured?: boolean;
  /** the crop shown came from a measured box, not from matching quoted text */
  measuredCrop?: boolean;
  /** true when the previous run did not report this defect */
  isNew?: boolean;
  /** a human looked at this and signed off that it is intended — see accepted.json */
  accepted?: boolean;
  acceptedWhy?: string;
}

/* ------------------------- same defect, or not? ------------------------- */

/**
 * Why set equality on anchors does not work.
 *
 * One real run produced seven separate entries for ONE footer bug. Their anchor sets:
 *   [hello@…, "WOO acknowledges the First Peoples of Australia"]
 *   [hello@…, "+1300 966 937"]
 *   [hello@…, "WOO acknowledges the First Peoples"]
 *   [hello@…, "WOO acknowledges the First"]
 * The model quotes whatever it happens to quote, truncated at whatever length. Requiring the whole
 * sorted set to match can never collapse these. What they all share is one distinctive anchor.
 *
 * So: two findings are the same defect when they share a distinctive anchor AND describe the same
 * kind of problem. Both halves are needed — "Full name" is shared by the input-border finding and
 * the missing-red-line finding, which are different bugs on the same form.
 */

/** Anchors this short are labels ("Today", "Filter by") and say nothing about which defect it is. */
const MIN_ANCHOR = 8;

function normAnchors(f: AiFinding): string[] {
  return (f.anchors ?? [])
    .map((a) => normText(a).replace(/[^\p{L}\p{N}@.+ ]/gu, '').replace(/\s+/g, ' ').trim())
    .filter((a) => a.length >= MIN_ANCHOR);
}

/** One anchor equal to, or a prefix-ish substring of, another. Truncation is the common case. */
function anchorsOverlap(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      const [short, long] = x.length <= y.length ? [x, y] : [y, x];
      if (short.length >= 12 && long.startsWith(short)) return true;
      if (short.length >= 16 && long.includes(short)) return true;
    }
  }
  return false;
}

/**
 * A coarse defect class read off the wording. This is the guard that stops overlap-merging from
 * fusing two different bugs that happen to sit near the same text.
 */
const KINDS: Array<[string, RegExp]> = [
  ['overlap', /đè|chồng|overlap|intersect|che (mất|khuất)|dính chồng/i],
  ['missing', /thiếu|mất|không (có|thấy|hiển thị)|missing|absent|does not appear|not shown|chưa (có|hiển thị)/i],
  ['spacing', /khoảng (cách|trống)|empty band|empty space|cách quá|sát|dính|padding|margin|spacing|inset|gutter|trống lớn|kéo dài/i],
  ['layout', /bố cục|cột|xếp dọc|tràn|lệch|dạt|căn (lề|giữa)|vỡ|layout|overflow|bị ép/i],
  ['type', /font|type hierarchy|chữ (to|nhỏ|đậm|nhạt)|cỡ chữ|line-height|ngắt dòng|bẻ dòng|co quá hẹp|bóp|smaller than/i],
  ['color', /màu|đậm|nhạt|contrast|viền|border|nền/i],
  ['image', /ảnh|hình|image|logo|icon|aspect|thumbnail/i],
];

function kindOf(f: AiFinding): string {
  const t = f.title + ' ' + (f.detail ?? '');
  for (const [name, re] of KINDS) if (re.test(t)) return name;
  return 'other';
}

/** Word overlap between titles, for findings whose kind could not be read. */
function titleSim(a: string, b: string): number {
  const w = (s: string) => new Set(normText(s).split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 2));
  const A = w(a);
  const B = w(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.min(A.size, B.size);
}

function sameDefect(a: AiFinding, b: AiFinding, aa: string[], ba: string[]): boolean {
  if (aa.length && ba.length) {
    if (!anchorsOverlap(aa, ba)) return false;
    // Shared location. Same kind of problem, or near-identical wording, and it is one defect.
    return kindOf(a) === kindOf(b) || titleSim(a.title, b.title) >= 0.7;
  }
  // No usable anchors on one side: wording is all there is, so demand a lot of it.
  return titleSim(a.title, b.title) >= 0.7;
}

/**
 * Do these two describe the same defect?
 *
 * Exported so the accept-list decides sameness the same way drift does. An accepted finding has to
 * survive the model rewording its own title next run, which is exactly the problem `sameDefect`
 * already solves — an id hashed from the wording would quietly un-accept itself.
 */
export function sameGroupedDefect(a: Pick<GroupedFinding, 'title' | 'detail' | 'anchors'>, b: Pick<GroupedFinding, 'title' | 'detail' | 'anchors'>): boolean {
  const A = { title: a.title, detail: a.detail, anchors: a.anchors } as AiFinding;
  const B = { title: b.title, detail: b.detail, anchors: b.anchors } as AiFinding;
  return sameDefect(A, B, normAnchors(A), normAnchors(B));
}

const SEV_RANK: Record<AiFinding['severity'], number> = { major: 0, minor: 1, note: 2 };

/**
 * Line this run's findings up against the previous run's.
 *
 * The reason this exists: a vision model asked the same question twice does not answer the same
 * way twice, so a defect can be reported on Monday and unmentioned on Tuesday with nothing having
 * changed on the site. Silently dropping it teaches you not to trust the report. Naming it —
 * "last run found this, this run did not" — turns invisible flakiness into a line you can check
 * in ten seconds, and it is the only honest thing to show.
 */
export interface Drift {
  /** not seen in the previous run */
  isNew: boolean;
}

export function markDrift(current: GroupedFinding[], previous: GroupedFinding[]): { gone: GroupedFinding[] } {
  const asFinding = (g: GroupedFinding): AiFinding => ({ title: g.title, detail: g.detail, severity: g.severity, anchors: g.anchors } as AiFinding);
  const prevA = previous.map((g) => normAnchors(asFinding(g)));
  const matchedPrev = new Set<number>();

  for (const g of current) {
    const a = normAnchors(asFinding(g));
    let hit = -1;
    for (let i = 0; i < previous.length; i++) {
      if (sameDefect(asFinding(g), asFinding(previous[i]), a, prevA[i])) {
        hit = i;
        break;
      }
    }
    g.isNew = hit === -1;
    if (hit >= 0) matchedPrev.add(hit);
  }
  return { gone: previous.filter((_, i) => !matchedPrev.has(i)) };
}

export function groupFindings(occurrences: Occurrence[], shared: SharedInfo): GroupedFinding[] {
  const n = occurrences.length;
  const anchors = occurrences.map((o) => normAnchors(o.finding));

  // Union-find. Sameness is not transitive-by-key here — it is a relation between pairs — so
  // clusters have to be grown, not looked up.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      if (sameDefect(occurrences[i].finding, occurrences[j].finding, anchors[i], anchors[j])) union(i, j);
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r)!.push(i);
  }

  const out: GroupedFinding[] = [];
  for (const idx of clusters.values()) {
    const first = occurrences[idx[0]].finding;
    // The clearest wording of the group: the shortest title (least rambling) at the worst severity.
    const best = idx
      .map((i) => occurrences[i].finding)
      .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.title.length - b.title.length)[0];
    // A measured occurrence describes the same defect with the actual numbers in it, so its wording
    // wins over the model's. The severity does not: the worst one in the group still stands.
    const proof = idx.map((i) => occurrences[i].finding).find((f) => f.measured);
    const g: GroupedFinding = {
      title: proof?.title ?? best.title,
      detail: proof?.detail ?? idx.map((i) => occurrences[i].finding.detail).sort((a, b) => b.length - a.length)[0] ?? first.detail,
      severity: best.severity,
      measured: Boolean(proof),
      // Keep every anchor the group mentioned: it is what the next run has to match against.
      anchors: Array.from(new Set(idx.flatMap((i) => occurrences[i].finding.anchors ?? []))).slice(0, 6),
      scope: 'page',
      pages: [],
      viewports: [],
      merged: idx.length,
    };
    for (const i of idx) {
      const oc = occurrences[i];
      if (!g.pages.includes(oc.url)) g.pages.push(oc.url);
      if (!g.viewports.includes(oc.viewport)) g.viewports.push(oc.viewport);
      // A measured box beats a box resolved from quoted text, so it may replace one already taken.
      if (oc.finding.crop && (!g.crop || (oc.finding.measured && !g.measuredCrop))) {
        g.crop = oc.finding.crop;
        g.locatedHow = oc.finding.locatedHow;
        if (oc.finding.measured) g.measuredCrop = true;
      }
    }
    g.scope = isTemplateFinding(g.anchors, shared) ? 'template' : 'page';
    out.push(g);
  }
  // A defect seen on many pages is template-level even if the anchor test was inconclusive:
  // appearing everywhere is itself the evidence.
  for (const g of out) {
    if (g.scope === 'page' && shared.pageCount >= 3 && g.pages.length >= Math.ceil(shared.pageCount * 0.6)) g.scope = 'template';
  }

  const vpOrder = (v: string) => ({ mobile: 0, tablet: 1, desktop: 2 } as Record<string, number>)[v] ?? 3;
  for (const g of out) g.viewports.sort((a, b) => vpOrder(a) - vpOrder(b));

  out.sort(
    (a, b) =>
      (a.scope === b.scope ? 0 : a.scope === 'template' ? -1 : 1) ||
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      b.pages.length - a.pages.length,
  );
  out.forEach((g, i) => (g.num = i + 1));
  return out;
}
