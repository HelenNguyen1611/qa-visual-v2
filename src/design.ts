import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { PNG } from 'pngjs';
import { log } from './config.js';

export interface FigmaFrame {
  id: string;
  name: string;
  width: number;
  height: number;
  /** filled in once rendered */
  file?: string;
}

export interface DesignImage {
  file: string;
  width: number;
  height: number;
  source: string;
}

export function parseFigmaLink(link: string): { fileKey: string; nodeId?: string } {
  const u = new URL(link);
  const m = u.pathname.match(/\/(?:design|file|proto|board)\/([A-Za-z0-9]+)/);
  if (!m) throw new Error(`không đọc được file key từ link Figma: ${link}`);
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
  if (!res.ok) throw new Error(`Figma API ${res.status} tại ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<any>;
}

/**
 * The page designs in a Figma file.
 *
 * Real agency files put every page of the site as a top-level frame on ONE Figma page, mixed in with
 * component libraries, archived versions and stray images. Two filters clear that up reliably:
 * the page designs all share one width (the design's canvas width), and archive sections are named.
 */
export async function listFigmaFrames(link: string, token: string): Promise<FigmaFrame[]> {
  if (!token) throw new Error('FIGMA_TOKEN chưa được đặt trong .env');
  const { fileKey, nodeId } = parseFigmaLink(link);

  let roots: FigmaNode[] = [];
  if (nodeId) {
    const j = await figmaGet(`/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=2`, token);
    const doc = j.nodes?.[nodeId]?.document;
    if (!doc) throw new Error(`không thấy node ${nodeId} trong file ${fileKey}`);
    // A link to one frame → that frame. A link to a page/section → its children.
    roots = doc.type === 'CANVAS' || doc.type === 'SECTION' ? (doc.children ?? []) : [doc];
    // If the link pointed at a single frame, also pull its siblings so other pages can be mapped.
    if (roots.length === 1 && roots[0].id === nodeId) {
      const page = await figmaGet(`/files/${fileKey}?depth=2`, token).catch(() => null);
      const pages: FigmaNode[] = page?.document?.children ?? [];
      const owner = pages.find((p) => (p.children ?? []).some((c) => c.id === nodeId));
      if (owner?.children?.length) roots = owner.children;
    }
  } else {
    const j = await figmaGet(`/files/${fileKey}?depth=2`, token);
    const pages: FigmaNode[] = j.document?.children ?? [];
    // Pick the page with the most wide frames — the cover page has almost nothing on it.
    let best: FigmaNode | undefined;
    let bestCount = -1;
    for (const p of pages) {
      const n = (p.children ?? []).filter((c) => (c.absoluteBoundingBox?.width ?? 0) >= 300).length;
      if (n > bestCount) {
        bestCount = n;
        best = p;
      }
    }
    roots = best?.children ?? [];
  }

  const candidates = roots.filter(
    (n) => (n.type === 'FRAME' || n.type === 'COMPONENT') && (n.absoluteBoundingBox?.width ?? 0) >= 300 && (n.absoluteBoundingBox?.height ?? 0) >= 300,
  );
  if (!candidates.length) throw new Error('không tìm thấy frame nào ở vị trí Figma đã cho');

  // The page designs share one width; component libraries and stray art do not.
  const byWidth = new Map<number, FigmaNode[]>();
  for (const c of candidates) {
    const w = Math.round(c.absoluteBoundingBox!.width);
    if (!byWidth.has(w)) byWidth.set(w, []);
    byWidth.get(w)!.push(c);
  }
  let dominant = 0;
  let dominantCount = 0;
  for (const [w, list] of byWidth) {
    if (list.length > dominantCount || (list.length === dominantCount && w > dominant)) {
      dominant = w;
      dominantCount = list.length;
    }
  }
  const chosen = dominantCount >= 2 ? byWidth.get(dominant)! : candidates;
  log(`Figma: ${candidates.length} frame ứng viên, chiều rộng trội ${dominant}px → giữ ${chosen.length} frame`);

  return chosen.map((c) => ({
    id: c.id,
    name: c.name,
    width: Math.round(c.absoluteBoundingBox!.width),
    height: Math.round(c.absoluteBoundingBox!.height),
  }));
}

/** Render the frames we actually need. One API call for all ids, then download each PNG. */
export async function renderFigmaFrames(link: string, frames: FigmaFrame[], token: string, cacheDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!frames.length) return out;
  const { fileKey } = parseFigmaLink(link);
  mkdirSync(cacheDir, { recursive: true });

  const todo = frames.filter((f) => {
    const file = join(cacheDir, `${fileKey}_${f.id.replace(/[^a-z0-9]/gi, '-')}.png`);
    if (existsSync(file)) {
      out.set(f.id, file);
      return false;
    }
    return true;
  });
  if (!todo.length) return out;

  const img = await figmaGet(`/images/${fileKey}?ids=${encodeURIComponent(todo.map((f) => f.id).join(','))}&format=png&scale=1`, token);
  for (const f of todo) {
    const url = img.images?.[f.id];
    if (!url) continue;
    const res = await fetch(url);
    if (!res.ok) continue;
    const file = join(cacheDir, `${fileKey}_${f.id.replace(/[^a-z0-9]/gi, '-')}.png`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    out.set(f.id, file);
  }
  return out;
}

/* --------------------------- design folder fallback --------------------------- */

function pngSize(file: string) {
  const png = PNG.sync.read(readFileSync(file));
  return { width: png.width, height: png.height };
}

/** PNGs in a folder, matched by pixel width — file names do not matter. */
export function framesFromFolder(dir: string): FigmaFrame[] {
  if (!existsSync(dir)) throw new Error(`không thấy thư mục design: ${dir}`);
  return readdirSync(dir)
    .filter((f) => extname(f).toLowerCase() === '.png')
    .map((f) => {
      const file = join(dir, f);
      const { width, height } = pngSize(file);
      return { id: 'file:' + f, name: f.replace(/\.png$/i, ''), width, height, file };
    });
}
