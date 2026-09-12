import type { Candidate } from './candidate.js';

const KEEP = 0.35;
const FIGMA_POS_CENTER = 80;

/**
 * Drop weak candidates before AI. Raw list is left intact by the caller.
 * Score is relative deviation from the group center, damped for chrome and tiny deltas.
 */
export function rankCandidates(raw: Candidate[]): Candidate[] {
  return raw
    .map((c) => {
      const isFigma = c.kind === 'figma-dom';
      const isAspect = c.kind === 'aspect-ratio' || c.evidence.howGrouped === 'figma-aspect';
      const center = isFigma
        ? isAspect
          ? Math.max(Math.abs(c.evidence.groupMedian) * 0.15, 0.12)
          : FIGMA_POS_CENTER
        : Math.max(Math.abs(c.evidence.groupMedian), c.kind === 'aspect-ratio' ? 0.2 : 8);
      let score = Math.min(1, c.evidence.delta / center);
      if (!isAspect && !isFigma && c.evidence.delta < 6) score *= 0.45;
      if (!isFigma && c.evidence.peers.length < 3) score *= 0.4;
      if (/header|footer|nav/i.test(c.locator)) score *= 0.5;
      const keep = score >= KEEP;
      return {
        ...c,
        rank: Number(score.toFixed(3)),
        rankWhy: keep ? `Δ ${c.evidence.delta.toFixed(2)} / center ${center.toFixed(2)}` : `yếu (score ${score.toFixed(2)} < ${KEEP})`,
        keep,
      };
    })
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
}

export function strongCandidates(ranked: Candidate[]): Candidate[] {
  return ranked.filter((c) => c.keep);
}
