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
  // Same reasoning as collectTextIndex: opacity does not inherit, so a faded-out slide's image is
  // still "visible" to a check that only reads the element's own computed style.
  const painted = (el: Element): boolean => {
    const anyEl = el as any;
    if (typeof anyEl.checkVisibility === 'function') {
      return anyEl.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
        contentVisibilityAuto: true,
        checkOpacity: true,
        checkVisibilityCSS: true,
      });
    }
    let cur: Element | null = el;
    let opacity = 1;
    for (let d = 0; cur && d < 20; d++) {
      const cs = getComputedStyle(cur);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      opacity *= parseFloat(cs.opacity || '1');
      if (opacity < 0.05) return false;
      cur = cur.parentElement;
    }
    return true;
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && painted(el);
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

export interface ReservedRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: string;
  selector: string;
}

/**
 * Space that media is holding open without painting anything yet.
 *
 * A hero built for an effect — images that follow the cursor, a gallery that fades in on scroll —
 * has its pictures in the DOM from the start, sized and positioned, but transparent. The
 * screenshot of it is blank, and a check looking for empty bands reports a hole in the design.
 * It is not a hole: the space is spoken for, and the DOM says so.
 *
 * Deliberately separate from `collectMedia`, which must keep returning only what is painted —
 * masking a diff or telling the model "there is a video here" on the strength of an invisible
 * element would break both.
 */
export function collectReservedSpace(max = 200): ReservedRegion[] {
  const out: ReservedRegion[] = [];
  const painted = (el: Element): boolean => {
    const anyEl = el as any;
    if (typeof anyEl.checkVisibility === 'function') {
      return anyEl.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
        contentVisibilityAuto: true,
        checkOpacity: true,
        checkVisibilityCSS: true,
      });
    }
    let cur: Element | null = el;
    let opacity = 1;
    for (let d = 0; cur && d < 20; d++) {
      const cs = getComputedStyle(cur);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      opacity *= parseFloat(cs.opacity || '1');
      if (opacity < 0.05) return false;
      cur = cur.parentElement;
    }
    return true;
  };
  const label = (el: Element) => {
    const id = el.id ? '#' + el.id : '';
    const cls = Array.from(el.classList).slice(0, 2).join('.');
    return (el.tagName.toLowerCase() + (cls ? '.' + cls : '') + id).slice(0, 80);
  };

  for (const el of Array.from(document.querySelectorAll('img,video,iframe,canvas,svg,picture'))) {
    if (out.length >= max) break;
    const r = el.getBoundingClientRect();
    // `display:none` gives a 0×0 rect and genuinely reserves nothing, so it drops out here.
    if (r.width < 8 || r.height < 8) continue;
    if (painted(el)) continue; // already reported by collectMedia
    out.push({
      x: Math.round(r.left + scrollX),
      y: Math.round(r.top + scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
      kind: el.tagName.toLowerCase(),
      selector: label(el),
    });
  }

  // Effect layers: a positioned box with nothing in it yet. A cursor trail, a canvas mount, a
  // parallax stage — the markup sizes the area up front and JS fills it on an event that a
  // screenshot never fires. An empty band there is allocated space, not a hole in the design.
  // Genuine missing content does not look like this: it collapses to zero height or is absent.
  for (const el of Array.from(document.querySelectorAll('div,section,span'))) {
    if (out.length >= max) break;
    if (el.children.length || (el.textContent || '').trim()) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue;
    out.push({
      x: Math.round(r.left + scrollX),
      y: Math.round(r.top + scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
      kind: 'layer',
      selector: label(el),
    });
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
  /**
   * The heading level this text sits under (h1…h6), when it has one.
   *
   * `tag` alone cannot answer that: `<h1><span>Title</span></h1>` indexes the span, so a check
   * keyed on `tag === 'h1'` would never see the heading it is meant to measure.
   */
  heading?: string;
  /**
   * Marked hidden from assistive tech (`aria-hidden` / `inert`) while still being painted.
   *
   * Every carousel library flags its inactive slides this way. The text stays in the index —
   * it IS on the screenshot, so a finding may still need to be located against it — but a check
   * that reasons about elements colliding has to ignore it, because stacked slides always collide.
   */
  ariaHidden?: boolean;
  /**
   * One `[x, y, w, h]` per line, present only when the run wraps across more than one.
   *
   * `x/y/w/h` above is the union of those lines, which is the right thing for pointing a reader at
   * the run but the wrong thing for asking whether two runs collide. Two sentences that simply
   * follow each other in a wrapped paragraph share a line, so their unions overlap by a wide band
   * while not a single glyph does. Collision has to be judged line by line.
   */
  lines?: [number, number, number, number][];
  /** computed values, so type and colour can be measured instead of guessed from a screenshot */
  fontSize?: number;
  fontWeight?: number;
  fontStyle?: string;
  fontFamily?: string;
  color?: string;
  lineHeight?: number;
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
  /** `font-weight` comes back numeric in Chrome, but the keywords are still legal CSS. */
  const weightOf = (v: string): number | undefined => {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
    if (v === 'bold') return 700;
    if (v === 'normal') return 400;
    return undefined;
  };
  const headingOf = (el: Element): string | undefined => {
    let cur: Element | null = el;
    for (let d = 0; cur && d < 4; d++) {
      const t = cur.tagName.toLowerCase();
      if (/^h[1-6]$/.test(t)) return t;
      cur = cur.parentElement;
    }
    return undefined;
  };
  /**
   * Is this text actually painted on the page?
   *
   * Reading the text node's own parent is not enough, and the gap it leaves is not academic:
   * `opacity` does NOT inherit, so a carousel slide set to `opacity: 0` leaves every computed
   * style inside it reporting opacity 1. The slides then sit stacked at identical coordinates and
   * every collision check sees a pile of text on top of text. `checkVisibility` walks the whole
   * ancestor chain, which is exactly the part that was missing.
   */
  const painted = (el: Element): boolean => {
    const anyEl = el as any;
    if (typeof anyEl.checkVisibility === 'function') {
      return anyEl.checkVisibility({
        // Current spec names, then the names Chrome shipped first — unknown keys are ignored.
        opacityProperty: true,
        visibilityProperty: true,
        contentVisibilityAuto: true,
        checkOpacity: true,
        checkVisibilityCSS: true,
      });
    }
    let cur: Element | null = el;
    let opacity = 1;
    for (let d = 0; cur && d < 20; d++) {
      const cs = getComputedStyle(cur);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      opacity *= parseFloat(cs.opacity || '1');
      if (opacity < 0.05) return false;
      cur = cur.parentElement;
    }
    return true;
  };
  /**
   * The rectangle beyond which this element cannot paint, from ancestors that clip.
   *
   * `checkVisibility` says nothing about clipping, and the most common way to hide text on the web
   * does exactly that: the screen-reader-only pattern (`position:absolute; width:1px; height:1px;
   * overflow:hidden; clip-path:inset(50%)`) leaves the text node's own rects at full size. Clamping
   * to the clip shrinks them to a sliver, which then falls below the size floor on its own.
   */
  const clipBox = (el: Element) => {
    let l = -Infinity, t = -Infinity, r = Infinity, b = Infinity;
    let cur: Element | null = el;
    for (let d = 0; cur && d < 20; d++) {
      const cs = getComputedStyle(cur);
      // A fixed element is laid out against the viewport and escapes ancestor overflow.
      if (d > 0 && cs.position === 'fixed') break;
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.clipPath !== 'none') {
        const box = cur.getBoundingClientRect();
        l = Math.max(l, box.left);
        t = Math.max(t, box.top);
        r = Math.min(r, box.right);
        b = Math.min(b, box.bottom);
      }
      cur = cur.parentElement;
    }
    return { l, t, r, b };
  };
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode()) && out.length < max) {
    const raw = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (raw.length < 2) continue;
    const parent = n.parentElement;
    if (!parent) continue;
    const cs = getComputedStyle(parent);
    if (!painted(parent)) continue;
    let range: Range;
    try {
      range = document.createRange();
      range.selectNodeContents(n);
    } catch {
      continue;
    }
    const clip = clipBox(parent);
    const rects = Array.from(range.getClientRects())
      .map((r) => ({
        left: Math.max(r.left, clip.l),
        top: Math.max(r.top, clip.t),
        right: Math.min(r.right, clip.r),
        bottom: Math.min(r.bottom, clip.b),
      }))
      .filter((r) => r.right - r.left > 0 && r.bottom - r.top > 0);
    if (!rects.length) continue;
    // One rect per line, but a line can arrive in fragments; merge those sharing a baseline band.
    const lines: { left: number; top: number; right: number; bottom: number }[] = [];
    for (const r of rects.slice().sort((a, b) => a.top - b.top || a.left - b.left)) {
      const last = lines[lines.length - 1];
      if (last && r.top < last.bottom - (last.bottom - last.top) * 0.5) {
        last.left = Math.min(last.left, r.left);
        last.right = Math.max(last.right, r.right);
        last.top = Math.min(last.top, r.top);
        last.bottom = Math.max(last.bottom, r.bottom);
      } else {
        lines.push({ ...r });
      }
    }
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
    const lh = parseFloat(cs.lineHeight);
    out.push({
      text: raw.slice(0, 120),
      x: Math.round(minX + scrollX),
      y: Math.round(minY + scrollY),
      w: Math.round(maxX - minX),
      h: Math.round(maxY - minY),
      tag: parent.tagName.toLowerCase(),
      heading: headingOf(parent),
      ariaHidden: parent.closest('[aria-hidden="true"],[inert]') ? true : undefined,
      lines:
        lines.length > 1
          ? lines
              .slice(0, 24)
              .map((r) => [
                Math.round(r.left + scrollX),
                Math.round(r.top + scrollY),
                Math.round(r.right - r.left),
                Math.round(r.bottom - r.top),
              ] as [number, number, number, number])
          : undefined,
      fontSize: parseFloat(cs.fontSize) || undefined,
      fontWeight: weightOf(cs.fontWeight),
      fontStyle: cs.fontStyle || undefined,
      fontFamily: (cs.fontFamily || '').slice(0, 120) || undefined,
      color: cs.color || undefined,
      lineHeight: Number.isFinite(lh) ? lh : undefined,
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
