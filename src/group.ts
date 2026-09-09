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
}

function keyOf(f: AiFinding): string {
  if (f.anchors?.length) return 'a:' + f.anchors.map(normText).sort().join('|');
  // No anchors: fall back to the title with numbers and quotes stripped, so paraphrases still meet.
  return 't:' + normText(f.title).replace(/\d+/g, '#').replace(/['"].*?['"]/g, '');
}

const SEV_RANK: Record<AiFinding['severity'], number> = { major: 0, minor: 1, note: 2 };

export function groupFindings(occurrences: Occurrence[], shared: SharedInfo): GroupedFinding[] {
  const map = new Map<string, GroupedFinding>();

  for (const oc of occurrences) {
    const k = keyOf(oc.finding);
    const existing = map.get(k);
    if (!existing) {
      map.set(k, {
        title: oc.finding.title,
        detail: oc.finding.detail,
        severity: oc.finding.severity,
        anchors: oc.finding.anchors,
        scope: isTemplateFinding(oc.finding.anchors, shared) ? 'template' : 'page',
        pages: [oc.url],
        viewports: [oc.viewport],
        crop: oc.finding.crop,
        locatedHow: oc.finding.locatedHow,
        merged: 1,
      });
      continue;
    }
    existing.merged++;
    if (!existing.pages.includes(oc.url)) existing.pages.push(oc.url);
    if (!existing.viewports.includes(oc.viewport)) existing.viewports.push(oc.viewport);
    if (SEV_RANK[oc.finding.severity] < SEV_RANK[existing.severity]) existing.severity = oc.finding.severity;
    // Prefer an occurrence that actually produced a crop, and the longer explanation.
    if (!existing.crop && oc.finding.crop) {
      existing.crop = oc.finding.crop;
      existing.locatedHow = oc.finding.locatedHow;
    }
    if (oc.finding.detail.length > existing.detail.length) existing.detail = oc.finding.detail;
  }

  const out = Array.from(map.values());
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
