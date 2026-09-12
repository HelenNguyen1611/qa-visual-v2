import type { GeomSnapshot } from '../types.js';
import type { Candidate } from '../candidate.js';
import { groupEquivalent, mad } from '../consistency.js';
import { emitOutliers } from './shared.js';

/** Alignment among repeated siblings that are actually the same type (same parent + signature). */
export function detectSiblingAlignment(snap: GeomSnapshot): Candidate[] {
  const out: Candidate[] = [];
  const groups = groupEquivalent(snap.nodes.filter((n) => n.kind === 'item' || n.kind === 'section' || n.kind === 'block'));
  for (const g of groups) {
    if (g.nodes.length < 3) continue;
    const xs = g.nodes.map((n) => n.box.x);
    const ys = g.nodes.map((n) => n.box.y);
    const axis = mad(ys) <= mad(xs) ? 'y' : 'x';
    const values = axis === 'y' ? ys : xs;
    out.push(
      ...emitOutliers('sibling-alignment', g.nodes, values, snap, {
        groupKey: g.key,
        howGrouped: `equivalent-${axis}`,
        signature: g.signature,
        parentId: g.parentId,
        label: (h) =>
          `Lệch ${axis} = ${Math.round(h.value)}px so với nhóm ${g.signature} (median ${Math.round(h.center)}px, Δ ${Math.round(h.delta)}px)`,
      }),
    );
  }
  return out;
}
