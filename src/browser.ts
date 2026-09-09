/**
 * Everything that runs INSIDE the page, plus the freeze stylesheet.
 * Lifted from v1 — this is the part that made screenshots deterministic enough to diff.
 */

/** Stop animations, transitions and the caret so two screenshots of an unchanged page are identical. */
export const FREEZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}
html { scroll-behavior: auto !important; }
`;

/** Scroll through the page so lazy-loaded images are requested and decoded, then return to top. */
export async function triggerLazyLoad(): Promise<void> {
  const h = document.documentElement.scrollHeight;
  const step = Math.max(400, window.innerHeight);
  for (let y = 0; y < Math.min(h, 20000); y += step) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 50));
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 120));
  try {
    // @ts-ignore
    if (document.fonts?.ready) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
  } catch {}
}

export interface MediaRegion {
  kind: 'video' | 'iframe' | 'canvas' | 'img' | 'background';
  x: number;
  y: number;
  w: number;
  h: number;
  src?: string;
  /** img only */
  broken?: boolean;
  /** img only: natural aspect vs rendered aspect, >0.15 means visibly stretched */
  distortion?: number;
  /** video only */
  playing?: boolean;
  selector: string;
}

/**
 * The thin DOM pass v2 keeps. Not a full evidence model — just enough to know
 *  (a) which regions a still screenshot cannot represent (video/iframe/canvas render blank),
 *  (b) which images failed or are stretched, (c) which CSS backgrounds exist (they can 404).
 * Runs in the page.
 */
export function collectMedia(): MediaRegion[] {
  const out: MediaRegion[] = [];
  const path = (el: Element) => {
    const parts: string[] = [];
    let cur: Element | null = el;
    let d = 0;
    while (cur && d < 5) {
      let p = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift('#' + cur.id);
        break;
      }
      const cls = Array.from(cur.classList).slice(0, 2).join('.');
      if (cls) p += '.' + cls;
      parts.unshift(p);
      cur = cur.parentElement;
      d++;
    }
    return parts.join(' > ');
  };
  const box = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const visible = (el: Element) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 4 && r.height > 4;
  };

  for (const v of Array.from(document.querySelectorAll('video'))) {
    if (!visible(v)) continue;
    out.push({ kind: 'video', ...box(v), src: (v.currentSrc || v.src || '').slice(0, 200), playing: !v.paused && v.readyState >= 3, selector: path(v) });
  }
  for (const f of Array.from(document.querySelectorAll('iframe'))) {
    if (!visible(f)) continue;
    out.push({ kind: 'iframe', ...box(f), src: (f.getAttribute('src') || '').slice(0, 200), selector: path(f) });
  }
  for (const c of Array.from(document.querySelectorAll('canvas'))) {
    if (!visible(c)) continue;
    out.push({ kind: 'canvas', ...box(c), selector: path(c) });
  }
  for (const im of Array.from(document.querySelectorAll('img'))) {
    if (!visible(im)) continue;
    const b = box(im);
    const broken = im.complete && im.naturalWidth === 0 && !!(im.currentSrc || im.src);
    let distortion: number | undefined;
    if (im.naturalWidth > 0 && im.naturalHeight > 0 && b.w > 24 && b.h > 24) {
      const fit = getComputedStyle(im).objectFit;
      if (!/cover|contain|scale-down/.test(fit)) {
        const nat = im.naturalWidth / im.naturalHeight;
        const shown = b.w / b.h;
        distortion = Math.abs(nat - shown) / nat;
      }
    }
    out.push({ kind: 'img', ...b, src: (im.currentSrc || im.src || '').slice(0, 200), broken, distortion, selector: path(im) });
  }
  // CSS background images — page builders put hero art here where <img> checks cannot see it.
  const all = document.body ? document.body.querySelectorAll('*') : [];
  let n = 0;
  for (const el of Array.from(all)) {
    if (n > 400) break;
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none' || !/url\(/.test(bg)) continue;
    const m = bg.match(/url\((['"]?)(.*?)\1\)/);
    if (!m || !m[2] || m[2].startsWith('data:')) continue;
    if (!visible(el)) continue;
    let src = m[2];
    try {
      src = new URL(m[2], location.href).toString();
    } catch {}
    out.push({ kind: 'background', ...box(el), src: src.slice(0, 200), selector: path(el) });
    n++;
  }
  return out;
}

export interface TextItem {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tag: string;
}

/**
 * A flat index of every visible text run with its real box, plus images keyed by filename.
 *
 * This exists because vision models cannot estimate pixel coordinates reliably — they guess, and a
 * box drawn from a guess points at the wrong element. But they DO read text accurately. So the model
 * names the text involved in a finding and we look up where that text actually is.
 * Runs in the page.
 */
export function collectTextIndex(max = 800): TextItem[] {
  const out: TextItem[] = [];
  const seen = new Set<string>();
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode()) && out.length < max) {
    const raw = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (raw.length < 2) continue;
    const parent = n.parentElement;
    if (!parent) continue;
    const cs = getComputedStyle(parent);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') < 0.05) continue;
    let range: Range;
    try {
      range = document.createRange();
      range.selectNodeContents(n);
    } catch {
      continue;
    }
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rects) {
      minX = Math.min(minX, r.left);
      minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.right);
      maxY = Math.max(maxY, r.bottom);
    }
    const key = raw.slice(0, 40) + '@' + Math.round(minY);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text: raw.slice(0, 120),
      x: Math.round(minX + scrollX),
      y: Math.round(minY + scrollY),
      w: Math.round(maxX - minX),
      h: Math.round(maxY - minY),
      tag: parent.tagName.toLowerCase(),
    });
  }
  // Images: findable by file name or alt text.
  for (const im of Array.from(document.querySelectorAll('img'))) {
    if (out.length >= max) break;
    const r = im.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    const cs = getComputedStyle(im);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const name = ((im.currentSrc || im.src || '').split('/').pop() || '').split('?')[0];
    const label = [im.getAttribute('alt') || '', name].filter(Boolean).join(' ');
    if (!label) continue;
    out.push({ text: label.slice(0, 120), x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height), tag: 'img' });
  }
  return out;
}
