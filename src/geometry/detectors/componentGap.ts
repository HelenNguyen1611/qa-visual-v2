import type { GeomSnapshot } from '../types.js';
import type { Candidate } from '../candidate.js';
import { alignChildSlots, gapY, groupEquivalent } from '../consistency.js';
import { emitOutliers } from './shared.js';

/**
 * Spacing between corresponding children inside repeated components.
 * Compares img→title (etc.) gaps, not total card height.
 */
export function detectComponentGap(snap: GeomSnapshot): Candidate[] {
  const out: Candidate[] = [];
  for (const g of groupEquivalent(snap.nodes.filter((n) => !n.media))) {
    if (g.nodes.length < 3) continue;
    const slots = alignChildSlots(g.nodes, snap.nodes)
      .map((s) => ({ s, idx: s.nodes.find((n) => n)?.siblingIndex ?? 0 }))
      .sort((a, b) => a.idx - b.idx);
    for (let i = 0; i < slots.length - 1; i++) {
      const a = slots[i].s;
      const b = slots[i + 1].s;
      const members = [];
      const gaps: number[] = [];
      for (let p = 0; p < g.nodes.length; p++) {
        const na = a.nodes[p];
        const nb = b.nodes[p];
        if (!na || !nb) continue;
        members.push(nb);
        gaps.push(gapY(na, nb));
      }
      if (members.length < 3) continue;
      out.push(
        ...emitOutliers('component-gap', members, gaps, snap, {
          groupKey: `${g.key}::${a.key}->${b.key}`,
          howGrouped: 'corresponding-gap',
          signature: `${a.key}->${b.key}`,
          parentId: g.parentId,
          label: (h) =>
            `Khoảng cách trong component ${Math.round(h.value)}px (median ${Math.round(h.center)}px, Δ ${Math.round(h.delta)}px) giữa ${a.key} và ${b.key}`,
        }),
      );
    }
  }
  return out;
}
