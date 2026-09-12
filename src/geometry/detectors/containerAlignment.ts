import type { GeomNode, GeomSnapshot } from '../types.js';
import type { Candidate } from '../candidate.js';
import { emitOutliers, isChrome } from './shared.js';

function columnNodes(snap: GeomSnapshot): GeomNode[] {
  const vw = snap.viewportWidth;
  return snap.nodes.filter(
    (n) =>
      !n.ariaHidden &&
      !isChrome(n) &&
      (n.kind === 'section' || n.kind === 'block' || n.kind === 'container') &&
      n.box.w >= vw * 0.4 &&
      n.box.h >= 48 &&
      n.tag !== 'main',
  );
}

function widthBand(w: number, vw: number): string {
  if (w >= vw * 0.92) return 'full';
  if (w >= vw * 0.62) return 'wide';
  return 'inset';
}

/** A section/component whose left edge sits off the shared column of same-width peers. */
export function detectContainerAlignment(snap: GeomSnapshot): Candidate[] {
  const nodes = columnNodes(snap);
  const bands = new Map<string, GeomNode[]>();
  for (const n of nodes) {
    const b = widthBand(n.box.w, snap.viewportWidth);
    const list = bands.get(b) ?? [];
    list.push(n);
    bands.set(b, list);
  }
  const out: Candidate[] = [];
  for (const [band, members] of bands) {
    if (members.length < 3) continue;
    out.push(
      ...emitOutliers(
        'container-alignment',
        members,
        members.map((n) => n.box.x),
        snap,
        {
          groupKey: `column:${band}`,
          howGrouped: 'width-band',
          signature: band,
          label: (h) => `Lề trái ${Math.round(h.value)}px lệch cột ${band} (median ${Math.round(h.center)}px, Δ ${Math.round(h.delta)}px)`,
        },
      ),
    );
  }
  return out;
}
