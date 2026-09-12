import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which site a run belongs to.
 *
 * Host + port, with www stripped and the hostname lowercased. Protocol is kept: a local http
 * staging box and the https production site are different projects, and collapsing them would
 * compare the wrong baselines. Path is ignored — `/` and `/about/` are the same site.
 */
export function siteKey(raw: string | undefined | null): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!host) return '';
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const implicit = (u.protocol === 'https:' && port === '443') || (u.protocol === 'http:' && port === '80');
    return `${u.protocol}//${host}${implicit ? '' : ':' + port}`;
  } catch {
    return '';
  }
}

export function sameSite(a?: string | null, b?: string | null): boolean {
  const key = siteKey(a);
  return Boolean(key) && key === siteKey(b);
}

/** Site URL stored on a report — current files use `site`, the oldest ones used `url`. */
export function reportSite(r: { site?: unknown; url?: unknown; pages?: Array<{ url?: unknown }> }): string {
  if (typeof r.site === 'string' && r.site) return r.site;
  if (typeof r.url === 'string' && r.url) return r.url;
  const page = r.pages?.[0]?.url;
  return typeof page === 'string' ? page : '';
}

/** Host:port as a person would read it in a folder list. */
export function siteHost(raw: string | undefined | null): string {
  try {
    return new URL(raw || '').host.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * One page of a site, for "already QA'd" and for drift overlap.
 *
 * Trailing slash and `www` drop out; query strings drop out too — `/about` and `/about?ref=1`
 * are the same page to check. Protocol stays, same reason as siteKey.
 */
export function pageKey(raw: string | undefined | null): string {
  const site = siteKey(raw);
  if (!site || !raw) return '';
  try {
    const path = new URL(raw).pathname.replace(/\/+$/, '') || '/';
    return site + path;
  } catch {
    return site;
  }
}

export function reportPageUrls(r: { pages?: unknown; url?: unknown }): string[] {
  if (Array.isArray(r.pages)) {
    return r.pages.map((p: unknown) => (p && typeof p === 'object' && typeof (p as { url?: unknown }).url === 'string' ? (p as { url: string }).url : '')).filter(Boolean);
  }
  if (typeof r.url === 'string' && r.url) return [r.url];
  return [];
}

/** Timestamp folders under reports/, oldest first. `_approved` / `_design` do not match. */
export function listRunStamps(root: string, before?: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => /^\d{4}-/.test(d) && (!before || d < before) && existsSync(join(root, d, 'report.json')))
    .sort();
}

export interface RunSummary {
  stamp: string;
  site: string;
  host: string;
  when: string;
  findings: number;
  hasShare: boolean;
  hasNotes: boolean;
}

export function summarizeRun(root: string, stamp: string): RunSummary | null {
  try {
    const dir = join(root, stamp);
    const r = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    const site = reportSite(r);
    const findings = Array.isArray(r.findings) ? r.findings.filter((f: { accepted?: boolean }) => !f.accepted).length : 0;
    return {
      stamp,
      site,
      host: siteHost(site) || stamp,
      when: typeof r.when === 'string' ? r.when : stamp,
      findings,
      hasShare: existsSync(join(dir, 'report-share.html')),
      hasNotes: typeof r.humanNotes === 'string' && Boolean(r.humanNotes.trim()),
    };
  } catch {
    return null;
  }
}

export function listRunSummaries(root: string, opts?: { before?: string; site?: string }): RunSummary[] {
  const want = siteKey(opts?.site);
  const out: RunSummary[] = [];
  for (const stamp of listRunStamps(root, opts?.before)) {
    const row = summarizeRun(root, stamp);
    if (!row) continue;
    if (want && !sameSite(row.site, opts?.site)) continue;
    out.push(row);
  }
  return out;
}

export interface PageSeen {
  url: string;
  key: string;
  stamp: string;
  when: string;
}

/** Latest run that included each URL of this site — used to tick "already QA'd" on the pairing table. */
export function listPageCoverage(root: string, site: string): PageSeen[] {
  const byKey = new Map<string, PageSeen>();
  if (!siteKey(site)) return [];
  for (const row of listRunSummaries(root, { site })) {
    let urls: string[] = [];
    try {
      const r = JSON.parse(readFileSync(join(root, row.stamp, 'report.json'), 'utf8'));
      urls = reportPageUrls(r);
    } catch {
      continue;
    }
    for (const url of urls) {
      const key = pageKey(url);
      if (!key) continue;
      byKey.set(key, { url, key, stamp: row.stamp, when: row.when });
    }
  }
  return [...byKey.values()];
}
