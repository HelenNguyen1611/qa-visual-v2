import type { GeomNode } from './types.js';

/**
 * Shared comparison helpers for later detectors.
 *
 * Detectors are not here. This file only answers: which nodes are the same kind of thing,
 * and which numeric values sit outside a group after ignoring render noise.
 */

/** Sub-pixel / rounding slack used when the caller does not pass a tighter abs. */
export const RENDER_ABS = 2;
/** 2% of the group's center — a 100px gap vs 101px is not an outlier. */
export const RENDER_REL = 0.02;
export const MIN_GROUP = 3;

export function nearlyEqual(a: number, b: number, abs = RENDER_ABS, rel = RENDER_REL): boolean {
  const d = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return d <= abs || d <= scale * rel;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation from the median. 0 when every value is the same. */
export function mad(values: number[]): number {
  if (!values.length) return 0;
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

export interface Outlier {
  index: number;
  value: number;
  center: number;
  delta: number;
}

export interface OutlierOpts {
  abs?: number;
  rel?: number;
  minGroup?: number;
  /** Distance from the median, in MAD units. Default 2.5. */
  k?: number;
}

/**
 * Values that sit away from the group after a pixel/relative floor.
 *
 * A lone 2px drift against a tight cluster is render noise, not an outlier.
 * A group of two cannot name a minority, so it never flags.
 */
export function findOutliers(values: number[], opts: OutlierOpts = {}): Outlier[] {
  const abs = opts.abs ?? RENDER_ABS;
  const rel = opts.rel ?? RENDER_REL;
  const minGroup = opts.minGroup ?? MIN_GROUP;
  const k = opts.k ?? 2.5;
  if (values.length < minGroup) return [];

  const center = median(values);
  const spread = mad(values);
  // 1.4826: MAD → σ for a normal distribution. When spread is 0, only the abs/rel floor remains.
  const stat = spread > 0 ? k * 1.4826 * spread : 0;
  const floor = Math.max(abs, Math.abs(center) * rel, stat);

  const out: Outlier[] = [];
  for (let i = 0; i < values.length; i++) {
    const delta = Math.abs(values[i] - center);
    if (delta <= floor) continue;
    out.push({ index: i, value: values[i], center, delta });
  }
  return out;
}

export interface EquivalentGroup {
  key: string;
  parentId?: string;
  signature: string;
  nodes: GeomNode[];
}

export function equivalentKey(node: GeomNode): string {
  return `${node.parentId ?? 'root'}::${node.signature}`;
}

/**
 * Nodes that share a parent and a signature — repeated cards, tiles, list rows.
 * Hidden carousel slides stay out by default so stacked copies do not look like a set.
 */
export function groupEquivalent(nodes: GeomNode[], opts: { skipHidden?: boolean } = {}): EquivalentGroup[] {
  const skipHidden = opts.skipHidden !== false;
  const buckets = new Map<string, GeomNode[]>();
  for (const n of nodes) {
    if (skipHidden && n.ariaHidden) continue;
    const key = equivalentKey(n);
    const list = buckets.get(key) ?? [];
    list.push(n);
    buckets.set(key, list);
  }
  const groups: EquivalentGroup[] = [];
  for (const [key, list] of buckets) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.siblingIndex - b.siblingIndex || a.box.y - b.box.y || a.box.x - b.box.x);
    groups.push({ key, parentId: list[0].parentId, signature: list[0].signature, nodes: list });
  }
  return groups;
}

/**
 * Class tokens with BEM-style `--modifier` stripped so a wide/featured card
 * still counts as the same repeated component as its siblings.
 */
export function stemClasses(node: GeomNode): string[] {
  const raw = (node.classes.length ? node.classes : (node.signature.split('|')[1] ?? '').split('.')).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    const cut = c.indexOf('--');
    const stem = cut === -1 ? c : c.slice(0, cut);
    if (!stem || seen.has(stem)) continue;
    seen.add(stem);
    out.push(stem);
  }
  return out.sort();
}

export function roleSignature(node: GeomNode): string {
  return `${node.tag}|${stemClasses(node).join('.')}`;
}

export function roleKey(node: GeomNode): string {
  return `${node.parentId ?? 'root'}::${roleSignature(node)}`;
}

/**
 * Repeated siblings that play the same role, even when one card carries a
 * modifier class (`--wide`, `--featured`) that makes the exact signature differ.
 */
export function groupByRole(nodes: GeomNode[], opts: { skipHidden?: boolean } = {}): EquivalentGroup[] {
  const skipHidden = opts.skipHidden !== false;
  const buckets = new Map<string, GeomNode[]>();
  for (const n of nodes) {
    if (skipHidden && n.ariaHidden) continue;
    const key = roleKey(n);
    const list = buckets.get(key) ?? [];
    list.push(n);
    buckets.set(key, list);
  }
  const groups: EquivalentGroup[] = [];
  for (const [key, list] of buckets) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.siblingIndex - b.siblingIndex || a.box.y - b.box.y || a.box.x - b.box.x);
    groups.push({ key, parentId: list[0].parentId, signature: roleSignature(list[0]), nodes: list });
  }
  return groups;
}

function isUnder(node: GeomNode, ancestorId: string, byId: Map<string, GeomNode>): boolean {
  let cur: GeomNode | undefined = node;
  const seen = new Set<string>();
  while (cur) {
    if (cur.id === ancestorId) return true;
    if (!cur.parentId || seen.has(cur.id)) return false;
    seen.add(cur.id);
    cur = byId.get(cur.parentId);
  }
  return false;
}

/**
 * The first visible media that belongs to a card — direct child or nested —
 * so a wrapper between card and image does not hide the slot.
 */
export function primaryMediaOf(
  parent: GeomNode,
  nodes: GeomNode[],
  usable: (n: GeomNode) => boolean,
): GeomNode | undefined {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes
    .filter((n) => usable(n) && isUnder(n, parent.id, byId))
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x || a.siblingIndex - b.siblingIndex)[0];
}

export function childrenOf(parentId: string, nodes: GeomNode[]): GeomNode[] {
  return nodes
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.siblingIndex - b.siblingIndex || a.box.y - b.box.y || a.box.x - b.box.x);
}

export interface ChildSlot {
  /** signature, or signature#i when a parent has several children with the same signature */
  key: string;
  /** one entry per parent, same order as `parents` — missing child is undefined */
  nodes: Array<GeomNode | undefined>;
}

function slotKey(child: GeomNode, siblings: GeomNode[]): string {
  const same = siblings.filter((s) => s.signature === child.signature);
  if (same.length <= 1) return child.signature;
  return `${child.signature}#${same.findIndex((s) => s.id === child.id)}`;
}

/**
 * Line up corresponding children of repeated parents (image of each card, title of each card).
 * Used later for gap-between-matching-elements, not for total card height.
 */
export function alignChildSlots(parents: GeomNode[], nodes: GeomNode[]): ChildSlot[] {
  if (parents.length < 2) return [];
  const perParent = parents.map((p) => childrenOf(p.id, nodes));
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const kids of perParent) {
    for (const kid of kids) {
      const key = slotKey(kid, kids);
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys.map((key) => ({
    key,
    nodes: perParent.map((kids) => kids.find((kid) => slotKey(kid, kids) === key)),
  }));
}

/** Vertical gap from the bottom of `a` to the top of `b`. Negative means they overlap. */
export function gapY(a: GeomNode, b: GeomNode): number {
  return b.box.y - (a.box.y + a.box.h);
}

export function gapX(a: GeomNode, b: GeomNode): number {
  return b.box.x - (a.box.x + a.box.w);
}
