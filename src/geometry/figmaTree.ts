import type { GeomBox } from './types.js';

/** One comparable node inside a mapped page frame. Boxes are relative to the frame origin. */
export interface FigmaPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FigmaGeomNode {
  id: string;
  name: string;
  type: string;
  parentId?: string;
  box: GeomBox;
  text?: string;
  fontSize?: number;
  hasImageFill?: boolean;
  padding?: FigmaPadding;
}

export interface FigmaGeomTree {
  frameId: string;
  frameName: string;
  frame: GeomBox;
  nodes: FigmaGeomNode[];
}

interface FigmaRaw {
  id?: string;
  name?: string;
  type?: string;
  visible?: boolean;
  characters?: string;
  style?: { fontSize?: number };
  fills?: Array<{ type?: string; visible?: boolean }>;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  children?: FigmaRaw[];
}

const MAX_WALK = 4000;
const MAX_KEEP = 800;
const STRUCT = /^(FRAME|GROUP|COMPONENT|INSTANCE|SECTION)$/;

function hasImageFill(n: FigmaRaw): boolean {
  return (n.fills ?? []).some((f) => f.visible !== false && f.type === 'IMAGE');
}

function clipText(s: string | undefined): string | undefined {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length < 4) return undefined;
  return t.slice(0, 80);
}

function readPadding(n: FigmaRaw): FigmaPadding | undefined {
  const top = n.paddingTop ?? 0;
  const right = n.paddingRight ?? 0;
  const bottom = n.paddingBottom ?? 0;
  const left = n.paddingLeft ?? 0;
  if (top === 0 && right === 0 && bottom === 0 && left === 0) return undefined;
  return { top, right, bottom, left };
}

/**
 * Keep TEXT, image fills, and structural frames so a content block can be mapped.
 * Coordinates are shifted so the page frame sits at (0,0).
 */
export function flattenFigmaTree(raw: unknown, frameId: string): FigmaGeomTree | undefined {
  const root = raw as FigmaRaw;
  const origin = root?.absoluteBoundingBox;
  if (!root?.id || !origin || origin.width < 50 || origin.height < 50) return undefined;

  const nodes: FigmaGeomNode[] = [];
  let walked = 0;

  const walk = (n: FigmaRaw, parentId?: string) => {
    if (walked++ > MAX_WALK || nodes.length >= MAX_KEEP) return;
    if (n.visible === false) return;
    const box = n.absoluteBoundingBox;
    if (!box) {
      for (const c of n.children ?? []) walk(c, n.id ?? parentId);
      return;
    }
    const rel: GeomBox = {
      x: Math.round(box.x - origin.x),
      y: Math.round(box.y - origin.y),
      w: Math.round(box.width),
      h: Math.round(box.height),
    };
    const text = n.type === 'TEXT' ? clipText(n.characters) : undefined;
    const image = hasImageFill(n) && rel.w >= 24 && rel.h >= 24;
    const structural = STRUCT.test(n.type ?? '') && n.id !== root.id && rel.w >= 48 && rel.h >= 48;
    const pad = readPadding(n);
    if ((text || image || structural) && n.id) {
      nodes.push({
        id: n.id,
        name: n.name ?? n.id,
        type: n.type ?? 'UNKNOWN',
        parentId,
        box: rel,
        text,
        fontSize: n.style?.fontSize,
        hasImageFill: image || undefined,
        padding: pad,
      });
    }
    for (const c of n.children ?? []) walk(c, n.id);
  };

  walk(root, undefined);
  return {
    frameId: root.id ?? frameId,
    frameName: root.name ?? frameId,
    frame: { x: 0, y: 0, w: Math.round(origin.width), h: Math.round(origin.height) },
    nodes,
  };
}
