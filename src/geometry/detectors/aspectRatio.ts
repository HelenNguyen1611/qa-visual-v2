import type { GeomNode, GeomSnapshot } from '../types.js';
import type { Candidate } from '../candidate.js';
import { alignChildSlots, groupByRole, groupEquivalent, primaryMediaOf } from '../consistency.js';
import { emitOutliers } from './shared.js';

const ASPECT_ABS = 0.08;
const ASPECT_REL = 0.05;
const MIN_EDGE = 24;

function usableMedia(n: GeomNode | undefined): n is GeomNode {
  if (!n || n.ariaHidden || !n.media) return false;
  if (n.media.aspect <= 0) return false;
  return n.box.w >= MIN_EDGE && n.box.h >= MIN_EDGE;
}

/**
 * Displayed aspect of image/media vs equivalent peers in the same group.
 * Compares layout boxes, not natural-vs-rendered stretch (that already lives on MediaRegion).
 */
export function detectAspectRatio(snap: GeomSnapshot): Candidate[] {
  const found: Candidate[] = [];
  const seen = new Set<string>();
  const add = (c: Candidate) => {
    if (seen.has(c.nodeId)) return;
    seen.add(c.nodeId);
    found.push(c);
  };

  const label = (h: { value: number; center: number; delta: number }) =>
    `Tỷ lệ hiển thị ${h.value.toFixed(2)} lệch nhóm (median ${h.center.toFixed(2)}, Δ ${h.delta.toFixed(2)})`;

  for (const g of groupEquivalent(snap.nodes.filter(usableMedia))) {
    for (const c of emitOutliers('aspect-ratio', g.nodes, g.nodes.map((n) => n.media!.aspect), snap, {
      groupKey: g.key,
      howGrouped: 'sibling-media',
      signature: g.signature,
      parentId: g.parentId,
      label,
    }, { abs: ASPECT_ABS, rel: ASPECT_REL })) {
      add(c);
    }
  }

  for (const g of groupEquivalent(snap.nodes.filter((n) => !n.media))) {
    if (g.nodes.length < 3) continue;
    for (const slot of alignChildSlots(g.nodes, snap.nodes)) {
      const members = slot.nodes.filter(usableMedia);
      if (members.length < 3) continue;
      for (const c of emitOutliers('aspect-ratio', members, members.map((n) => n.media!.aspect), snap, {
        groupKey: `${g.key}::${slot.key}`,
        howGrouped: 'slot',
        signature: slot.key,
        parentId: g.parentId,
        label,
      }, { abs: ASPECT_ABS, rel: ASPECT_REL })) {
        add(c);
      }
    }
  }

  // Same repeated component, even when one card or its image carries a modifier class.
  for (const g of groupByRole(snap.nodes.filter((n) => !n.media))) {
    if (g.nodes.length < 3) continue;
    const members = g.nodes.map((p) => primaryMediaOf(p, snap.nodes, usableMedia)).filter((n): n is GeomNode => Boolean(n));
    if (members.length < 3) continue;
    for (const c of emitOutliers('aspect-ratio', members, members.map((n) => n.media!.aspect), snap, {
      groupKey: `${g.key}::media`,
      howGrouped: 'card-media-slot',
      signature: `${g.signature}::media`,
      parentId: g.parentId,
      label,
    }, { abs: ASPECT_ABS, rel: ASPECT_REL })) {
      add(c);
    }
  }

  return found;
}
