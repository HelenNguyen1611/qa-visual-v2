import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { annotateCrop } from '../annotate.js';
import type { Candidate } from './candidate.js';

/** Crop a window around the candidate box — context, not the whole page. */
export function attachCrops(candidates: Candidate[], shotFile: string, runDir: string, pageDir: string, viewport: string): Candidate[] {
  return candidates.map((c, i) => {
    const res = annotateCrop(shotFile, c.box, i + 1, join(pageDir, `${viewport}.g${i + 1}.png`), 160);
    if (!res) return c;
    return { ...c, crop: relative(runDir, res.file) };
  });
}

export function cropAsImage(runDir: string, crop: string | undefined): { b64: string; mime: 'image/png' } | undefined {
  if (!crop) return undefined;
  try {
    return { b64: readFileSync(join(runDir, crop)).toString('base64'), mime: 'image/png' };
  } catch {
    return undefined;
  }
}
