import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { PNG } from 'pngjs';
import { VIEWPORTS, type Config, type ViewportName, log } from './config.js';

export interface DesignImage {
  file: string;
  width: number;
  height: number;
  source: string;
}
export interface PairedDesign extends DesignImage {
  /** exact-width match → fidelity; widest available reused for a narrower viewport → adaptation */
  mode: 'fidelity' | 'adaptation';
}

/** Within this tolerance a design frame counts as "made for" that viewport. */
const WIDTH_TOLERANCE = 0.12;

/**
 * Resolve design references for each viewport.
 *  --figma <link>   : frames fetched via the Figma REST API, matched to viewports by their width
 *  --design <folder>: PNGs in a folder, matched by their pixel width (file names don't matter)
 * A viewport with no exact-width design falls back to the widest design available (usually the
 * desktop frame) in "adaptation" mode — that is the normal agency case, not an error.
 */
export async function resolveDesigns(cfg: Config, cacheDir: string): Promise<Map<ViewportName, PairedDesign>> {
  let images: DesignImage[] = [];
  if (cfg.figma) images = await fromFigma(cfg.figma, cfg.figmaToken, cacheDir);
  else if (cfg.designDir) images = fromFolder(cfg.designDir);
  const out = new Map<ViewportName, PairedDesign>();
  if (!images.length) return out;

  images.sort((a, b) => b.width - a.width);
  const widest = images[0];
  for (const vp of VIEWPORTS) {
    const exact = images.find((im) => Math.abs(im.width - vp.width) / vp.width <= WIDTH_TOLERANCE);
    if (exact) out.set(vp.name, { ...exact, mode: 'fidelity' });
    else if (widest.width > vp.width) out.set(vp.name, { ...widest, mode: 'adaptation' });
  }
  for (const [vp, d] of out) log(`design ${vp}: ${d.mode} ← ${d.source} (${d.width}px)`);
  return out;
}

function pngSize(file: string) {
  const png = PNG.sync.read(readFileSync(file));
  return { width: png.width, height: png.height };
}

function fromFolder(dir: string): DesignImage[] {
  if (!existsSync(dir)) throw new Error(`design folder not found: ${dir}`);
  return readdirSync(dir)
    .filter((f) => extname(f).toLowerCase() === '.png')
    .map((f) => {
      const file = join(dir, f);
      const { width, height } = pngSize(file);
      return { file, width, height, source: f };
    });
}

/* --------------------------------- Figma --------------------------------- */

function parseFigmaLink(link: string): { fileKey: string; nodeId?: string } {
  const u = new URL(link);
  const m = u.pathname.match(/\/(?:design|file|proto|board)\/([A-Za-z0-9]+)/);
  if (!m) throw new Error(`cannot read file key from Figma link: ${link}`);
  const raw = u.searchParams.get('node-id');
  return { fileKey: m[1], nodeId: raw ? raw.replace(/-/g, ':') : undefined };
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  absoluteBoundingBox?: { width: number; height: number };
  children?: FigmaNode[];
}

async function figmaGet(path: string, token: string) {
  const res = await fetch(`https://api.figma.com/v1${path}`, { headers: { 'X-Figma-Token': token } });
  if (!res.ok) throw new Error(`Figma API ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<any>;
}

/** Top-level frames under a node (or under the first page when the link has no node-id). */
function framesOf(node: FigmaNode): FigmaNode[] {
  if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') return [node];
  const kids = node.children ?? [];
  const frames = kids.filter((k) => (k.type === 'FRAME' || k.type === 'COMPONENT' || k.type === 'SECTION') && k.absoluteBoundingBox);
  // A SECTION groups frames — descend one level.
  return frames.flatMap((f) => (f.type === 'SECTION' ? (f.children ?? []).filter((c) => c.type === 'FRAME' && c.absoluteBoundingBox) : [f]));
}

async function fromFigma(link: string, token: string, cacheDir: string): Promise<DesignImage[]> {
  if (!token) throw new Error('FIGMA_TOKEN is not set (.env) — needed to read the design');
  const { fileKey, nodeId } = parseFigmaLink(link);
  mkdirSync(cacheDir, { recursive: true });

  let root: FigmaNode;
  if (nodeId) {
    const j = await figmaGet(`/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=2`, token);
    root = j.nodes?.[nodeId]?.document;
    if (!root) throw new Error(`node ${nodeId} not found in file ${fileKey}`);
  } else {
    const j = await figmaGet(`/files/${fileKey}?depth=3`, token);
    root = j.document?.children?.[0]; // first page
    if (!root) throw new Error('file has no pages');
  }

  // Keep frames that look like screens (wider than 300px), at most one per viewport bucket to limit API calls.
  const frames = framesOf(root)
    .filter((f) => (f.absoluteBoundingBox?.width ?? 0) >= 300)
    .sort((a, b) => (b.absoluteBoundingBox!.width ?? 0) - (a.absoluteBoundingBox!.width ?? 0));
  if (!frames.length) throw new Error('no frames found at that Figma location');

  const chosen: FigmaNode[] = [];
  for (const vp of VIEWPORTS) {
    const hit = frames.find((f) => Math.abs(f.absoluteBoundingBox!.width - vp.width) / vp.width <= WIDTH_TOLERANCE);
    if (hit && !chosen.includes(hit)) chosen.push(hit);
  }
  if (!chosen.length) chosen.push(frames[0]); // no exact width anywhere → take the widest for adaptation mode

  // One call renders all chosen frames.
  const ids = chosen.map((f) => f.id).join(',');
  const img = await figmaGet(`/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=png&scale=1`, token);
  const out: DesignImage[] = [];
  for (const f of chosen) {
    const url = img.images?.[f.id];
    if (!url) continue;
    const file = join(cacheDir, `${fileKey}_${f.id.replace(/[^a-z0-9]/gi, '-')}.png`);
    const res = await fetch(url);
    if (!res.ok) continue;
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const { width, height } = pngSize(file);
    out.push({ file, width, height, source: `Figma: ${f.name}` });
  }
  if (!out.length) throw new Error('Figma returned no images');
  return out;
}
