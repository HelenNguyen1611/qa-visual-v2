import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { log } from './config.js';

export interface PageTarget {
  url: string;
  /** Figma node id for this page's design, once mapped or set by hand */
  figmaNodeId?: string;
  /** Frame name, kept for readability in pages.json */
  frameName?: string;
  /** How the pairing was decided, or "thủ công" when the human edited it */
  how?: string;
}

const SKIP_EXT = /\.(pdf|zip|jpe?g|png|gif|svg|webp|mp4|mp3|docx?|xlsx?|pptx?|ics|xml|json|txt|css|js)$/i;
const SKIP_PATH = /(\/wp-admin|\/wp-login|\/cart|\/checkout|\/my-account|\/logout|\/feed|\/tag\/|\/author\/|\/page\/\d+|\/category\/)/i;

/** Same site ignoring www. */
function sameHost(a: URL, b: URL) {
  const s = (h: string) => h.replace(/^www\./, '');
  return s(a.host) === s(b.host);
}

export type Fetcher = (url: string) => Promise<string | null>;

async function get(url: string, timeoutMs = 15000): Promise<string | null> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: c.signal, redirect: 'follow' });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch through the browser instead of node's fetch.
 *
 * Necessary, not merely nicer: the machine running the tool often cannot reach the site directly
 * (corporate proxy, VPN-only staging, a sandboxed shell with no egress) while the browser can —
 * and the browser is the thing that proved it can, since it is what takes the screenshots. Node
 * fetch failing then looks exactly like "the site has no sitemap", which is the wrong conclusion.
 */
export function browserFetcher(browser: import('playwright').Browser, ctxOpts: import('playwright').BrowserContextOptions = {}): Fetcher {
  return async (url: string) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...ctxOpts });
    const page = await ctx.newPage();
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (!res || !res.ok()) return null;
      return await res.text();
    } catch {
      return null;
    } finally {
      await ctx.close().catch(() => {});
    }
  };
}

/** Same-site page links in the DOM, in document order. Used when the site has no sitemap. */
export async function fromLinks(
  browser: import('playwright').Browser,
  siteUrl: string,
  limit: number,
  ctxOpts: import('playwright').BrowserContextOptions = {},
): Promise<string[]> {
  const base = new URL(siteUrl);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...ctxOpts });
  const page = await ctx.newPage();
  let hrefs: string[] = [];
  try {
    await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200); // let a JS-built nav appear
    hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => (a as HTMLAnchorElement).href));
  } catch {
    /* fall through with whatever we got */
  } finally {
    await ctx.close().catch(() => {});
  }
  const keep = normalise(hrefs, base, limit);
  log(keep.length ? `liên kết trên trang chủ → ${keep.length} trang` : 'không thấy liên kết nội bộ nào trên trang chủ');
  return keep;
}

/** Filter a raw URL list down to real, distinct pages of this site, most important first. */
function normalise(urls: string[], base: URL, limit: number): string[] {
  const seen = new Set<string>();
  const keep: string[] = [];
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw, base);
    } catch {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (!sameHost(u, base)) continue;
    if (SKIP_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname)) continue;
    u.hash = '';
    u.search = '';
    // http and https of one path are ONE page.
    const key = u.host.replace(/^www\./, '') + (u.pathname.replace(/\/+$/, '') || '/');
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push(u.toString());
  }
  // Homepage first, then shallowest paths — the important pages come first if we hit the limit.
  keep.sort((a, b) => {
    const d = (s: string) => new URL(s).pathname.split('/').filter(Boolean).length;
    return d(a) - d(b) || a.localeCompare(b);
  });
  return keep.slice(0, limit);
}

/** Drop repeats of the same page (trailing slash, scheme and www do not make a new page). */
export function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    try {
      const u = new URL(raw);
      const key = u.host.replace(/^www\./, '') + (u.pathname.replace(/\/+$/, '') || '/');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(raw);
    } catch {}
  }
  return out;
}

const locs = (xml: string) => Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => m[1]);

/**
 * Read the site's own sitemap instead of crawling. One request (a few for a sitemap index),
 * no link-following logic, and it gives the pages the site itself considers real.
 */
export async function fromSitemap(siteUrl: string, limit: number, fetcher: Fetcher = get): Promise<string[]> {
  const base = new URL(siteUrl);
  const candidates = ['/sitemap.xml', '/wp-sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];
  let xml: string | null = null;
  let used = '';
  for (const path of candidates) {
    xml = await fetcher(new URL(path, base).toString());
    if (xml && /<(urlset|sitemapindex)/i.test(xml)) {
      used = path;
      break;
    }
    xml = null;
  }
  if (!xml) {
    log('sitemap: không tìm thấy — chuyển sang dò liên kết trên trang chủ');
    return [];
  }

  let urls: string[] = [];
  if (/<sitemapindex/i.test(xml)) {
    // An index points at child sitemaps; read a few, preferring page/post ones.
    const children = locs(xml)
      .sort((a, b) => Number(/page|post/i.test(b)) - Number(/page|post/i.test(a)))
      .slice(0, 4);
    for (const child of children) {
      const sub = await fetcher(child);
      if (sub) urls.push(...locs(sub));
      if (urls.length > limit * 4) break;
    }
    log(`sitemap: ${used} (index, ${children.length} sitemap con) → ${urls.length} URL`);
  } else {
    urls = locs(xml);
    log(`sitemap: ${used} → ${urls.length} URL`);
  }

  return normalise(urls, base, limit);
}

/** A stable folder name for one URL, used to keep each page's approved baseline separate. */
export function slugOf(url: string): string {
  try {
    const u = new URL(url);
    const p = (u.pathname.replace(/\/+$/, '') || 'home').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    return (p || 'home').slice(0, 60).toLowerCase();
  } catch {
    return 'page';
  }
}

export function pagesJsonPath(cwd = process.cwd()) {
  return resolve(cwd, 'pages.json');
}

export function readPagesJson(cwd = process.cwd()): PageTarget[] | null {
  const p = pagesJsonPath(cwd);
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    const arr = Array.isArray(d) ? d : d.pages;
    if (!Array.isArray(arr)) return null;
    return arr.filter((x: any) => typeof x?.url === 'string');
  } catch (e: any) {
    log(`pages.json không đọc được: ${e?.message ?? e}`);
    return null;
  }
}

export function writePagesJson(targets: PageTarget[], cwd = process.cwd()) {
  const body = {
    _: 'Ghép URL với frame Figma. Tool sinh file này lần đầu; sửa dòng nào sai rồi lần sau tool dùng nguyên file này, không đoán lại. Bỏ figmaNodeId nếu muốn trang đó không so với design.',
    pages: targets,
  };
  writeFileSync(pagesJsonPath(cwd), JSON.stringify(body, null, 2));
}
