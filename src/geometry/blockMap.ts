import type { GeomBox, GeomNode, GeomSnapshot } from './types.js';
import type { FigmaGeomNode, FigmaGeomTree } from './figmaTree.js';
import type { GeomMatch } from './match.js';

export interface Sides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type BlockLevel = 'text-wrapper' | 'content-column' | 'multi-column' | 'section';

export interface BlockSkip {
  reason: string;
  texts: string[];
  figmaId?: string;
  figmaName?: string;
  figmaLevel?: BlockLevel;
  domLocator?: string;
  domLevel?: BlockLevel;
  figmaBox?: GeomBox;
  domBox?: GeomBox;
  widthRatio?: number;
  parentFigmaId?: string;
  parentFigmaName?: string;
  parentFigmaLevel?: BlockLevel;
  parentDomLocator?: string;
  parentDomLevel?: BlockLevel;
}

export interface BlockMatch {
  figma: FigmaGeomNode;
  dom: GeomNode;
  confidence: number;
  anchors: GeomMatch[];
  figmaPad: Sides;
  domPad: Sides;
  scale: number;
  figmaLevel: BlockLevel;
  domLevel: BlockLevel;
  widthRatio: number;
}

export interface ChildInsetMatch {
  child: BlockMatch;
  parentFigma: FigmaGeomNode;
  parentDom: GeomNode;
  parentFigmaLevel: BlockLevel;
  parentDomLevel: BlockLevel;
  parentWidthRatio: number;
  figmaInset: Sides;
  domInset: Sides;
  confidence: number;
}

export interface LayoutOwnerMatch {
  figma: FigmaGeomNode;
  dom: GeomNode;
  confidence: number;
  anchors: GeomMatch[];
  figmaPad: Sides;
  domPad: Sides;
  scale: number;
  figmaLevel: BlockLevel;
  domLevel: BlockLevel;
  widthRatio: number;
  role: 'layout-owner';
  why: string;
}

export interface BlockMapResult {
  blocks: BlockMatch[];
  skipped: BlockSkip[];
  insets: ChildInsetMatch[];
  insetSkipped: BlockSkip[];
  owners: LayoutOwnerMatch[];
  ownerSkipped: BlockSkip[];
}

const STRUCT = /^(FRAME|GROUP|COMPONENT|INSTANCE|SECTION)$/;

export function insetOf(parent: GeomBox, kids: GeomBox[]): Sides {
  if (!kids.length) return { top: 0, right: 0, bottom: 0, left: 0 };
  const minX = Math.min(...kids.map((k) => k.x));
  const minY = Math.min(...kids.map((k) => k.y));
  const maxR = Math.max(...kids.map((k) => k.x + k.w));
  const maxB = Math.max(...kids.map((k) => k.y + k.h));
  return {
    left: Math.max(0, Math.round(minX - parent.x)),
    top: Math.max(0, Math.round(minY - parent.y)),
    right: Math.max(0, Math.round(parent.x + parent.w - maxR)),
    bottom: Math.max(0, Math.round(parent.y + parent.h - maxB)),
  };
}

export function scaleSides(s: Sides, scale: number): Sides {
  return {
    top: round1(s.top * scale),
    right: round1(s.right * scale),
    bottom: round1(s.bottom * scale),
    left: round1(s.left * scale),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function contains(outer: GeomBox, inner: GeomBox, slack = 2): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.w <= outer.x + outer.w + slack &&
    inner.y + inner.h <= outer.y + outer.h + slack
  );
}

function pageLike(box: GeomBox, page: GeomBox): boolean {
  return box.w >= page.w * 0.88 && box.h >= page.h * 0.35;
}

function unionWidth(boxes: GeomBox[]): number {
  return Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x));
}

function unionHeight(boxes: GeomBox[]): number {
  return Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y));
}

function unionBox(boxes: GeomBox[]): GeomBox {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

function visualKids<T extends { id: string; box: GeomBox }>(parent: T, nodes: T[]): T[] {
  return nodes.filter((n) => {
    if (n.id === parent.id || !contains(parent.box, n.box)) return false;
    return !nodes.some(
      (mid) =>
        mid.id !== n.id &&
        mid.id !== parent.id &&
        contains(parent.box, mid.box) &&
        contains(mid.box, n.box) &&
        mid.box.w * mid.box.h < parent.box.w * parent.box.h,
    );
  });
}

/** Distinct x-bands among sizable children. */
export function columnCount(boxes: GeomBox[]): number {
  const substantial = boxes.filter((b) => b.w >= 40 && b.h >= 20);
  if (substantial.length < 2) return 1;
  const sorted = substantial.slice().sort((a, b) => a.x - b.x);
  let cols = 1;
  let right = sorted[0].x + sorted[0].w;
  for (const b of sorted.slice(1)) {
    if (b.x >= right - 8) {
      cols++;
      right = b.x + b.w;
    } else right = Math.max(right, b.x + b.w);
  }
  return cols;
}

export function classifyBlock(
  box: GeomBox,
  kids: Array<{ box: GeomBox; media?: boolean }>,
  anchors: GeomBox[],
): BlockLevel {
  const texts = anchors.length ? anchors : kids.map((k) => k.box);
  const widthFill = box.w > 0 ? unionWidth(texts) / box.w : 0;
  const occ = box.w * box.h > 0 ? (unionWidth(texts) * unionHeight(texts)) / (box.w * box.h) : 0;
  const kidBoxes = kids.length ? kids.map((k) => k.box) : texts;
  const cols = columnCount(kidBoxes);
  const hasMedia = kids.some((k) => k.media);

  if (cols >= 2) return hasMedia || widthFill < 0.7 ? 'section' : 'multi-column';
  if (hasMedia && widthFill < 0.72) return 'section';
  if (widthFill >= 0.75 && occ >= 0.28 && !hasMedia) return 'text-wrapper';
  if (widthFill >= 0.65 && cols === 1 && !hasMedia) return 'content-column';
  if (widthFill < 0.55 || hasMedia) return 'section';
  return 'content-column';
}

function closeLevels(a: BlockLevel, b: BlockLevel): boolean {
  if (a === b) return true;
  return (
    (a === 'text-wrapper' && b === 'content-column') || (a === 'content-column' && b === 'text-wrapper')
  );
}

export function levelsCompatible(
  figmaLevel: BlockLevel,
  domLevel: BlockLevel,
  figmaBox: GeomBox,
  domBox: GeomBox,
  scale: number,
): { ok: boolean; reason?: string; widthRatio: number } {
  const widthRatio = figmaBox.w * scale > 0 ? domBox.w / (figmaBox.w * scale) : 0;
  if (widthRatio < 0.7 || widthRatio > 1.45) return { ok: false, reason: 'level-mismatch:width-ratio', widthRatio };
  if (!closeLevels(figmaLevel, domLevel)) return { ok: false, reason: `level-mismatch:${figmaLevel}≠${domLevel}`, widthRatio };
  if ((figmaLevel === 'section' || figmaLevel === 'multi-column') && figmaLevel !== domLevel) {
    return { ok: false, reason: `level-mismatch:${figmaLevel}≠${domLevel}`, widthRatio };
  }
  return { ok: true, widthRatio };
}

function headingOffset(anchors: GeomBox[], block: GeomBox): number {
  const h = anchors.slice().sort((a, b) => a.y - b.y || a.x - b.x)[0];
  if (!h || block.w <= 0) return 0;
  return (h.x - block.x) / block.w;
}

function isMediaNode(n: FigmaGeomNode | GeomNode): boolean {
  return Boolean(('hasImageFill' in n && n.hasImageFill) || ('media' in n && n.media) || ('kind' in n && n.kind === 'media'));
}

function smallestContaining<T extends { id: string; box: GeomBox }>(
  items: T[],
  targets: GeomBox[],
  page: GeomBox,
): T | undefined {
  const hits = items.filter((n) => !pageLike(n.box, page) && targets.every((t) => contains(n.box, t)));
  hits.sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h);
  const best = hits[0];
  if (!best) return undefined;
  if (unionWidth(targets) < best.box.w * 0.55) return undefined;
  return best;
}

/**
 * Pair the tightest same-level wrappers around mapped heading+body texts.
 * Does not climb a parent just because that parent has padding.
 */
export function mapBlocks(snap: GeomSnapshot, tree: FigmaGeomTree, pairs: GeomMatch[]): BlockMapResult {
  const scale = tree.frame.w > 0 ? snap.viewportWidth / tree.frame.w : 1;
  const pageDom: GeomBox = { x: 0, y: 0, w: snap.viewportWidth, h: snap.pageHeight };
  const figmaBlocks = tree.nodes.filter((n) => STRUCT.test(n.type));
  const skipped: BlockSkip[] = [];
  const blocks: BlockMatch[] = [];
  const usedF = new Set<string>();
  const usedD = new Set<string>();

  const candidates: Array<{ frame: FigmaGeomNode; anchors: GeomMatch[] }> = [];
  for (const frame of figmaBlocks) {
    if (pageLike(frame.box, tree.frame)) continue;
    const anchors = pairs.filter((p) => contains(frame.box, p.figma.box));
    if (anchors.length < 2) continue;
    if (unionWidth(anchors.map((a) => a.figma.box)) < frame.box.w * 0.55) continue;
    candidates.push({ frame, anchors });
  }
  candidates.sort((a, b) => a.frame.box.w * a.frame.box.h - b.frame.box.w * b.frame.box.h);

  for (const c of candidates) {
    if (c.anchors.some((a) => usedF.has(a.figma.id))) continue;
    const texts = c.anchors.map((a) => a.figma.text ?? '');
    const fKids = visualKids(c.frame, tree.nodes);
    const figmaLevel = classifyBlock(
      c.frame.box,
      fKids.map((n) => ({ box: n.box, media: isMediaNode(n) })),
      c.anchors.map((a) => a.figma.box),
    );

    const dom = smallestContaining(
      snap.nodes.filter((n) => n.kind !== 'media' && !n.ariaHidden),
      c.anchors.map((a) => a.dom.box),
      pageDom,
    );
    if (!dom) {
      skipped.push({
        reason: 'dom-block-missing',
        texts,
        figmaId: c.frame.id,
        figmaName: c.frame.name,
        figmaLevel,
        figmaBox: c.frame.box,
      });
      continue;
    }
    if (usedD.has(dom.id)) continue;

    const dKids = visualKids(dom, snap.nodes);
    const domLevel = classifyBlock(
      dom.box,
      dKids.map((n) => ({ box: n.box, media: isMediaNode(n) })),
      c.anchors.map((a) => a.dom.box),
    );
    const fit = levelsCompatible(figmaLevel, domLevel, c.frame.box, dom.box, scale);
    const fOff = headingOffset(c.anchors.map((a) => a.figma.box), c.frame.box);
    const dOff = headingOffset(c.anchors.map((a) => a.dom.box), dom.box);
    const offsetMismatch = Math.abs(fOff - dOff) > 0.22;

    if (!fit.ok || offsetMismatch) {
      skipped.push({
        reason: offsetMismatch ? 'level-mismatch:heading-offset' : (fit.reason ?? 'level-mismatch'),
        texts,
        figmaId: c.frame.id,
        figmaName: c.frame.name,
        figmaLevel,
        domLocator: dom.locator,
        domLevel,
        figmaBox: c.frame.box,
        domBox: dom.box,
        widthRatio: Number(fit.widthRatio.toFixed(3)),
      });
      continue;
    }

    const confidence = Math.min(...c.anchors.map((a) => a.score));
    if (confidence < 0.72) {
      skipped.push({ reason: `confidence ${confidence.toFixed(2)}`, texts, figmaId: c.frame.id, figmaLevel, domLevel });
      continue;
    }

    const rawFigma = c.frame.padding ?? insetOf(c.frame.box, fKids.length ? fKids.map((n) => n.box) : c.anchors.map((a) => a.figma.box));
    const domPad = insetOf(dom.box, dKids.length ? dKids.map((n) => n.box) : c.anchors.map((a) => a.dom.box));

    for (const a of c.anchors) usedF.add(a.figma.id);
    usedD.add(dom.id);
    blocks.push({
      figma: c.frame,
      dom,
      confidence: Number(confidence.toFixed(3)),
      anchors: c.anchors,
      figmaPad: scaleSides(rawFigma, scale),
      domPad,
      scale,
      figmaLevel,
      domLevel,
      widthRatio: Number(fit.widthRatio.toFixed(3)),
    });
  }

  const related = mapChildInsets(snap, tree, blocks);
  const owners = mapLayoutOwners(snap, tree, pairs, blocks);
  return {
    blocks,
    skipped,
    insets: related.pairs,
    insetSkipped: related.skipped,
    owners: owners.pairs,
    ownerSkipped: owners.skipped,
  };
}

function hasSide(s: Sides | undefined, min = 2): boolean {
  if (!s) return false;
  return s.top >= min || s.right >= min || s.bottom >= min || s.left >= min;
}

function ownsLayout(
  node: { box: GeomBox; padding?: Sides },
  kids: Array<FigmaGeomNode | GeomNode>,
): { ok: boolean; why: string; pad: Sides } {
  const kidBoxes = kids.map((k) => k.box);
  const pad = node.padding ?? insetOf(node.box, kidBoxes);
  if (!hasSide(pad, 2)) return { ok: false, why: 'no-explicit-inset', pad };
  const mediaKids = kids.filter((k) => isMediaNode(k));
  const copy = kids.filter((k) => !isMediaNode(k) && k.box.w >= 40 && k.box.h >= 20);
  const selfMedia = isMediaNode(node as FigmaGeomNode | GeomNode);
  if ((!mediaKids.length && !selfMedia) || !copy.length) return { ok: false, why: 'no-media-content-siblings', pad };
  return { ok: true, why: 'explicit-padding+media-content', pad };
}

function figmaLayoutOwner(
  anchors: GeomMatch[],
  tree: FigmaGeomTree,
  page: GeomBox,
): { node: FigmaGeomNode; level: BlockLevel; kids: FigmaGeomNode[]; why: string; pad: Sides } | undefined {
  const structs = tree.nodes
    .filter(
      (n) =>
        STRUCT.test(n.type) &&
        anchors.every((a) => contains(n.box, a.figma.box)) &&
        !pageLike(n.box, page),
    )
    .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h);

  for (const node of structs) {
    const kids = visualKids(node, tree.nodes);
    const owned = ownsLayout(node, kids);
    if (!owned.ok) continue;
    return {
      node,
      level: classifyMapped(node.box, kids, anchors.map((a) => a.figma.box)),
      kids,
      why: owned.why,
      pad: node.padding ?? owned.pad,
    };
  }
  return undefined;
}

function domLayoutOwner(
  anchors: GeomMatch[],
  snap: GeomSnapshot,
  page: GeomBox,
): { node: GeomNode; level: BlockLevel; kids: GeomNode[] } | undefined {
  const cands = snap.nodes
    .filter(
      (n) =>
        n.kind !== 'media' &&
        !n.ariaHidden &&
        anchors.every((a) => contains(n.box, a.dom.box)) &&
        !pageLike(n.box, page) &&
        hasSide(n.padding, 2),
    )
    .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h);

  for (const node of cands) {
    const kids = visualKids(node, snap.nodes);
    const media = snap.nodes.filter((m) => isMediaNode(m) && contains(node.box, m.box));
    const textUnion = unionBox(anchors.map((a) => a.dom.box));
    const mediaBeside = media.filter((m) => !contains(textUnion, m.box, 8));
    const copy = kids.filter((k) => !isMediaNode(k) && k.box.w >= 40 && k.box.h >= 20);
    if (!mediaBeside.length || !copy.length) continue;
    return {
      node,
      level: classifyMapped(node.box, kids, anchors.map((a) => a.dom.box)),
      kids,
    };
  }
  return undefined;
}

/**
 * Map the node that owns content inset — often a padded frame with media + copy,
 * not the tightest text wrapper (whose padding is frequently 0).
 */
export function mapLayoutOwners(
  snap: GeomSnapshot,
  tree: FigmaGeomTree,
  pairs: GeomMatch[],
  blocks: BlockMatch[],
): { pairs: LayoutOwnerMatch[]; skipped: BlockSkip[] } {
  const scale = tree.frame.w > 0 ? snap.viewportWidth / tree.frame.w : 1;
  const pageDom: GeomBox = { x: 0, y: 0, w: snap.viewportWidth, h: snap.pageHeight };
  const inBlock = new Set(blocks.flatMap((b) => b.anchors.map((a) => a.figma.id)));
  const singles = pairs.filter((p) => p.score >= 0.72 && !inBlock.has(p.figma.id)).map((p) => [p]);
  const groups = [...blocks.map((b) => b.anchors), ...singles];

  const out: LayoutOwnerMatch[] = [];
  const skipped: BlockSkip[] = [];
  const usedD = new Set<string>();
  const usedF = new Set<string>();

  for (const anchors of groups) {
    if (!anchors.length) continue;
    const texts = anchors.map((a) => a.figma.text ?? '');
    const fp = figmaLayoutOwner(anchors, tree, tree.frame);
    if (!fp) {
      skipped.push({ reason: 'owner-missing:figma', texts });
      continue;
    }
    if (usedF.has(fp.node.id)) continue;
    const dp = domLayoutOwner(anchors, snap, pageDom);
    if (!dp) {
      skipped.push({
        reason: 'owner-missing:dom',
        texts,
        figmaId: fp.node.id,
        figmaName: fp.node.name,
        figmaLevel: fp.level,
        figmaBox: fp.node.box,
      });
      continue;
    }
    if (usedD.has(dp.node.id)) continue;

    const fit = levelsCompatible(fp.level, dp.level, fp.node.box, dp.node.box, scale);
    const fOff = headingOffset(anchors.map((a) => a.figma.box), fp.node.box);
    const dOff = headingOffset(anchors.map((a) => a.dom.box), dp.node.box);
    const offsetMismatch = Math.abs(fOff - dOff) > 0.22;
    if (!fit.ok || offsetMismatch) {
      skipped.push({
        reason: offsetMismatch ? 'owner-mismatch:heading-offset' : `owner-mismatch:${(fit.reason ?? 'level').replace(/^level-mismatch:/, '')}`,
        texts,
        figmaId: fp.node.id,
        figmaName: fp.node.name,
        figmaLevel: fp.level,
        domLocator: dp.node.locator,
        domLevel: dp.level,
        figmaBox: fp.node.box,
        domBox: dp.node.box,
        widthRatio: Number(fit.widthRatio.toFixed(3)),
      });
      continue;
    }

    const confidence = Math.min(...anchors.map((a) => a.score));
    if (confidence < 0.72) {
      skipped.push({ reason: `confidence ${confidence.toFixed(2)}`, texts, figmaId: fp.node.id, figmaLevel: fp.level, domLevel: dp.level });
      continue;
    }

    usedF.add(fp.node.id);
    usedD.add(dp.node.id);
    out.push({
      figma: fp.node,
      dom: dp.node,
      confidence: Number(confidence.toFixed(3)),
      anchors,
      figmaPad: fp.pad,
      domPad: dp.node.padding ?? { top: 0, right: 0, bottom: 0, left: 0 },
      scale,
      figmaLevel: fp.level,
      domLevel: dp.level,
      widthRatio: Number(fit.widthRatio.toFixed(3)),
      role: 'layout-owner',
      why: fp.why,
    });
  }

  return { pairs: out, skipped };
}

function almostSameBox(a: GeomBox, b: GeomBox, slack = 8): boolean {
  return (
    Math.abs(a.x - b.x) <= slack &&
    Math.abs(a.y - b.y) <= slack &&
    Math.abs(a.w - b.w) <= slack &&
    Math.abs(a.h - b.h) <= slack
  );
}

function childOffset(child: GeomBox, parent: GeomBox): { x: number; y: number } {
  return {
    x: parent.w > 0 ? (child.x - parent.x) / parent.w : 0,
    y: parent.h > 0 ? (child.y - parent.y) / parent.h : 0,
  };
}

function extraKids<T extends { id: string; box: GeomBox }>(parentKids: T[], child: { id: string; box: GeomBox }): T[] {
  return parentKids.filter((k) => k.id !== child.id && !contains(child.box, k.box));
}

function classifyMapped(
  box: GeomBox,
  kids: Array<FigmaGeomNode | GeomNode>,
  anchors: GeomBox[],
): BlockLevel {
  return classifyBlock(
    box,
    kids.map((n) => ({ box: n.box, media: isMediaNode(n) })),
    anchors,
  );
}

function figmaParentCandidates(
  child: BlockMatch,
  tree: FigmaGeomTree,
  page: GeomBox,
): Array<{ node: FigmaGeomNode; level: BlockLevel; kids: FigmaGeomNode[] }> {
  const structs = tree.nodes
    .filter(
      (n) =>
        STRUCT.test(n.type) &&
        n.id !== child.figma.id &&
        contains(n.box, child.figma.box) &&
        !pageLike(n.box, page) &&
        !almostSameBox(n.box, child.figma.box),
    )
    .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h);

  const out: Array<{ node: FigmaGeomNode; level: BlockLevel; kids: FigmaGeomNode[] }> = [];
  for (const node of structs) {
    const kids = visualKids(node, tree.nodes);
    const level = classifyMapped(node.box, kids, child.anchors.map((a) => a.figma.box));
    const hasExtra = extraKids(kids, child.figma).length > 0;
    if (!hasExtra && closeLevels(level, child.figmaLevel)) continue;
    out.push({ node, level, kids });
  }
  return out;
}

function domParentCandidates(child: GeomNode, snap: GeomSnapshot, page: GeomBox): GeomNode[] {
  return snap.nodes
    .filter(
      (n) =>
        n.id !== child.id &&
        n.kind !== 'media' &&
        !n.ariaHidden &&
        contains(n.box, child.box) &&
        !pageLike(n.box, page) &&
        !almostSameBox(n.box, child.box),
    )
    .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h);
}

/**
 * Pair a mapped child with a mapped parent on both sides, then measure child inset from boxes.
 * Does not compare a Figma parent to a DOM child, and does not climb only to find padding.
 */
export function mapChildInsets(
  snap: GeomSnapshot,
  tree: FigmaGeomTree,
  blocks: BlockMatch[],
): { pairs: ChildInsetMatch[]; skipped: BlockSkip[] } {
  const scale = tree.frame.w > 0 ? snap.viewportWidth / tree.frame.w : 1;
  const pageDom: GeomBox = { x: 0, y: 0, w: snap.viewportWidth, h: snap.pageHeight };
  const pairs: ChildInsetMatch[] = [];
  const skipped: BlockSkip[] = [];

  for (const child of blocks) {
    const texts = child.anchors.map((a) => a.figma.text ?? '');
    const figmaParents = figmaParentCandidates(child, tree, tree.frame);
    if (!figmaParents.length) {
      skipped.push({
        reason: 'parent-missing:figma',
        texts,
        figmaId: child.figma.id,
        figmaName: child.figma.name,
        figmaLevel: child.figmaLevel,
        domLocator: child.dom.locator,
        domLevel: child.domLevel,
        figmaBox: child.figma.box,
        domBox: child.dom.box,
      });
      continue;
    }

    const domParents = domParentCandidates(child.dom, snap, pageDom);
    let accepted: ChildInsetMatch | undefined;
    let lastReject: BlockSkip | undefined;

    for (const fp of figmaParents) {
      for (const parentDom of domParents) {
        const dKids = visualKids(parentDom, snap.nodes);
        const parentDomLevel = classifyMapped(parentDom.box, dKids, child.anchors.map((a) => a.dom.box));
        const fit = levelsCompatible(fp.level, parentDomLevel, fp.node.box, parentDom.box, scale);
        const fRel = childOffset(child.figma.box, fp.node.box);
        const dRel = childOffset(child.dom.box, parentDom.box);
        const offsetMismatch = Math.abs(fRel.x - dRel.x) > 0.22 || Math.abs(fRel.y - dRel.y) > 0.28;
        const fExtra = extraKids(fp.kids, child.figma);
        const dExtra = extraKids(dKids, child.dom);
        const childLevelParent = fExtra.length > 0 && dExtra.length === 0 && closeLevels(parentDomLevel, child.domLevel);

        if (!fit.ok || offsetMismatch || childLevelParent) {
          lastReject = {
            reason: childLevelParent
              ? 'parent-mismatch:dom-still-child-level'
              : offsetMismatch
                ? 'parent-mismatch:child-offset'
                : `parent-mismatch:${(fit.reason ?? 'level').replace(/^level-mismatch:/, '')}`,
            texts,
            figmaId: child.figma.id,
            figmaName: child.figma.name,
            figmaLevel: child.figmaLevel,
            domLocator: child.dom.locator,
            domLevel: child.domLevel,
            figmaBox: child.figma.box,
            domBox: child.dom.box,
            widthRatio: Number(fit.widthRatio.toFixed(3)),
            parentFigmaId: fp.node.id,
            parentFigmaName: fp.node.name,
            parentFigmaLevel: fp.level,
            parentDomLocator: parentDom.locator,
            parentDomLevel,
          };
          continue;
        }

        const rawInset = insetOf(fp.node.box, [child.figma.box]);
        accepted = {
          child,
          parentFigma: fp.node,
          parentDom,
          parentFigmaLevel: fp.level,
          parentDomLevel,
          parentWidthRatio: Number(fit.widthRatio.toFixed(3)),
          figmaInset: scaleSides(rawInset, scale),
          domInset: insetOf(parentDom.box, [child.dom.box]),
          confidence: child.confidence,
        };
        break;
      }
      if (accepted) break;
    }

    if (!accepted) {
      skipped.push(
        lastReject ?? {
          reason: 'parent-missing:dom',
          texts,
          figmaId: child.figma.id,
          figmaName: child.figma.name,
          figmaLevel: child.figmaLevel,
          domLocator: child.dom.locator,
          domLevel: child.domLevel,
          parentFigmaId: figmaParents[0]?.node.id,
          parentFigmaName: figmaParents[0]?.node.name,
          parentFigmaLevel: figmaParents[0]?.level,
          figmaBox: figmaParents[0]?.node.box,
        },
      );
      continue;
    }
    pairs.push(accepted);
  }

  return { pairs, skipped };
}

export function headingBodyGap(anchors: GeomMatch[]): { figma: number; dom: number } | undefined {
  if (anchors.length < 2) return undefined;
  const fs = anchors.slice().sort((a, b) => a.figma.box.y - b.figma.box.y || a.figma.box.x - b.figma.box.x);
  const a = fs[0];
  const b = fs[1];
  const stacked = b.figma.box.y >= a.figma.box.y + a.figma.box.h - 4;
  if (!stacked) return undefined;
  const figma = b.figma.box.y - (a.figma.box.y + a.figma.box.h);
  const dom = b.dom.box.y - (a.dom.box.y + a.dom.box.h);
  if (figma < 0 || dom < -8) return undefined;
  return { figma, dom };
}

export function sideFloor(figmaSide: number, containerW: number): number {
  return Math.max(2, Math.abs(figmaSide) * 0.12, containerW * 0.008);
}

export { unionBox };
