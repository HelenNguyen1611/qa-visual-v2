import type { GeomNode, GeomSnapshot } from './types.js';
import type { FigmaGeomNode, FigmaGeomTree } from './figmaTree.js';
import { isChrome } from './detectors/shared.js';

export interface GeomMatch {
  figma: FigmaGeomNode;
  dom: GeomNode;
  score: number;
  how: 'text-unique';
}

export interface MediaMatch {
  figma: FigmaGeomNode;
  dom: GeomNode;
  via: GeomMatch;
  how: 'nearby-text';
}

export interface MatchStats {
  figmaText: number;
  domText: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  media: number;
}

export interface MatchResult {
  pairs: GeomMatch[];
  media: MediaMatch[];
  stats: MatchStats;
}

const MIN_SCORE = 0.72;
const MIN_MARGIN = 0.18;

/** Short / generic labels that appear many times — only pair when both sides have exactly one copy. */
const GENERIC = /^(learn more|read more|click here|submit|next|back|home|contact us|see more|get started|sign up|log in|login)$/i;

export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(s.split(' ').filter((t) => t.length > 2));
}

/** 0 when the strings are too thin to trust. No AI — string overlap only. */
export function textScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 12 && b.length >= 12 && (a.startsWith(b) || b.startsWith(a))) return 0.88;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size < 2 || tb.size < 2) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  const j = hit / Math.max(ta.size, tb.size);
  return j >= 0.7 ? j : 0;
}

function usableDom(n: GeomNode): boolean {
  if (n.ariaHidden || !n.text) return false;
  if (n.kind === 'media') return false;
  return normText(n.text).length >= 4;
}

function countNorm(items: Array<{ text?: string }>, key: string): number {
  let n = 0;
  for (const it of items) if (it.text && normText(it.text) === key) n++;
  return n;
}

/**
 * Pair Figma TEXT to DOM nodes. A pair is kept only when the best score is
 * strong and clearly better than the runner-up — same rule as URL ↔ frame.
 */
export function matchFigmaToDom(snap: GeomSnapshot, tree: FigmaGeomTree): MatchResult {
  const figmaTexts = tree.nodes.filter((n) => n.text);
  const domTexts = snap.nodes.filter(usableDom);
  const pairs: GeomMatch[] = [];
  let ambiguous = 0;

  const scored: Array<{ f: FigmaGeomNode; d: GeomNode; s: number }> = [];
  for (const f of figmaTexts) {
    const nf = normText(f.text!);
    const generic = nf.length < 10 || GENERIC.test(nf);
    if (generic && (countNorm(figmaTexts, nf) !== 1 || countNorm(domTexts, nf) !== 1)) continue;
    for (const d of domTexts) {
      if (isChrome(d) && nf.length < 24) continue;
      // A section's textContent is the concatenation of children — pairing it to a Figma TEXT
      // invents a box that is the wrapper, not the line.
      if (d.kind === 'section' || d.kind === 'container') continue;
      let s = textScore(nf, normText(d.text!));
      if (s <= 0) continue;
      if (d.kind === 'heading' && (f.fontSize ?? 0) >= 20) s = Math.min(1, s + 0.04);
      scored.push({ f, d, s });
    }
  }
  scored.sort((a, b) => b.s - a.s);

  const usedF = new Set<string>();
  const usedD = new Set<string>();
  for (const row of scored) {
    if (usedF.has(row.f.id) || usedD.has(row.d.id)) continue;
    const rivals = scored.filter((x) => x.f.id === row.f.id && x.d.id !== row.d.id);
    const second = rivals[0]?.s ?? 0;
    if (row.s < MIN_SCORE || row.s - second < MIN_MARGIN) {
      if (row.s >= MIN_SCORE) ambiguous++;
      continue;
    }
    usedF.add(row.f.id);
    usedD.add(row.d.id);
    pairs.push({ figma: row.f, dom: row.d, score: Number(row.s.toFixed(3)), how: 'text-unique' });
  }

  const media = matchNearbyMedia(snap, tree, pairs);
  return {
    pairs,
    media,
    stats: {
      figmaText: figmaTexts.length,
      domText: domTexts.length,
      matched: pairs.length,
      ambiguous,
      unmatched: Math.max(0, figmaTexts.length - pairs.length),
      media: media.length,
    },
  };
}

function center(b: { x: number; y: number; w: number; h: number }) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function near(anchor: { x: number; y: number; w: number; h: number }, m: { x: number; y: number; w: number; h: number }): boolean {
  const ac = center(anchor);
  const mc = center(m);
  const below = m.y >= anchor.y - 8 && m.y <= anchor.y + anchor.h + 220;
  const closeX = Math.abs(mc.x - ac.x) <= Math.max(anchor.w, m.w) * 0.85 + 40;
  return below && closeX && m.w >= 24 && m.h >= 24;
}

/** Exactly one image next to a matched title on both sides → pair. */
export function matchNearbyMedia(snap: GeomSnapshot, tree: FigmaGeomTree, pairs: GeomMatch[]): MediaMatch[] {
  const figmaImgs = tree.nodes.filter((n) => n.hasImageFill);
  const domImgs = snap.nodes.filter((n) => n.media && !n.ariaHidden && n.box.w >= 24 && n.box.h >= 24);
  const out: MediaMatch[] = [];
  const usedF = new Set<string>();
  const usedD = new Set<string>();

  for (const p of pairs) {
    const fNear = figmaImgs.filter((n) => !usedF.has(n.id) && near(p.figma.box, n.box));
    const dNear = domImgs.filter((n) => !usedD.has(n.id) && near(p.dom.box, n.box));
    if (fNear.length !== 1 || dNear.length !== 1) continue;
    usedF.add(fNear[0].id);
    usedD.add(dNear[0].id);
    out.push({ figma: fNear[0], dom: dNear[0], via: p, how: 'nearby-text' });
  }
  return out;
}
