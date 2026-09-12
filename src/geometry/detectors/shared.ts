import type { GeomNode, GeomSnapshot } from '../types.js';
import type { Candidate, CandidateKind } from '../candidate.js';
import { findOutliers, type Outlier } from '../consistency.js';

export function emitOutliers(
  kind: CandidateKind,
  members: GeomNode[],
  values: number[],
  snap: GeomSnapshot,
  meta: { groupKey: string; howGrouped: string; signature: string; parentId?: string; label: (h: Outlier, n: GeomNode) => string },
  opts?: { abs?: number; rel?: number },
): Candidate[] {
  const hits = findOutliers(values, { abs: opts?.abs, rel: opts?.rel, minGroup: 3 });
  const peers = members.map((n, i) => ({ id: n.id, locator: n.locator, box: n.box, value: values[i] }));
  return hits.map((h) => {
    const n = members[h.index];
    return {
      kind,
      status: 'candidate' as const,
      id: `${kind}:${n.id}`,
      nodeId: n.id,
      locator: n.locator,
      box: n.box,
      summary: meta.label(h, n),
      evidence: {
        groupKey: meta.groupKey,
        howGrouped: meta.howGrouped,
        parentId: meta.parentId,
        signature: meta.signature,
        value: h.value,
        groupMedian: h.center,
        delta: h.delta,
        peers,
        viewportWidth: snap.viewportWidth,
        viewportHeight: snap.viewportHeight,
      },
    };
  });
}

export const CHROME = /header|footer|nav/i;

export function isChrome(n: GeomNode): boolean {
  return CHROME.test(n.tag) || n.role === 'banner' || n.role === 'contentinfo' || n.role === 'navigation';
}

export function containsBox(a: GeomNode, b: GeomNode): boolean {
  return (
    b.box.x >= a.box.x - 1 &&
    b.box.y >= a.box.y - 1 &&
    b.box.x + b.box.w <= a.box.x + a.box.w + 1 &&
    b.box.y + b.box.h <= a.box.y + a.box.h + 1
  );
}
