import type { GeomSnapshot } from './types.js';
import type { Candidate } from './candidate.js';
import type { FigmaGeomTree } from './figmaTree.js';
import { detectAspectRatio } from './detectors/aspectRatio.js';
import { detectContainerAlignment } from './detectors/containerAlignment.js';
import { detectSectionSpacing } from './detectors/sectionSpacing.js';
import { detectSiblingAlignment } from './detectors/siblingAlignment.js';
import { detectComponentGap } from './detectors/componentGap.js';
import { detectFigmaDom } from './detectors/figmaDom.js';

export const GEOMETRY_CAPABILITIES = [
  { id: 'aspect-ratio', label: 'Aspect ratio' },
  { id: 'container-alignment', label: 'Container alignment' },
  { id: 'section-spacing', label: 'Section spacing' },
  { id: 'sibling-alignment', label: 'Sibling alignment' },
  { id: 'component-gap', label: 'Component gap' },
  { id: 'figma-dom', label: 'Figma ↔ DOM geometry' },
] as const;

export function detectAllGeometry(snap: GeomSnapshot, figma?: FigmaGeomTree): Candidate[] {
  const found = [
    ...detectAspectRatio(snap),
    ...detectContainerAlignment(snap),
    ...detectSectionSpacing(snap),
    ...detectSiblingAlignment(snap),
    ...detectComponentGap(snap),
  ];
  if (figma) found.push(...detectFigmaDom(snap, figma));
  return found;
}
