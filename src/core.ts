import { mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import type { Browser } from 'playwright';
import { log, VIEWPORTS, progressTotal, progressTick, progressSay, type Config, type ViewportName } from './config.js';
import { launch, captureAll, type Capture } from './capture.js';
import { sweep, type SweepResult } from './sweep.js';
import { compare } from './compare.js';
import { renderReport, type RunReport, type PageReport, type ViewportReport } from './report.js';
import { loadDesignFrames, renderFigmaFrames, fetchFigmaOverlay, parseFigmaLink, type FigmaFrame, type FigmaOverlay } from './design.js';
import { fromSitemap, fromLinks, browserFetcher, dedupeUrls, slugOf, applyPreservedQuery, withPreservedQuery, type PageTarget } from './pages.js';
import { pairDesktopAndMobile, pickDesign, looksMispaired, type Mapped } from './mapping.js';
import { detectShared } from './shared.js';
import { groupFindings, markDrift, type Occurrence, type GroupedFinding } from './group.js';
import { createProvider, aiStopped, resetAiCircuit, aiMaxInflight, preflight, type VisionProvider } from './provider.js';
import { detectAll } from './verify.js';
import { applyAccepted, readAccepted } from './accepted.js';
import { compareWithDesign, compareSelf, looksNonEnglish } from './ai.js';
import { annotateCrop } from './annotate.js';
import { locate } from './locate.js';
import { prepareAuth, authOptions } from './auth.js';
import { nowQa } from './time.js';
import { listPageCoverage, listRunStamps, pageKey, reportPageUrls, reportSite, sameSite, siteKey } from './site.js';

/**
 * The engine, with no opinion about how it is driven.
 *
 * Two entry points — work out the pairing, then run the QA on a pairing someone approved. The CLI
 * and the web server are both thin shells over these; keeping the logic here is what stops the two
 * front ends from slowly growing different behaviour.
 */

/** Run a few pages at a time — a browser context each, but not so many that the machine crawls. */
export async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/* ================================ discover ================================ */

export interface DiscoveredFrame {
  id: string;
  name: string;
  width: number;
  height: number;
  /** file on disk, when rendered */
  file?: string;
  /** basename the server can serve as a thumbnail */
  thumb?: string;
  role?: FigmaFrame['role'];
  fileKey?: string;
}

export interface Discovery {
  pages: PageTarget[];
  frames: DiscoveredFrame[];
  /** how the page list came about, for the UI to show */
  pagesFrom: string;
}

/** The page list for a site: its sitemap if it has one, else the links on its homepage. */
export async function findPages(browser: Browser, siteUrl: string, maxPages: number, cfg?: Config): Promise<{ urls: string[]; from: string }> {
  // The sitemap and the homepage's nav are the first two things a login gate hides, so both have
  // to be fetched as a logged-in visitor — otherwise a protected site looks like a one-page site.
  const opts = authOptions(cfg?.authState);
  const preserveQuery = cfg?.preserveQuery ?? [];
  let urls = await fromSitemap(siteUrl, maxPages, browserFetcher(browser, opts), preserveQuery);
  let from = 'sitemap.xml';
  if (!urls.length) {
    urls = await fromLinks(browser, siteUrl, maxPages, opts, preserveQuery);
    from = 'homepage links';
  }
  urls = applyPreservedQuery(dedupeUrls([siteUrl, ...urls]), siteUrl, preserveQuery).slice(0, maxPages);
  if (preserveQuery.length) log(`preserve query: ${preserveQuery.join(', ')}`);

  if (urls.length <= 1) {
    log('⚠ only found 1 page. Three common causes, in order:');
    log('  1. The site needs a login → sitemap returns 401 and the homepage is a login page. Paste a URL with user/password:');
    log('     https://user:password@' + new URL(siteUrl).host + '/   (or QA_HTTP_USER / QA_HTTP_PASS in .env)');
    log('  2. The menu is built in JS and was not ready — retry, or add URLs by hand in the pairing table.');
    log('  3. The site really is one page.');
  } else if (urls.length >= maxPages) {
    log(`hit the ${maxPages}-page limit — raise "Max pages" (or --pages) if the site has more`);
  }
  return { urls, from };
}

/**
 * Work out which URL goes with which design frame, and render every candidate frame.
 *
 * Every candidate, not only the ones that won a pairing: the whole point of showing this in a
 * browser is that a person judges the pairing by looking at the design, and they cannot judge a
 * frame that was never rendered. The renders are cached by file+node, so this is paid once.
 */
export async function discover(cfg: Config): Promise<Discovery> {
  const browser = await launch(cfg);
  try {
    const site = cfg.site ?? cfg.url;
    cfg.authState = await prepareAuth(browser, site, cfg.auth);
    const { urls, from } = await findPages(browser, site, cfg.maxPages, cfg);
    log(`${urls.length} pages: ${urls.map((u) => {
      try {
        const x = new URL(u);
        return x.pathname + x.search;
      } catch {
        return u;
      }
    }).join(', ')}`);

    const frames = await loadDesignFrames(cfg);
    const mapped = pairDesktopAndMobile(urls, frames);
    const rendered = await renderAll(cfg, frames);

    return {
      pages: mapped.map((m) => ({
        url: m.url,
        figmaNodeId: m.figmaNodeId,
        frameName: m.frameName,
        figmaMobileNodeId: m.figmaMobileNodeId,
        frameMobileName: m.frameMobileName,
        how: m.how,
      })),
      frames: frames.map((f) => withThumb(f, rendered)),
      pagesFrom: from,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

function withThumb(f: FigmaFrame, rendered: Map<string, string>): DiscoveredFrame {
  const file = f.file ?? rendered.get(f.id);
  return {
    id: f.id,
    name: f.name,
    width: f.width,
    height: f.height,
    file,
    thumb: file ? basename(file) : undefined,
    role: f.role,
    fileKey: f.fileKey,
  };
}

function figmaLinkFor(cfg: Config, f: FigmaFrame): string | undefined {
  const key = f.fileKey;
  if (f.role === 'mobile') {
    if (cfg.figmaMobile && (!key || parseFigmaLink(cfg.figmaMobile).fileKey === key)) return cfg.figmaMobile;
    if (cfg.figma && key && parseFigmaLink(cfg.figma).fileKey === key) return cfg.figma;
    return cfg.figmaMobile ?? cfg.figma;
  }
  if (cfg.figma && (!key || parseFigmaLink(cfg.figma).fileKey === key)) return cfg.figma;
  if (cfg.figmaMobile && key && parseFigmaLink(cfg.figmaMobile).fileKey === key) return cfg.figmaMobile;
  return cfg.figma ?? cfg.figmaMobile;
}

/** Render frames to PNG (Figma) or take the files as they are (design folder). */
export async function renderAll(cfg: Config, frames: FigmaFrame[]): Promise<Map<string, string>> {
  if (!frames.length) return new Map();
  const out = new Map<string, string>();
  for (const f of frames) if (f.file) out.set(f.id, f.file);
  if (!cfg.figma && !cfg.figmaMobile) return out;

  const groups = new Map<string, FigmaFrame[]>();
  for (const f of frames) {
    if (f.file) continue;
    const link = figmaLinkFor(cfg, f);
    if (!link) continue;
    const list = groups.get(link) ?? [];
    list.push(f);
    groups.set(link, list);
  }
  for (const [link, list] of groups) {
    const part = await renderFigmaFrames(link, list, cfg.figmaToken, designCache(cfg)).catch((e) => {
      log(`Figma render: ${e?.message ?? e}`);
      return new Map<string, string>();
    });
    for (const [k, v] of part) out.set(k, v);
  }
  return out;
}

export const designCache = (cfg: Config) => join(cfg.stateDir, '_design');

/** Path only — a progress label has one line to work with. */
const shortPath = (u: string) => {
  try {
    return new URL(u).pathname || '/';
  } catch {
    return u;
  }
};

/** Findings that still count. Anything signed off in accepted.json is reported but not counted. */
export const openFindings = (r: Pick<RunReport, 'findings'>) => r.findings.filter((f) => !f.accepted);

/**
 * The most recent completed run of the SAME site that shares at least one URL with this batch.
 *
 * Folder names are just timestamps, so two clients share one reports/ tree. Matching on site
 * (host + port) is what stops a Woo Agency run being told that Example.com's bugs "vanished".
 * A later batch of different pages is skipped too — otherwise every unchecked page looks "fixed".
 * Runs whose AI calls all failed are skipped: comparing against a run that never got an answer
 * would report every real defect as "new", which is the opposite of useful.
 */
function previousRun(
  cfg: Config,
  currentStamp: string,
  currentUrls: string[],
): { stamp: string; findings: GroupedFinding[] } | null {
  const want = siteKey(cfg.site ?? cfg.url);
  if (!want) return null;
  const currentKeys = new Set(currentUrls.map(pageKey).filter(Boolean));
  try {
    const stamps = listRunStamps(cfg.stateDir, currentStamp);
    for (let i = stamps.length - 1; i >= 0; i--) {
      const r = JSON.parse(readFileSync(join(cfg.stateDir, stamps[i], 'report.json'), 'utf8'));
      if (!sameSite(reportSite(r), cfg.site ?? cfg.url)) continue;
      const usable = !r.ai || r.ai.failures < r.ai.calls;
      if (!usable || !Array.isArray(r.findings)) continue;
      // A disjoint batch is not "last time" — comparing against it marks every skipped page's
      // bugs as vanished. Skip until a run that actually shares a URL with this one.
      const prevKeys = reportPageUrls(r).map(pageKey).filter(Boolean);
      if (currentKeys.size && prevKeys.length && !prevKeys.some((k) => currentKeys.has(k))) continue;
      return { stamp: stamps[i], findings: r.findings };
    }
  } catch {}
  return null;
}

function findingTouchesBatch(g: GroupedFinding, batch: Set<string>): boolean {
  if (!g.pages?.length) return true;
  return g.pages.some((u) => batch.has(pageKey(u)));
}

/* ================================== run =================================== */

function designRef(runDir: string, rendered: Map<string, string>, target: Mapped, viewport: ViewportName): ViewportReport['design'] {
  const pick = pickDesign(viewport, target);
  if (!pick) return undefined;
  const file = rendered.get(pick.frame.id);
  if (!file) return undefined;
  return { file: relative(runDir, file), mode: pick.mode, source: pick.frame.name, width: pick.frame.width };
}

function resolveFrame(frames: FigmaFrame[], id?: string, name?: string, role?: FigmaFrame['role']): FigmaFrame | undefined {
  const pool = role ? frames.filter((f) => f.role === role) : frames;
  const search = pool.length ? pool : frames;
  const byName = name ? search.find((f) => f.name === name) : undefined;
  const byId = id ? search.find((f) => f.id === id) : undefined;
  return byName ?? byId ?? (name ? frames.find((f) => f.name === name) : undefined) ?? (id ? frames.find((f) => f.id === id) : undefined);
}

/** Phase 1 for one URL: capture the three viewports and diff each against that URL's own baseline. */
async function capturePage(
  browser: Browser,
  cfg: Config,
  runDir: string,
  approvedRoot: string,
  target: Mapped,
  rendered: Map<string, string>,
): Promise<{ page: PageReport; caps: Capture[]; pageDir: string }> {
  const slug = slugOf(target.url);
  const pageDir = join(runDir, slug);
  const caps = await captureAll(browser, { ...cfg, url: target.url }, pageDir);
  // Each URL keeps its OWN approved baseline — one shared folder would have every page
  // overwriting the previous one's reference.
  const approvedDir = join(approvedRoot, slug);
  const deskFile = target.frame ? rendered.get(target.frame.id) : undefined;

  const viewports: ViewportReport[] = [];
  for (const cap of caps) {
    const baseline = join(approvedDir, `${cap.viewport}.png`);
    const diff = compare(existsSync(baseline) ? baseline : undefined, cap.file, cap.media, join(pageDir, `${cap.viewport}.diff.png`));
    const failedSet = new Set(cap.failedRequests.map((f) => f.split(' ').pop()!.split('?')[0]));
    viewports.push({
      name: cap.viewport,
      width: cap.width,
      shot: relative(runDir, cap.file),
      pageHeight: cap.pageHeight,
      diff: { ...diff, diffRel: diff.diffFile ? relative(runDir, diff.diffFile) : undefined },
      design: designRef(runDir, rendered, target, cap.viewport),
      brokenImages: cap.media.filter((m) => m.kind === 'img' && m.broken),
      distortedImages: cap.media.filter((m) => m.kind === 'img' && (m.distortion ?? 0) > 0.15),
      failedBackgrounds: cap.media
        .filter((m) => m.kind === 'background' && m.src && failedSet.has(m.src.split('?')[0]))
        .map((m) => {
          const line = cap.failedRequests.find((f) => f.includes(m.src!.split('?')[0])) ?? '';
          const why = line.startsWith('HTTP') ? line.split(' ').slice(0, 2).join(' ') : line.split(' ')[0] || 'failed';
          return { ...m, why };
        }),
      mediaRegions: cap.media,
      reserved: cap.reserved,
      textIndex: cap.textIndex,
    });
  }

  return {
    page: {
      url: target.url,
      slug,
      title: caps[0]?.title ?? '',
      viewports,
      mapping: {
        frameName: target.frameName,
        frameWidth: target.frame?.width,
        frameMobileName: target.frameMobileName,
        frameMobileWidth: target.mobileFrame?.width,
        how: target.how,
        score: target.score,
        isTemplate: target.isTemplate,
      },
      designFile: deskFile ? relative(runDir, deskFile) : undefined,
      designMobileFile: target.mobileFrame && rendered.get(target.mobileFrame.id)
        ? relative(runDir, rendered.get(target.mobileFrame.id)!)
        : undefined,
      mispaired: false,
      failedRequests: caps[0]?.failedRequests ?? [],
      jsErrors: caps[0]?.jsErrors ?? [],
    } as PageReport,
    caps,
    pageDir,
  };
}

/**
 * The measured pass for one URL: defects the browser's own numbers prove.
 *
 * Runs on every page whether or not there is a model, a design, or an API key — which is the
 * point. These findings carry their own box, so they never depend on `locate` matching quoted
 * text, and they are the part of the report that reads the same on every run.
 */
function measurePage(runDir: string, pageDir: string, page: PageReport, overlay?: FigmaOverlay): Occurrence[] {
  const out: Occurrence[] = [];
  for (const v of page.viewports) {
    const vpH = VIEWPORTS.find((x) => x.name === v.name)?.height ?? 900;
    const design = v.name === 'desktop' ? overlay : undefined;
    for (const m of detectAll(v.textIndex, v.mediaRegions, v.reserved, v.width, vpH, design)) {
      const n = out.length + 1;
      const res = annotateCrop(join(runDir, v.shot), m.box, n, join(pageDir, `${v.name}.m${n}.png`));
      if (res) m.finding.crop = relative(runDir, res.file);
      out.push({ url: page.url, viewport: v.name, finding: m.finding });
    }
  }
  return out;
}

/**
 * Phase 2 for one URL: ask the model about the design, but tell it which y bands are the shared
 * header/footer already reviewed on another page. Without that it re-describes the same footer on
 * every page — wasted tokens, and wasted model attention that should go to the page's own content.
 */
async function analysePage(
  runDir: string,
  pageDir: string,
  page: PageReport,
  target: Mapped,
  rendered: Map<string, string>,
  provider: VisionProvider,
  skipBands: Array<{ from: number; to: number; where: string }>,
): Promise<{ occurrences: Occurrence[]; aiError?: string; mispaired: boolean }> {
  const occurrences: Occurrence[] = [];
  let aiError: string | undefined;
  let mispaired = false;
  const viewports = page.viewports;
  const hasAnyDesign = Boolean((target.frame && rendered.get(target.frame.id)) || (target.mobileFrame && rendered.get(target.mobileFrame.id)));

  if (hasAnyDesign) {
    const titles: string[] = [];
    await Promise.all(
      viewports.map(async (v) => {
        const pick = pickDesign(v.name as ViewportName, target);
        const designFile = pick ? rendered.get(pick.frame.id) : undefined;
        if (!pick || !designFile) {
          progressTick(`AI vs design · ${v.name} · ${shortPath(page.url)}`, 'ai');
          return;
        }
        const vpH = VIEWPORTS.find((x) => x.name === v.name)?.height ?? 900;
        try {
          const found = await compareWithDesign(
            provider,
            join(runDir, v.shot),
            designFile,
            pick.mode,
            v.width,
            pick.frame.width,
            vpH,
            v.mediaRegions,
            skipBands,
          );
          for (const f of found) {
            titles.push(f.title);
            const loc = locate(f.anchors, v.textIndex, f.y);
            if (loc) {
              f.locatedHow = loc.how;
              const res = annotateCrop(join(runDir, v.shot), loc.box, occurrences.length + 1, join(pageDir, `${v.name}.f${occurrences.length + 1}.png`));
              if (res) f.crop = relative(runDir, res.file);
            }
            occurrences.push({ url: page.url, viewport: v.name, finding: f });
          }
        } catch (e: any) {
          aiError = String(e?.message ?? e).slice(0, 200);
        }
        progressTick(`AI vs design · ${v.name} · ${shortPath(page.url)}`, 'ai');
      }),
    );
    mispaired = looksMispaired(titles);
  }

  // The desktop↔mobile self-check is a fourth API call per page. When a design exists it mostly
  // re-finds what the three design comparisons already said, so it is spent only where it is the
  // ONLY check available — a page with no design frame. That is 4 calls per page down to 3.
  const d = viewports.find((v) => v.name === 'desktop');
  const m = viewports.find((v) => v.name === 'mobile');
  if (d && m && !hasAnyDesign) {
    try {
      const mH = VIEWPORTS.find((x) => x.name === 'mobile')?.height ?? 844;
      const found = await compareSelf(provider, join(runDir, d.shot), join(runDir, m.shot), mH, m.mediaRegions);
      for (const f of found) {
        const loc = locate(f.anchors, m.textIndex, f.y);
        if (loc) {
          f.locatedHow = loc.how;
          const res = annotateCrop(join(runDir, m.shot), loc.box, occurrences.length + 1, join(pageDir, `self.f${occurrences.length + 1}.png`));
          if (res) f.crop = relative(runDir, res.file);
        }
        occurrences.push({ url: page.url, viewport: 'mobile', finding: f });
      }
    } catch {
      /* self-compare is a bonus; never fail the page for it */
    }
    progressTick(`AI desktop↔mobile · ${shortPath(page.url)}`, 'ai');
  }
  return { occurrences, aiError, mispaired };
}

export interface RunOutcome {
  runDir: string;
  reportPath: string;
  stamp: string;
  report: RunReport;
}

/**
 * Run the QA on a pairing that has already been settled.
 *
 * The pairing arrives as rows, not as a file, so the caller decides where it came from: the CLI
 * reads pages.json, the web UI hands over what the human just edited on screen.
 */
export async function runQa(cfg: Config, rows: PageTarget[], frames: FigmaFrame[]): Promise<RunOutcome> {
  const t0 = Date.now();
  const clock = nowQa();
  const stamp = clock.stamp;
  const runDir = join(cfg.stateDir, stamp);
  const approvedRoot = join(cfg.stateDir, '_approved');
  const seed = cfg.site ?? cfg.url;
  if (cfg.preserveQuery.length) {
    rows = rows.map((p) => {
      try {
        return { ...p, url: withPreservedQuery(p.url, seed, cfg.preserveQuery) };
      } catch {
        return p;
      }
    });
    log(`preserve query: ${cfg.preserveQuery.join(', ')}`);
  }

  const mapped: Mapped[] = rows.map((p) => {
    // A hand-edited row names the frame; the id is what the tool wrote. Name wins, because the
    // name is the part a person can actually pick correctly.
    const frame = resolveFrame(frames, p.figmaNodeId, p.frameName, 'desktop');
    const mobileFrame = resolveFrame(frames, p.figmaMobileNodeId, p.frameMobileName, 'mobile');
    const how =
      p.how ??
      (frame || mobileFrame
        ? `hand-paired: "${frame?.name ?? '—'}"${mobileFrame ? ` · mobile “${mobileFrame.name}”` : ''}`
        : 'no design pair → responsive checks only');
    return {
      ...p,
      frame,
      mobileFrame,
      frameName: frame?.name ?? p.frameName,
      figmaNodeId: frame?.id ?? p.figmaNodeId,
      frameMobileName: mobileFrame?.name ?? p.frameMobileName,
      figmaMobileNodeId: mobileFrame?.id ?? p.figmaMobileNodeId,
      score: 1,
      runnerUp: 0,
      isTemplate: false,
      how,
    } as Mapped;
  });
  const urls = mapped.map((m) => m.url);

  const usedFrames = mapped.flatMap((m) => [m.frame, m.mobileFrame]).filter(Boolean) as FigmaFrame[];
  const rendered = await renderAll(cfg, usedFrames);

  const provider = createProvider(cfg);
  resetAiCircuit(Boolean(cfg.aiFast));
  if (provider) log(`AI ${provider.name}/${provider.model}`);
  // Check the key and the model choice before spending a run discovering they cannot work.
  if (provider) await preflight(cfg, (l) => log(l));
  if (provider && cfg.aiFast) log(`fast mode: up to ${aiMaxInflight()} AI calls at once (same number of calls, no extra tokens unless a retry)`);

  // Size the bar before starting: 3 screenshots per page, then the model calls that page will
  // actually make (3 when it has a design to compare against, 1 self-check when it does not),
  // plus the closing steps.
  const aiPerPage = (m: Mapped) => {
    if (!provider) return 0;
    const has = (m.frame && rendered.get(m.frame.id)) || (m.mobileFrame && rendered.get(m.mobileFrame.id));
    return has ? VIEWPORTS.length : 1;
  };
  const plan = {
    capture: mapped.length * VIEWPORTS.length,
    ai: mapped.reduce((n, m) => n + aiPerPage(m), 0),
    wrap: mapped.length + 1,
  };
  progressTotal(plan);
  log(`plan: ${mapped.length} pages × ${VIEWPORTS.length} viewports = ${plan.capture} shots · ${plan.ai} AI calls · ${plan.wrap} wrap-up steps = ${plan.capture + plan.ai + plan.wrap} steps`);

  mkdirSync(runDir, { recursive: true });
  const browser = await launch(cfg);
  let report: RunReport;

  // The run may start from a saved pairing, with no discover to have opened the gate.
  if (!cfg.authState) cfg.authState = await prepareAuth(browser, cfg.site ?? cfg.url, cfg.auth);

  try {
    // ---- phase 1: capture everything first. The template can only be identified by comparing pages.
    const captured = await pool(mapped, cfg.concurrency, (m) => capturePage(browser, cfg, runDir, approvedRoot, m, rendered));

    // ---- what is template chrome, from counting text across pages
    const shared = detectShared(
      captured.map((r) => ({
        url: r.page.url,
        textIndex: r.page.viewports.find((v) => v.name === 'mobile')?.textIndex ?? [],
        pageHeight: r.page.viewports.find((v) => v.name === 'mobile')?.pageHeight ?? 0,
      })),
    );
    if (shared.texts.size) log(`shared chrome: ${shared.texts.size} strings present on ≥60% of pages`);

    const overlays = new Map<string, FigmaOverlay>();
    if (cfg.figma && cfg.figmaToken) {
      const ids = [...new Set(mapped.map((m) => m.figmaNodeId).filter((id): id is string => Boolean(id)))];
      for (const id of ids) {
        try {
          const tree = await fetchFigmaOverlay(cfg.figma, id, cfg.figmaToken);
          overlays.set(id, tree);
          log(`Figma overlay: ${id} — ${tree.surfaces.length} image surfaces, ${tree.texts.length} texts`);
        } catch (e: any) {
          log(`Figma overlay: ${e?.message ?? e}`);
        }
      }
    }

    const allOccurrences: Occurrence[] = [];

    // ---- the measured pass: what the browser's numbers prove, with or without a model
    for (let i = 0; i < captured.length; i++) {
      const r = captured[i];
      const id = mapped[i]?.figmaNodeId;
      allOccurrences.push(...measurePage(runDir, r.pageDir, r.page, id ? overlays.get(id) : undefined));
    }
    const measuredCount = allOccurrences.length;
    if (measuredCount) log(`measured on DOM: ${measuredCount} findings with numeric proof (overlapping text, type hierarchy, first-screen gap, peer image aspect, banner inset)`);

    // ---- phase 2: the AI pass. The first page reviews the whole thing; later pages are told to
    // skip the shared header/footer, so the same component is not described over and over.
    if (provider) {
      let reviewedTemplate = false;
      await pool(captured, cfg.concurrency, async (r, i) => {
        const m = mapped[i];
        const bands = reviewedTemplate ? (shared.bands.get(r.page.url) ?? []) : [];
        if (!reviewedTemplate) reviewedTemplate = true;
        const res = await analysePage(runDir, r.pageDir, r.page, m, rendered, provider, bands);
        r.page.aiError = res.aiError;
        r.page.mispaired = res.mispaired;
        allOccurrences.push(...res.occurrences);
      });
    }

    // ---- a model that answers "nothing wrong" to every single question is not a clean site
    //
    // 12 calls, 0 failures, 0 findings, on a site the previous run found 8 real defects on. The
    // API said yes to everything and the model said nothing every time — which reads in the
    // report as good news and is the opposite. Successful calls are not the same as a real answer.
    // Measured findings are not evidence the model said anything, so they must not count here —
    // otherwise one DOM-proved overlap hides the fact that the model answered nothing, all run.
    const aiFindingCount = allOccurrences.length - measuredCount;
    const silentModel = Boolean(provider) && provider!.calls >= 3 && provider!.failures === 0 && aiFindingCount === 0;
    if (silentModel) {
      log(`⚠ ${provider!.calls}/${provider!.calls} AI calls SUCCEEDED but the model reported no findings.`);
      log(`  Model "${provider!.model}" is likely too weak for image compare — not a clean site. Change QA_AI_MODEL and re-run.`);
    }

    // ---- did the model answer in the language it was told to?
    const wrongLang = allOccurrences.filter((o) => !o.finding.measured && looksNonEnglish(o.finding)).length;
    if (wrongLang) log(`⚠ ${wrongLang}/${aiFindingCount} comments are NOT in English — the model ignored the language rule. Findings are kept; consider switching models.`);

    // ---- one finding per defect
    const grouped = groupFindings(allOccurrences, shared);

    // ---- deviations a human has already ruled intended, greyed out rather than hidden
    const acceptedCount = applyAccepted(grouped, readAccepted());
    if (acceptedCount) log(`accepted.json: ${acceptedCount} findings signed off as intentional — still shown, not counted`);

    // ---- what changed since last time. A model does not answer identically twice, so a defect can
    // vanish from the list with nothing having changed on the site. Say so instead of hiding it.
    const prev = previousRun(cfg, stamp, urls);
    let drift: RunReport['drift'];
    if (prev) {
      const batch = new Set(urls.map(pageKey).filter(Boolean));
      const comparable = prev.findings.filter((g) => findingTouchesBatch(g, batch));
      const { gone } = markDrift(grouped, comparable);
      drift = { previousRun: prev.stamp, gone: gone.map((g) => ({ title: g.title, severity: g.severity, scope: g.scope })) };
      const fresh = grouped.filter((g) => g.isNew).length;
      log(`vs run ${prev.stamp} (overlapping pages): ${fresh} new, ${grouped.length - fresh} still open, ${gone.length} gone since last time`);
    }
    const templateCount = grouped.filter((g) => g.scope === 'template').length;
    const measuredGroups = grouped.filter((g) => g.measured).length;
    log(
      `grouped: ${allOccurrences.length} raw notes → ${grouped.length} findings (${templateCount} on shared components, ${measuredGroups} with measured proof)`,
    );

    // ---- sweep every page in this run for the width where layout breaks
    // Homepage-only missed overflow that only exists on an inner URL (and only between the
    // three screenshot widths). The detector is unchanged; it just sees the same URLs capture used.
    progressSay('Sweeping widths for the layout break point', 'wrap');
    const sweeps: Array<{ url: string } & SweepResult> = [];
    for (const url of urls) {
      progressSay(`Sweeping widths · ${shortPath(url)}`, 'wrap');
      const s = await sweep(browser, url, authOptions(cfg.authState)).catch(() => null);
      if (s) sweeps.push({ url, ...s });
      progressTick(`Width sweep · ${shortPath(url)}`, 'wrap');
    }

    // ---- approve
    const firstEver = !existsSync(join(approvedRoot, slugOf(urls[0]), 'meta.json'));
    const approvedThisRun = cfg.approve || firstEver;
    if (approvedThisRun) {
      for (const r of captured) {
        const dir = join(approvedRoot, r.page.slug);
        mkdirSync(dir, { recursive: true });
        for (const cap of r.caps) copyFileSync(cap.file, join(dir, `${cap.viewport}.png`));
        writeFileSync(join(dir, 'meta.json'), JSON.stringify({ url: r.page.url, at: clock.when, run: stamp }, null, 2));
      }
      log(firstEver ? 'first run → saved as the review baseline' : 'this run is now the review baseline');
    }

    const prior = listPageCoverage(cfg.stateDir, cfg.site ?? cfg.url);
    const seenKeys = new Set(prior.map((p) => p.key));
    for (const u of urls) {
      const k = pageKey(u);
      if (k) seenKeys.add(k);
    }

    report = {
      site: cfg.site ?? cfg.url,
      when: clock.when,
      durationMs: Date.now() - t0,
      approvedThisRun,
      pages: captured.map((r) => r.page),
      findings: grouped,
      sweeps,
      sharedTextCount: shared.texts.size,
      aiModel: provider ? `${provider.name}/${provider.model}` : undefined,
      rawFindingCount: allOccurrences.length,
      measuredFindingCount: measuredCount,
      ai: provider
        ? {
            calls: provider.calls,
            failures: provider.failures,
            lastError: provider.lastError,
            stopped: aiStopped() ?? undefined,
            wrongLang: wrongLang || undefined,
            silent: silentModel || undefined,
          }
        : undefined,
      drift,
      authHow: cfg.authState?.how,
      coverage: { ran: urls.length, seen: seenKeys.size },
    };
  } finally {
    await browser.close().catch(() => {});
  }

  progressSay('Building report', 'wrap');
  const reportPath = join(runDir, 'report.html');
  writeFileSync(reportPath, renderReport(report, stamp));
  const slim = { ...report, pages: report.pages.map((p) => ({ ...p, viewports: p.viewports.map(({ textIndex, reserved, ...rest }) => rest) })) };
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(slim, null, 2));

  progressTick('Done', 'wrap');
  const changed = report.pages.filter((p) => p.viewports.some((v) => v.diff.changed)).length;
  if (report.ai?.failures) {
    log(`⚠ ${report.ai.failures}/${report.ai.calls} AI calls FAILED — the report is incomplete, not a clean site.`);
    if (report.ai.stopped) log(`  ${report.ai.stopped}`);
    else log(`  ${report.ai.lastError ?? ''}`);
  }
  log(
    `done in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${report.pages.length} pages, ${openFindings(report).length} findings (${openFindings(report).filter((f) => f.scope === 'template').length} shared), ${changed} pages differ from baseline`,
  );
  return { runDir, reportPath, stamp, report };
}
