/** Document-space box (scrollX/scrollY already added), same convention as MediaRegion. */
export interface GeomBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type GeomKind = 'section' | 'container' | 'block' | 'media' | 'heading' | 'item';

export interface GeomMedia {
  type: 'img' | 'video' | 'iframe' | 'canvas';
  src?: string;
  naturalW?: number;
  naturalH?: number;
  objectFit?: string;
  /** displayed width / height */
  aspect: number;
  /** natural width / height, when known */
  naturalAspect?: number;
}

/**
 * One collected element. `locator` is meant to resolve back to that element
 * (`document.querySelector` / Playwright locator) — not a display-only CSS snippet.
 */
export interface GeomNode {
  id: string;
  parentId?: string;
  siblingIndex: number;
  kind: GeomKind;
  tag: string;
  role?: string;
  locator: string;
  classes: string[];
  /** tag + structural classes — used later to group equivalent siblings */
  signature: string;
  box: GeomBox;
  ariaHidden?: boolean;
  text?: string;
  media?: GeomMedia;
  style?: { display: string; position: string };
  /** Computed CSS padding, when collected. */
  padding?: { top: number; right: number; bottom: number; left: number };
}

export interface GeomSnapshot {
  viewportWidth: number;
  viewportHeight: number;
  pageHeight: number;
  /** Best-effort main/content column, when one is identifiable. */
  content?: GeomBox & { locator: string };
  nodes: GeomNode[];
}
