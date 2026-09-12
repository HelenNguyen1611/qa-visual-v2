import type { GeomBox, GeomKind, GeomNode, GeomSnapshot } from './types.js';

/**
 * Layout evidence for later detectors. Runs INSIDE the page (Playwright evaluate).
 * Helpers live in this function so evaluate can serialize it whole — same pattern as collectMedia.
 * Does not create findings.
 */
export function collectGeometry(): GeomSnapshot {
  const MAX_NODES = 500;
  const SKIP_TAG = /^(html|head|body|script|style|link|meta|noscript|template|svg|path|br|hr)$/i;
  const SEMANTIC =
    'main, [role="main"], section, article, header, footer, nav, aside, figure, [role="region"], [role="article"], [role="banner"], [role="contentinfo"]';

  const painted = (el: Element): boolean => {
    const anyEl = el as Element & { checkVisibility?: (opts: object) => boolean };
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

  const boxOf = (el: Element): GeomBox => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + scrollX),
      y: Math.round(r.top + scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };

  const visible = (el: Element, minW = 8, minH = 8): boolean => {
    const r = el.getBoundingClientRect();
    return r.width >= minW && r.height >= minH && painted(el);
  };

  const esc = (s: string): string =>
    typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');

  const locatorOf = (el: Element): string => {
    if (el.id) {
      const idSel = `#${esc(el.id)}`;
      try {
        if (document.querySelectorAll(idSel).length === 1) return idSel;
      } catch {}
    }
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let d = 0; cur && d < 10; d++) {
      const tag = cur.tagName.toLowerCase();
      if (cur.id) {
        try {
          if (document.querySelectorAll(`#${esc(cur.id)}`).length === 1) {
            parts.unshift(`#${esc(cur.id)}`);
            break;
          }
        } catch {}
      }
      let part = tag;
      const parentEl: Element | null = cur.parentElement;
      if (parentEl) {
        const same = Array.from(parentEl.children).filter((c) => (c as Element).tagName === cur!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      if (tag === 'html') break;
      cur = parentEl;
    }
    return parts.join('>');
  };

  const classListOf = (el: Element): string[] =>
    Array.from(el.classList)
      .filter((c) => c.length > 1 && c.length < 40 && !/^[a-z]?[a-f0-9]{6,}$/i.test(c))
      .slice(0, 5);

  const signatureOf = (el: Element): string => {
    const classes = classListOf(el).slice().sort();
    return `${el.tagName.toLowerCase()}|${classes.join('.')}`;
  };

  const kindOfSemantic = (el: Element): GeomKind => {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (tag === 'main' || role === 'main') return 'container';
    if (tag === 'section' || role === 'region' || tag === 'article' || role === 'article') return 'section';
    if (tag === 'header' || tag === 'footer' || tag === 'nav' || tag === 'aside' || role === 'banner' || role === 'contentinfo') {
      return 'section';
    }
    return 'block';
  };

  const textOf = (el: Element): string | undefined => {
    const raw = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (raw.length < 2) return undefined;
    return raw.slice(0, 80);
  };

  const mediaOf = (el: Element): GeomNode['media'] | undefined => {
    const box = boxOf(el);
    const aspect = box.h > 0 ? box.w / box.h : 0;
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') {
      const im = el as HTMLImageElement;
      const natW = im.naturalWidth || 0;
      const natH = im.naturalHeight || 0;
      return {
        type: 'img',
        src: (im.currentSrc || im.src || '').slice(0, 200) || undefined,
        naturalW: natW || undefined,
        naturalH: natH || undefined,
        objectFit: getComputedStyle(im).objectFit || undefined,
        aspect,
        naturalAspect: natW > 0 && natH > 0 ? natW / natH : undefined,
      };
    }
    if (tag === 'video') {
      const v = el as HTMLVideoElement;
      return {
        type: 'video',
        src: (v.currentSrc || v.src || '').slice(0, 200) || undefined,
        naturalW: v.videoWidth || undefined,
        naturalH: v.videoHeight || undefined,
        aspect,
        naturalAspect: v.videoWidth > 0 && v.videoHeight > 0 ? v.videoWidth / v.videoHeight : undefined,
      };
    }
    if (tag === 'iframe') {
      return { type: 'iframe', src: (el.getAttribute('src') || '').slice(0, 200) || undefined, aspect };
    }
    if (tag === 'canvas') return { type: 'canvas', aspect };
    return undefined;
  };

  const picked = new Set<Element>();
  const kindMap = new Map<Element, GeomKind>();

  const take = (el: Element, kind: GeomKind) => {
    if (picked.size >= MAX_NODES) return;
    if (picked.has(el) || SKIP_TAG.test(el.tagName)) return;
    if (!visible(el)) return;
    picked.add(el);
    kindMap.set(el, kind);
  };

  for (const el of Array.from(document.querySelectorAll(SEMANTIC))) take(el, kindOfSemantic(el));
  for (const el of Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))) take(el, 'heading');
  for (const el of Array.from(document.querySelectorAll('img,video,iframe,canvas'))) take(el, 'media');

  const all = document.body ? Array.from(document.body.querySelectorAll('*')) : [];
  for (const el of all) {
    if (picked.size >= MAX_NODES) break;
    const kids = Array.from(el.children).filter((c) => !SKIP_TAG.test(c.tagName) && visible(c, 40, 40));
    if (kids.length < 2) continue;
    const bySig = new Map<string, Element[]>();
    for (const k of kids) {
      const sig = signatureOf(k);
      const group = bySig.get(sig) ?? [];
      group.push(k);
      bySig.set(sig, group);
    }
    for (const group of bySig.values()) {
      if (group.length < 2) continue;
      const widths = group.map((g) => g.getBoundingClientRect().width).sort((a, b) => a - b);
      const mid = widths[Math.floor(widths.length / 2)] || 0;
      if (mid < 40) continue;
      const similar = group.filter((g) => Math.abs(g.getBoundingClientRect().width - mid) / mid <= 0.25);
      if (similar.length < 2) continue;
      take(el, kindMap.get(el) ?? 'container');
      for (const k of similar) take(k, kindMap.get(k) ?? 'item');
    }
  }

  // Heading + body often sit in an unsemantic wrapper. Pick that wrapper so
  // Figma↔DOM can compare the content block, not the whole page section.
  for (const h of Array.from(picked)) {
    if (kindMap.get(h) !== 'heading') continue;
    let cur = h.parentElement;
    for (let i = 0; i < 4 && cur && cur !== document.body; i++) {
      if (SKIP_TAG.test(cur.tagName)) {
        cur = cur.parentElement;
        continue;
      }
      const box = boxOf(cur);
      if (box.w >= innerWidth * 0.92 || box.w < 80 || box.h < 40) {
        cur = cur.parentElement;
        continue;
      }
      const body = Array.from(cur.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li')).filter((e) => e !== h && visible(e, 24, 12));
      if (body.length >= 1) {
        take(cur, kindMap.get(cur) ?? 'container');
        break;
      }
      cur = cur.parentElement;
    }
  }

  // Parent of a text wrap that also holds media or another column — needed to
  // compare child inset inside a mapped content/section, not CSS padding alone.
  const wraps = Array.from(picked).filter((el) => kindMap.get(el) === 'container' || kindMap.get(el) === 'block');
  for (const wrap of wraps) {
    let cur = wrap.parentElement;
    for (let i = 0; i < 3 && cur && cur !== document.body; i++) {
      if (SKIP_TAG.test(cur.tagName)) {
        cur = cur.parentElement;
        continue;
      }
      const box = boxOf(cur);
      if (box.w >= innerWidth * 0.92 || box.w < 120 || box.h < 40) {
        cur = cur.parentElement;
        continue;
      }
      const mediaOutside = Array.from(cur.querySelectorAll('img,video,iframe,canvas')).some(
        (m) => visible(m, 40, 40) && !wrap.contains(m),
      );
      const extraCol = Array.from(cur.children).some(
        (c) => c !== wrap && !wrap.contains(c) && !c.contains(wrap) && visible(c, 80, 80),
      );
      if (mediaOutside || extraCol) {
        take(cur, kindMap.get(cur) ?? 'container');
        break;
      }
      cur = cur.parentElement;
    }
  }

  // Layout owner: ancestor that applies padding and holds media + copy.
  // Full-width short bands are allowed; only skip page-tall shells.
  const ownerSeeds = Array.from(picked);
  const pageH = document.documentElement.scrollHeight;
  for (const seed of ownerSeeds) {
    const kind = kindMap.get(seed);
    if (kind !== 'heading' && kind !== 'container' && kind !== 'media' && kind !== 'block') continue;
    let cur = seed.parentElement;
    for (let i = 0; i < 6 && cur && cur !== document.body; i++) {
      if (SKIP_TAG.test(cur.tagName)) {
        cur = cur.parentElement;
        continue;
      }
      const box = boxOf(cur);
      if (box.w < 80 || box.h < 40) {
        cur = cur.parentElement;
        continue;
      }
      if (box.w >= innerWidth * 0.88 && box.h >= pageH * 0.35) {
        cur = cur.parentElement;
        continue;
      }
      const cs = getComputedStyle(cur);
      const hasPad = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].some(
        (v) => (parseFloat(v) || 0) >= 2,
      );
      if (!hasPad) {
        cur = cur.parentElement;
        continue;
      }
      const media = Array.from(cur.querySelectorAll('img,video,iframe,canvas')).some((m) => visible(m, 40, 40));
      const copy = Array.from(cur.querySelectorAll('h1,h2,h3,h4,h5,h6,p')).some((e) => visible(e, 24, 12));
      if (media && copy) take(cur, kindMap.get(cur) ?? 'container');
      cur = cur.parentElement;
    }
  }

  const list = Array.from(picked);
  const idOf = new Map<Element, string>();
  list.forEach((el, i) => idOf.set(el, `n${i}`));

  const nearestPicked = (el: Element): Element | undefined => {
    let cur = el.parentElement;
    while (cur) {
      if (picked.has(cur)) return cur;
      cur = cur.parentElement;
    }
    return undefined;
  };

  const childrenOf = new Map<string | undefined, Element[]>();
  for (const el of list) {
    const p = nearestPicked(el);
    const key = p ? idOf.get(p) : undefined;
    const arr = childrenOf.get(key) ?? [];
    arr.push(el);
    childrenOf.set(key, arr);
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => {
      const aa = a.getBoundingClientRect();
      const bb = b.getBoundingClientRect();
      return aa.top - bb.top || aa.left - bb.left;
    });
  }

  const nodes: GeomNode[] = [];
  for (const el of list) {
    const parent = nearestPicked(el);
    const parentId = parent ? idOf.get(parent) : undefined;
    const sibs = childrenOf.get(parentId) ?? [el];
    const box = boxOf(el);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || undefined;
    const cs = getComputedStyle(el);
    const kind = kindMap.get(el) ?? 'block';
    nodes.push({
      id: idOf.get(el)!,
      parentId,
      siblingIndex: Math.max(0, sibs.indexOf(el)),
      kind,
      tag,
      role: role || undefined,
      locator: locatorOf(el),
      classes: classListOf(el),
      signature: signatureOf(el),
      box,
      ariaHidden: el.closest('[aria-hidden="true"],[inert]') ? true : undefined,
      text: kind === 'media' ? undefined : textOf(el),
      media: kind === 'media' || tag === 'img' || tag === 'video' || tag === 'iframe' || tag === 'canvas' ? mediaOf(el) : undefined,
      style: { display: cs.display, position: cs.position },
      padding: {
        top: Math.round(parseFloat(cs.paddingTop) || 0),
        right: Math.round(parseFloat(cs.paddingRight) || 0),
        bottom: Math.round(parseFloat(cs.paddingBottom) || 0),
        left: Math.round(parseFloat(cs.paddingLeft) || 0),
      },
    });
  }

  nodes.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);

  let content: GeomSnapshot['content'];
  const main = nodes.find((n) => n.tag === 'main' || n.role === 'main');
  if (main) content = { ...main.box, locator: main.locator };
  else {
    const wide = nodes
      .filter((n) => n.box.w >= innerWidth * 0.5 && n.kind !== 'media' && n.tag !== 'header' && n.tag !== 'nav' && n.tag !== 'footer')
      .sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];
    if (wide) content = { ...wide.box, locator: wide.locator };
  }

  return {
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    pageHeight: document.documentElement.scrollHeight,
    content,
    nodes,
  };
}
