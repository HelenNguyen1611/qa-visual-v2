import type { GeomSnapshot } from '../types.js';
import type { Candidate } from '../candidate.js';
import type { FigmaGeomTree } from '../figmaTree.js';
import { matchFigmaToDom, type GeomMatch } from '../match.js';
import {
  headingBodyGap,
  mapBlocks,
  sideFloor,
  type BlockMatch,
  type ChildInsetMatch,
  type LayoutOwnerMatch,
} from '../blockMap.js';

/** Desktop-only: live tablet/mobile vs a page-width Figma frame is not a geometry compare. */
const MIN_VIEWPORT = 1200;
const MIN_PAIRS = 4;
const Y_ABS = 80;
const Y_REL = 0.06;
const X_ABS = 48;
const X_REL = 0.08;
const ASPECT_ABS = 0.12;
const ASPECT_REL = 0.08;
const NARROW = 0.65;

function fullWidth(w: number, container: number): boolean {
  return container > 0 && w / container >= NARROW;
}

/**
 * Geometry vs the mapped Figma frame. Correspondence is unique text (+ nearby media).
 * Does not invent boxes. Does not compare Figma TEXT width to block-level DOM headings.
 */
export function detectFigmaDom(snap: GeomSnapshot, tree: FigmaGeomTree): Candidate[] {
  if (snap.viewportWidth < MIN_VIEWPORT) return [];
  if (tree.frame.w < 50 || tree.frame.h < 50) return [];

  const matched = matchFigmaToDom(snap, tree);
  const blocks = mapBlocks(snap, tree, matched.pairs);
  const out: Candidate[] = [];
  const ownerPads = paddingFrom(snap, blocks.owners, 'layout-owner');
  out.push(...ownerPads);
  const covered = new Set(blocks.owners.flatMap((o) => o.anchors.map((a) => a.figma.id)));
  const wrapBlocks = blocks.blocks.filter((b) => !b.anchors.every((a) => covered.has(a.figma.id)));
  out.push(...paddingFrom(snap, wrapBlocks));
  const uncoveredInsets = blocks.insets.filter((p) => !p.child.anchors.every((a) => covered.has(a.figma.id)));
  out.push(...insetCandidates(snap, uncoveredInsets));
  out.push(...headingGapCandidates(snap, blocks.blocks));
  out.push(...yResiduals(snap, tree, matched.pairs));
  out.push(...xResiduals(snap, tree, matched.pairs));
  out.push(...mediaAspect(snap, matched.media));
  return out;
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

function paddingFrom(
  snap: GeomSnapshot,
  blocks: Array<BlockMatch | LayoutOwnerMatch>,
  role?: string,
): Candidate[] {
  const found: Candidate[] = [];
  for (const b of blocks) {
    const sides: NonNullable<Candidate['evidence']['sides']> = {};
    let worst: { side: (typeof SIDES)[number]; delta: number } | undefined;
    for (const side of SIDES) {
      const figma = b.figmaPad[side];
      const dom = b.domPad[side];
      const delta = Math.abs(dom - figma);
      sides[side] = { figma, dom, delta };
      const floor = sideFloor(figma, b.dom.box.w);
      if (delta <= floor) continue;
      if (!worst || delta > worst.delta) worst = { side, delta };
    }
    if (!worst) continue;
    const figma = b.figmaPad[worst.side];
    const dom = b.domPad[worst.side];
    const structuralRole = role ?? b.figmaLevel;
    found.push({
      kind: 'figma-dom',
      status: 'candidate',
      id: `figma-dom:padding:${b.dom.id}`,
      nodeId: b.dom.id,
      locator: b.dom.locator,
      box: b.dom.box,
      summary: `Padding ${worst.side} ${Math.round(dom)}px vs Figma ${Math.round(figma)}px (Δ ${Math.round(worst.delta)}px)`,
      evidence: {
        groupKey: `figma-padding:${b.figma.id}`,
        howGrouped: 'figma-padding',
        signature: b.dom.signature,
        value: dom,
        groupMedian: figma,
        delta: worst.delta,
        peers: [
          { id: `figma:${b.figma.id}`, locator: `figma:${b.figma.id}`, box: b.figma.box, value: figma },
          { id: b.dom.id, locator: b.dom.locator, box: b.dom.box, value: dom },
        ],
        viewportWidth: snap.viewportWidth,
        viewportHeight: snap.viewportHeight,
        figmaId: b.figma.id,
        figmaValue: figma,
        confidence: b.confidence,
        sides,
        structuralRole,
      },
    });
  }
  return found;
}

function insetCandidates(snap: GeomSnapshot, pairs: ChildInsetMatch[]): Candidate[] {
  const found: Candidate[] = [];
  for (const p of pairs) {
    const sides: NonNullable<Candidate['evidence']['sides']> = {};
    let worst: { side: (typeof SIDES)[number]; delta: number } | undefined;
    for (const side of SIDES) {
      const figma = p.figmaInset[side];
      const dom = p.domInset[side];
      const delta = Math.abs(dom - figma);
      sides[side] = { figma, dom, delta };
      const floor = sideFloor(figma, p.parentDom.box.w);
      if (delta <= floor) continue;
      if (!worst || delta > worst.delta) worst = { side, delta };
    }
    if (!worst) continue;
    const figma = p.figmaInset[worst.side];
    const dom = p.domInset[worst.side];
    found.push({
      kind: 'figma-dom',
      status: 'candidate',
      id: `figma-dom:inset:${p.child.dom.id}`,
      nodeId: p.child.dom.id,
      locator: p.child.dom.locator,
      box: p.child.dom.box,
      summary: `Inset ${worst.side} ${Math.round(dom)}px vs Figma ${Math.round(figma)}px (Δ ${Math.round(worst.delta)}px)`,
      evidence: {
        groupKey: `figma-inset:${p.parentFigma.id}:${p.child.figma.id}`,
        howGrouped: 'figma-inset',
        parentId: p.parentDom.id,
        signature: p.child.dom.signature,
        value: dom,
        groupMedian: figma,
        delta: worst.delta,
        peers: [
          { id: `figma:${p.parentFigma.id}`, locator: `figma:${p.parentFigma.id}`, box: p.parentFigma.box, value: figma },
          { id: p.parentDom.id, locator: p.parentDom.locator, box: p.parentDom.box, value: dom },
        ],
        viewportWidth: snap.viewportWidth,
        viewportHeight: snap.viewportHeight,
        figmaId: p.parentFigma.id,
        figmaValue: figma,
        confidence: p.confidence,
        sides,
        parentFigmaId: p.parentFigma.id,
        childFigmaId: p.child.figma.id,
        parentLocator: p.parentDom.locator,
        childLocator: p.child.dom.locator,
      },
    });
  }
  return found;
}

function headingGapCandidates(snap: GeomSnapshot, blocks: BlockMatch[]): Candidate[] {
  const found: Candidate[] = [];
  for (const b of blocks) {
    const g = headingBodyGap(b.anchors);
    if (!g) continue;
    const figma = g.figma * b.scale;
    const dom = g.dom;
    const delta = Math.abs(dom - figma);
    if (delta <= sideFloor(figma, b.dom.box.w)) continue;
    found.push({
      kind: 'figma-dom',
      status: 'candidate',
      id: `figma-dom:heading-gap:${b.dom.id}`,
      nodeId: b.dom.id,
      locator: b.dom.locator,
      box: b.dom.box,
      summary: `Gap heading↔mô tả ${Math.round(dom)}px vs Figma ${Math.round(figma)}px (Δ ${Math.round(delta)}px)`,
      evidence: {
        groupKey: `figma-heading-gap:${b.figma.id}`,
        howGrouped: 'figma-heading-gap',
        signature: b.dom.signature,
        value: dom,
        groupMedian: figma,
        delta,
        peers: [
          { id: `figma:${b.figma.id}`, locator: `figma:${b.figma.id}`, box: b.figma.box, value: figma },
          { id: b.dom.id, locator: b.dom.locator, box: b.dom.box, value: dom },
        ],
        viewportWidth: snap.viewportWidth,
        viewportHeight: snap.viewportHeight,
        figmaId: b.figma.id,
        figmaValue: figma,
        confidence: b.confidence,
      },
    });
  }
  return found;
}

function yResiduals(snap: GeomSnapshot, tree: FigmaGeomTree, pairs: GeomMatch[]): Candidate[] {
  if (pairs.length < MIN_PAIRS) return [];
  const ordered = pairs.slice().sort((a, b) => a.figma.box.y - b.figma.box.y || a.figma.box.x - b.figma.box.x);
  const found: Candidate[] = [];
  for (let i = 1; i < ordered.length - 1; i++) {
    const prev = ordered[i - 1];
    const next = ordered[i + 1];
    const cur = ordered[i];
    const span = next.figma.box.y - prev.figma.box.y;
    if (span < 8) continue;
    const t = (cur.figma.box.y - prev.figma.box.y) / span;
    const pred = prev.dom.box.y + t * (next.dom.box.y - prev.dom.box.y);
    const delta = Math.abs(cur.dom.box.y - pred);
    const floor = Math.max(Y_ABS, snap.pageHeight * Y_REL);
    if (delta <= floor) continue;
    found.push(
      candidate(snap, cur, 'figma-y', pred, delta, `Vị trí dọc lệch design ≈ ${Math.round(delta)}px (nội suy từ "${prev.figma.text}" → "${next.figma.text}")`),
    );
  }
  return found;
}

function xResiduals(snap: GeomSnapshot, tree: FigmaGeomTree, pairs: GeomMatch[]): Candidate[] {
  const cw = snap.content?.w ?? snap.viewportWidth;
  const usable = pairs.filter((p) => !fullWidth(p.figma.box.w, tree.frame.w) && !fullWidth(p.dom.box.w, cw));
  const found: Candidate[] = [];
  for (const row of sameRows(usable)) {
    if (row.length < MIN_PAIRS) continue;
    const ordered = row.slice().sort((a, b) => a.figma.box.x - b.figma.box.x || a.figma.box.y - b.figma.box.y);
    for (let i = 1; i < ordered.length - 1; i++) {
      const prev = ordered[i - 1];
      const next = ordered[i + 1];
      const cur = ordered[i];
      const span = next.figma.box.x - prev.figma.box.x;
      if (span < 8) continue;
      const t = (cur.figma.box.x - prev.figma.box.x) / span;
      const pred = prev.dom.box.x + t * (next.dom.box.x - prev.dom.box.x);
      const delta = Math.abs(cur.dom.box.x - pred);
      const floor = Math.max(X_ABS, cw * X_REL);
      if (delta <= floor) continue;
      found.push(
        candidate(snap, cur, 'figma-x', pred, delta, `Vị trí ngang lệch design ≈ ${Math.round(delta)}px (nội suy trong cùng hàng)`),
      );
    }
  }
  return found;
}

const ROW_TOL = 48;

/** A design row: same Figma y-band and the DOM nodes also share a y-band. */
function sameRows(pairs: GeomMatch[]): GeomMatch[][] {
  const sorted = pairs.slice().sort((a, b) => a.figma.box.y - b.figma.box.y);
  const rows: GeomMatch[][] = [];
  let cur: GeomMatch[] = [];
  for (const p of sorted) {
    if (!cur.length || Math.abs(p.figma.box.y - cur[0].figma.box.y) <= ROW_TOL) cur.push(p);
    else {
      rows.push(cur);
      cur = [p];
    }
  }
  if (cur.length) rows.push(cur);
  return rows.filter((row) => {
    const ys = row.map((p) => p.dom.box.y);
    return Math.max(...ys) - Math.min(...ys) <= ROW_TOL;
  });
}

function mediaAspect(
  snap: GeomSnapshot,
  media: Array<{ figma: { id: string; box: { w: number; h: number } }; dom: import('../types.js').GeomNode; via: GeomMatch }>,
): Candidate[] {
  const found: Candidate[] = [];
  for (const m of media) {
    const fa = m.figma.box.h > 0 ? m.figma.box.w / m.figma.box.h : 0;
    const da = m.dom.media?.aspect ?? (m.dom.box.h > 0 ? m.dom.box.w / m.dom.box.h : 0);
    if (fa < 0.2 || da < 0.2) continue;
    const delta = Math.abs(da - fa);
    const floor = Math.max(ASPECT_ABS, Math.max(fa, da) * ASPECT_REL);
    if (delta <= floor) continue;
    found.push({
      kind: 'figma-dom',
      status: 'candidate',
      id: `figma-dom:aspect:${m.dom.id}`,
      nodeId: m.dom.id,
      locator: m.dom.locator,
      box: m.dom.box,
      summary: `Tỷ lệ ảnh ${da.toFixed(2)} vs Figma ${fa.toFixed(2)} (neo chữ "${m.via.figma.text}")`,
      evidence: {
        groupKey: `figma-aspect:${m.via.figma.id}`,
        howGrouped: 'figma-aspect',
        signature: m.dom.signature,
        value: da,
        groupMedian: fa,
        delta,
        peers: [{ id: `figma:${m.figma.id}`, locator: `figma:${m.figma.id}`, box: m.dom.box, value: fa }],
        viewportWidth: snap.viewportWidth,
        viewportHeight: snap.viewportHeight,
      },
    });
  }
  return found;
}

function candidate(snap: GeomSnapshot, pair: GeomMatch, axis: 'figma-y' | 'figma-x', pred: number, delta: number, summary: string): Candidate {
  const value = axis === 'figma-y' ? pair.dom.box.y : pair.dom.box.x;
  return {
    kind: 'figma-dom',
    status: 'candidate',
    id: `figma-dom:${axis}:${pair.dom.id}`,
    nodeId: pair.dom.id,
    locator: pair.dom.locator,
    box: pair.dom.box,
    summary,
    evidence: {
      groupKey: `${axis}:${pair.figma.id}`,
      howGrouped: axis,
      signature: pair.dom.signature,
      value,
      groupMedian: pred,
      delta,
      peers: [
        { id: `figma:${pair.figma.id}`, locator: `figma:${pair.figma.id}`, box: pair.dom.box, value: pred },
        { id: pair.dom.id, locator: pair.dom.locator, box: pair.dom.box, value },
      ],
      viewportWidth: snap.viewportWidth,
      viewportHeight: snap.viewportHeight,
    },
  };
}
