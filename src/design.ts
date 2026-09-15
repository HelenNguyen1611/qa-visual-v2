import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { PNG } from 'pngjs';
import { log } from './config.js';

export type FrameRole = 'desktop' | 'mobile';

export interface FigmaFrame {
  id: string;
  name: string;
  width: number;
  height: number;
  /** filled in once rendered */
  file?: string;
  /** Figma file this node lives in — needed when desktop and mobile designs are different files */
  fileKey?: string;
  /** Which pairing pool this frame belongs to */
  role?: FrameRole;
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
  if (!m) throw new Error(`could not read a file key from the Figma link: ${link}`);
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
  if (!res.ok) throw new Error(`Figma API ${res.status} at ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<any>;
}

export interface FigmaOverlayBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FigmaOverlayText = FigmaOverlayBox & {
  text: string;
  fontSize?: number;
  fontWeight?: number;
  /** Line box in Figma pixels, when the file stored a px / % size. */
  lineHeight?: number;
  id?: string;
  depth?: number;
  /** Immediate parent node — two texts in the same card share this, two cards do not. */
  parentId?: string;
  /** Innermost INSTANCE this text sits in. A reused homepage block on another frame has one. */
  instanceId?: string;
};

/** TEXT + image-fill surfaces from one mapped page frame. Used by measured overlay checks. */
export interface FigmaOverlay {
  pageWidth: number;
  texts: FigmaOverlayText[];
  surfaces: FigmaOverlayBox[];
}

type OverlayNode = {
  id?: string;
  type?: string;
  componentId?: string;
  characters?: string;
  fills?: Array<{ type?: string; visible?: boolean }>;
  style?: {
    fontSize?: number;
    fontWeight?: number;
    lineHeightPx?: number;
    lineHeightPercentFontSize?: number;
  };
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  children?: OverlayNode[];
};

function overlayTypeMetrics(n: OverlayNode): Pick<FigmaOverlayText, 'fontSize' | 'fontWeight' | 'lineHeight'> {
  const s = n.style;
  if (!s) return {};
  const fontSize = typeof s.fontSize === 'number' && s.fontSize > 0 ? s.fontSize : undefined;
  const fontWeight = typeof s.fontWeight === 'number' && s.fontWeight > 0 ? s.fontWeight : undefined;
  let lineHeight: number | undefined;
  if (typeof s.lineHeightPx === 'number' && s.lineHeightPx > 0) lineHeight = s.lineHeightPx;
  else if (fontSize && typeof s.lineHeightPercentFontSize === 'number' && s.lineHeightPercentFontSize > 0) {
    lineHeight = (fontSize * s.lineHeightPercentFontSize) / 100;
  }
  return { fontSize, fontWeight, lineHeight };
}

/** Keep TEXT and nodes with an image fill — enough to find a banner, not a geometry engine. */
export function flattenFigmaOverlay(doc: OverlayNode): FigmaOverlay {
  const page = doc.absoluteBoundingBox;
  const pageWidth = page?.width ?? 0;
  const texts: FigmaOverlay['texts'] = [];
  const surfaces: FigmaOverlayBox[] = [];
  const pageX = page?.x ?? 0;
  const pageY = page?.y ?? 0;
  const walk = (n: OverlayNode, depth: number, parentId?: string, instanceId?: string) => {
    const nextInstance = n.type === 'INSTANCE' ? n.id ?? instanceId : instanceId;
    const b = n.absoluteBoundingBox;
    if (n.type === 'TEXT' && n.characters && b) {
      const text = n.characters.replace(/\s+/g, ' ').trim();
      if (text.length >= 3) {
        texts.push({
          text: text.slice(0, 120),
          x: b.x - pageX,
          y: b.y - pageY,
          w: b.width,
          h: b.height,
          id: n.id,
          depth,
          parentId,
          instanceId: nextInstance,
          ...overlayTypeMetrics(n),
        });
      }
    }
    const image = (n.fills ?? []).some((f) => f.visible !== false && f.type === 'IMAGE');
    if (image && b && b.width >= 400) surfaces.push({ x: b.x - pageX, y: b.y - pageY, w: b.width, h: b.height });
    for (const c of n.children ?? []) walk(c, depth + 1, n.id ?? parentId, nextInstance);
  };
  walk(doc, 0);
  return { pageWidth, texts, surfaces };
}

/** Subtree of the mapped page frame, depth 8 — banner title + image surface sit well above that. */
export async function fetchFigmaOverlay(link: string, nodeId: string, token: string): Promise<FigmaOverlay> {
  const { fileKey } = parseFigmaLink(link);
  const j = await figmaGet(`/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=8`, token);
  const doc: OverlayNode | undefined = j.nodes?.[nodeId]?.document;
  if (!doc) throw new Error(`node ${nodeId} not found in file ${fileKey}`);
  return flattenFigmaOverlay(doc);
}

/**
 * The page designs in a Figma file.
 *
 * Real agency files put every page of the site as a top-level frame on ONE Figma page, mixed in with
 * component libraries, archived versions and stray images. Two filters clear that up reliably:
 * the page designs all share one width (the design's canvas width), and archive sections are named.
 */
export async function listFigmaFrames(link: string, token: string): Promise<FigmaFrame[]> {
  if (!token) throw new Error('FIGMA_TOKEN is not set in .env');
  const { fileKey, nodeId } = parseFigmaLink(link);

  let roots: FigmaNode[] = [];
  if (nodeId) {
    const j = await figmaGet(`/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=2`, token);
    const doc = j.nodes?.[nodeId]?.document;
    if (!doc) throw new Error(`node ${nodeId} not found in file ${fileKey}`);
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
  if (!candidates.length) throw new Error('no frames found at the given Figma location');

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
  log(`Figma: ${candidates.length} candidate frames, dominant width ${dominant}px → keeping ${chosen.length} frames`);

  return chosen.map((c) => ({
    id: c.id,
    name: c.name,
    width: Math.round(c.absoluteBoundingBox!.width),
    height: Math.round(c.absoluteBoundingBox!.height),
    fileKey,
  }));
}

/**
 * One frame, named by a link pointing straight at it.
 *
 * The escape hatch for the dominant-width filter above: it deliberately drops frames, and it picks
 * one Figma page, so the frame a person actually wants may not be in the list at all. Pasting its
 * link has to work, or the pairing table is capped by what the tool managed to guess.
 */
export async function frameFromLink(link: string, token: string): Promise<FigmaFrame> {
  if (!token) throw new Error('FIGMA_TOKEN is not set in .env');
  const { nodeId } = parseFigmaLink(link);
  if (!nodeId) throw new Error('link does not point at a frame — open the frame in Figma then Copy link to selection');
  const { fileKey } = parseFigmaLink(link);
  const j = await figmaGet(`/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=1`, token);
  const doc: FigmaNode | undefined = j.nodes?.[nodeId]?.document;
  if (!doc) throw new Error(`node ${nodeId} not found in file ${fileKey}`);
  const box = doc.absoluteBoundingBox;
  if (!box) throw new Error(`node "${doc.name}" has no size — pick a frame, not a page or empty group`);
  return { id: doc.id, name: doc.name, width: Math.round(box.width), height: Math.round(box.height), fileKey };
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
  if (!existsSync(dir)) throw new Error(`design folder not found: ${dir}`);
  return readdirSync(dir)
    .filter((f) => extname(f).toLowerCase() === '.png')
    .map((f) => {
      const file = join(dir, f);
      const { width, height } = pngSize(file);
      return {
        id: 'file:' + f,
        name: f.replace(/\.png$/i, ''),
        width,
        height,
        file,
        role: width < 600 ? 'mobile' : 'desktop',
      };
    });
}

function tag(frames: FigmaFrame[], role: FrameRole, fileKey?: string): FigmaFrame[] {
  return frames.map((f) => ({ ...f, role, fileKey: f.fileKey ?? fileKey }));
}

/**
 * Desktop frames from --figma (or a PNG folder), plus mobile frames from --figma-mobile.
 *
 * Two lists, not one: listFigmaFrames keeps the dominant width on a page, so a desktop Figma
 * page will never yield the 390 frames sitting on the mobile page next to it. A second link
 * (same file, different page — or a different file) is how those frames get in.
 */
export async function loadDesignFrames(
  cfg: { figma?: string; figmaMobile?: string; designDir?: string; figmaToken: string },
): Promise<FigmaFrame[]> {
  const out: FigmaFrame[] = [];
  try {
    if (cfg.figma) {
      const { fileKey } = parseFigmaLink(cfg.figma);
      out.push(...tag(await listFigmaFrames(cfg.figma, cfg.figmaToken), 'desktop', fileKey));
    } else if (cfg.designDir) {
      out.push(...framesFromFolder(cfg.designDir));
    }
  } catch (e: any) {
    log(`design: ${e?.message ?? e}`);
  }
  if (cfg.figmaMobile) {
    try {
      const { fileKey } = parseFigmaLink(cfg.figmaMobile);
      out.push(...tag(await listFigmaFrames(cfg.figmaMobile, cfg.figmaToken), 'mobile', fileKey));
    } catch (e: any) {
      log(`design mobile: ${e?.message ?? e}`);
    }
  }
  const desk = out.filter((f) => f.role !== 'mobile').length;
  const mob = out.filter((f) => f.role === 'mobile').length;
  if (out.length) log(`design frames: ${desk} desktop, ${mob} mobile`);
  return out;
}
