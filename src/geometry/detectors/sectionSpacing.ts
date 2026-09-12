import type { GeomNode, GeomSnapshot } from '../types.js';
import type { Candidate } from '../candidate.js';
import { gapY } from '../consistency.js';
import { containsBox, emitOutliers, isChrome } from './shared.js';

function topSections(snap: GeomSnapshot): GeomNode[] {
  const vw = snap.viewportWidth;
  const raw = snap.nodes.filter(
    (n) =>
      n.kind === 'section' &&
      !n.ariaHidden &&
      !isChrome(n) &&
      n.box.w >= vw * 0.5 &&
      n.box.h >= 40,
  );
  return raw
    .filter((s) => !raw.some((o) => o.id !== s.id && containsBox(o, s)))
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

/**
 * Unusual gap between consecutive top-level sections.
 * Evenly different gaps are not outliers — only a lone spike is.
 */
export function detectSectionSpacing(snap: GeomSnapshot): Candidate[] {
  const secs = topSections(snap);
  if (secs.length < 4) return [];
  const members: GeomNode[] = [];
  const gaps: number[] = [];
  for (let i = 0; i < secs.length - 1; i++) {
    members.push(secs[i + 1]);
    gaps.push(gapY(secs[i], secs[i + 1]));
  }
  return emitOutliers('section-spacing', members, gaps, snap, {
    groupKey: 'sections:y',
    howGrouped: 'consecutive-sections',
    signature: 'section',
    label: (h, n) =>
      `Khoảng cách tới section trước = ${Math.round(h.value)}px (median ${Math.round(h.center)}px, Δ ${Math.round(h.delta)}px) tại ${n.locator}`,
  });
}
