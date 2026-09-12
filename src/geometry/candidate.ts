import type { GeomBox } from './types.js';

/** A measured suspicion. Not a finding until ranking + (optional) AI judge say so. */
export type CandidateKind =
  | 'aspect-ratio'
  | 'container-alignment'
  | 'section-spacing'
  | 'sibling-alignment'
  | 'component-gap'
  | 'figma-dom';

export type JudgeVerdict = 'valid' | 'rejected' | 'uncertain';

export type ParseStatus =
  | 'ok'
  | 'uncertain-model'
  | 'id-missing'
  | 'id-mismatch'
  | 'parse-failure'
  | 'truncated'
  | 'not-judged';

export interface CandidatePeer {
  id: string;
  locator: string;
  box: GeomBox;
  value: number;
}

export interface CandidateEvidence {
  groupKey: string;
  howGrouped: string;
  parentId?: string;
  signature: string;
  value: number;
  groupMedian: number;
  delta: number;
  peers: CandidatePeer[];
  viewportWidth: number;
  viewportHeight: number;
  figmaId?: string;
  figmaValue?: number;
  confidence?: number;
  sides?: Record<string, { figma: number; dom: number; delta: number }>;
  parentFigmaId?: string;
  childFigmaId?: string;
  parentLocator?: string;
  childLocator?: string;
  structuralRole?: string;
}

export interface Candidate {
  kind: CandidateKind;
  status: 'candidate';
  id: string;
  nodeId: string;
  locator: string;
  box: GeomBox;
  summary: string;
  evidence: CandidateEvidence;
  crop?: string;
  rank?: number;
  rankWhy?: string;
  keep?: boolean;
  verdict?: JudgeVerdict;
  verdictWhy?: string;
  /** How the verdict was obtained — not a quality judgment. */
  parseStatus?: ParseStatus;
}

export function peersOf(nodes: Array<{ id: string; locator: string; box: GeomBox }>, values: number[]): CandidatePeer[] {
  return nodes.map((n, i) => ({ id: n.id, locator: n.locator, box: n.box, value: values[i] }));
}
