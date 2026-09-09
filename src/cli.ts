#!/usr/bin/env node
import { mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Browser } from 'playwright';
import { loadConfig, USAGE, log, VIEWPORTS, type Config } from './config.js';
import { launch, captureAll, type Capture } from './capture.js';
import { sweep, type SweepResult } from './sweep.js';
import { compare } from './compare.js';
import { renderReport, type RunReport, type PageReport, type ViewportReport } from './report.js';
import { listFigmaFrames, renderFigmaFrames, framesFromFolder, type FigmaFrame } from './design.js';
import { fromSitemap, fromLinks, browserFetcher, dedupeUrls, readPagesJson, writePagesJson, slugOf, type PageTarget } from './pages.js';
import { mapUrlsToFrames, looksMispaired, type Mapped } from './mapping.js';
import { detectShared } from './shared.js';
import { groupFindings, type Occurrence } from './group.js';
import { createProvider, type VisionProvider } from './provider.js';
import { compareWithDesign, compareSelf } from './ai.js';
import { annotateCrop } from './annotate.js';
import { locate } from './locate.js';

/** Run a few pages at a time — a browser context each, but not so many that the machine crawls. */
async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
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

/** Phase 1 for one URL: capture the three viewports and diff each against that URL's own baseline. */
async function capturePage(
  browser: Browser,
  cfg: Config,
  runDir: string,
  approvedRoot: string,
  target: Mapped,
  designFile: string | undefined,
): Promise<{ page: PageReport; caps: Capture[]; pageDir: string }> {
  const slug = slugOf(target.url);
  const pageDir = join(runDir, slug);
  const caps = await captureAll(browser, { ...cfg, url: target.url }, pageDir);
  // Each URL keeps its OWN approved baseline — one shared folder would have every page
  // overwriting the previous one's reference.
  const approvedDir = join(approvedRoot, slug);

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
      design: designFile ? { file: relative(runDir, designFile), mode: 'x' as any, source: target.frameName ?? '', width: target.frame?.width ?? 0 } : undefined,
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
      textIndex: cap.textIndex,
    });
  }

  return {
    page: {
      url: target.url,
      slug,
      title: caps[0]?.title ?? '',
      viewports,
      mapping: { frameName: target.frameName, frameWidth: target.frame?.width, how: target.how, score: target.score, isTemplate: target.isTemplate },
      designFile: designFile ? relative(runDir, designFile) : undefined,
      mispaired: false,
      failedRequests: caps[0]?.failedRequests ?? [],
      jsErrors: caps[0]?.jsErrors ?? [],
    } as PageReport,
    caps,
    pageDir,
  };
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
  designFile: string | undefined,
  provider: VisionProvider,
  skipBands: Array<{ from: number; to: number; where: string }>,
): Promise<{ occurrences: Occurrence[]; aiError?: string; mispaired: boolean }> {
  const occurrences: Occurrence[] = [];
  let aiError: string | undefined;
  let mispaired = false;
  const viewports = page.viewports;

  if (designFile && target.frame) {
    const titles: string[] = [];
    await Promise.all(
      viewports.map(async (v) => {
        const vpH = VIEWPORTS.find((x) => x.name === v.name)?.height ?? 900;
        const mode = Math.abs(target.frame!.width - v.width) / v.width <= 0.12 ? 'fidelity' : 'adaptation';
        try {
          const found = await compareWithDesign(provider, join(runDir, v.shot), designFile, mode, v.width, target.frame!.width, vpH, v.mediaRegions, skipBands);
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
      }),
    );
    mispaired = looksMispaired(titles);
  }

  const d = viewports.find((v) => v.name === 'desktop');
  const m = viewports.find((v) => v.name === 'mobile');
  if (d && m) {
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
  }
  return { occurrences, aiError, mispaired };
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    process.exit(argv.length ? 0 : 1);
  }
  const cfg = loadConfig(argv);
  const t0 = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = join(cfg.stateDir, stamp);
  const approvedRoot = join(cfg.stateDir, '_approved');
  mkdirSync(runDir, { recursive: true });

  // The browser comes up first: it is also how we look for the sitemap and read the nav, because
  // the shell running this tool often cannot reach the site while the browser can.
  const browser = await launch(cfg);

  // ---- which pages
  const fromFile = readPagesJson();
  let urls: string[];
  if (fromFile?.length) {
    urls = fromFile.map((p) => p.url).slice(0, cfg.maxPages);
    log(`pages.json: ${urls.length} trang (đã có sẵn, không đoán lại)`);
  } else if (cfg.site) {
    urls = await fromSitemap(cfg.site, cfg.maxPages, browserFetcher(browser));
    if (!urls.length) urls = await fromLinks(browser, cfg.site, cfg.maxPages);
    urls = dedupeUrls([cfg.site, ...urls]).slice(0, cfg.maxPages);
  } else {
    urls = [cfg.url];
  }
  log(`${urls.length} trang: ${urls.map((u) => new URL(u).pathname).join(', ')}`);

  // ---- which design frames
  let frames: FigmaFrame[] = [];
  try {
    if (cfg.figma) frames = await listFigmaFrames(cfg.figma, cfg.figmaToken);
    else if (cfg.designDir) frames = framesFromFolder(cfg.designDir);
  } catch (e: any) {
    log(`design: ${e?.message ?? e}`);
  }

  // ---- pair them
  let mapped: Mapped[];
  if (fromFile?.length) {
    mapped = fromFile.slice(0, cfg.maxPages).map((p) => {
      const frame = frames.find((f) => f.id === p.figmaNodeId);
      return { ...p, frame, score: 1, runnerUp: 0, isTemplate: false, how: p.how ?? 'lấy từ pages.json' };
    });
  } else {
    mapped = mapUrlsToFrames(urls, frames);
    if (frames.length) {
      writePagesJson(mapped.map((m) => ({ url: m.url, figmaNodeId: m.figmaNodeId, frameName: m.frameName, how: m.how })));
      log('đã ghi pages.json — mở ra sửa dòng nào ghép sai, lần sau tool dùng nguyên file này');
    }
  }
  for (const m of mapped) log(`  ${new URL(m.url).pathname} → ${m.frameName ?? '(không có design)'} · ${m.how}`);

  // ---- render only the frames actually used
  const usedFrames = mapped.map((m) => m.frame).filter(Boolean) as FigmaFrame[];
  let rendered = new Map<string, string>();
  if (cfg.figma && usedFrames.length) {
    rendered = await renderFigmaFrames(cfg.figma, usedFrames, cfg.figmaToken, join(cfg.stateDir, '_design')).catch((e) => {
      log(`Figma render: ${e?.message ?? e}`);
      return new Map<string, string>();
    });
  } else {
    for (const f of usedFrames) if (f.file) rendered.set(f.id, f.file);
  }

  const provider = createProvider(cfg);
  let report: RunReport;

  try {
    // ---- phase 1: capture everything first. The template can only be identified by comparing pages.
    const captured = await pool(mapped, cfg.concurrency, (m) =>
      capturePage(browser, cfg, runDir, approvedRoot, m, m.frame ? rendered.get(m.frame.id) : undefined),
    );

    // ---- what is template chrome, from counting text across pages
    const shared = detectShared(
      captured.map((r) => ({
        url: r.page.url,
        textIndex: r.page.viewports.find((v) => v.name === 'mobile')?.textIndex ?? [],
        pageHeight: r.page.viewports.find((v) => v.name === 'mobile')?.pageHeight ?? 0,
      })),
    );
    if (shared.texts.size) log(`vùng dùng chung: ${shared.texts.size} chuỗi chữ có mặt ở ≥60% trang`);

    // ---- phase 2: the AI pass. The first page reviews the whole thing; later pages are told to
    // skip the shared header/footer, so the same component is not described over and over.
    const allOccurrences: Occurrence[] = [];
    if (provider) {
      let reviewedTemplate = false;
      await pool(captured, cfg.concurrency, async (r, i) => {
        const m = mapped[i];
        const bands = reviewedTemplate ? (shared.bands.get(r.page.url) ?? []) : [];
        if (!reviewedTemplate) reviewedTemplate = true;
        const res = await analysePage(runDir, r.pageDir, r.page, m, m.frame ? rendered.get(m.frame.id) : undefined, provider, bands);
        r.page.aiError = res.aiError;
        r.page.mispaired = res.mispaired;
        allOccurrences.push(...res.occurrences);
      });
    }
    const firstResults = captured;

    // ---- one finding per defect
    const grouped = groupFindings(allOccurrences, shared);
    const templateCount = grouped.filter((g) => g.scope === 'template').length;
    log(`gộp: ${allOccurrences.length} nhận xét thô → ${grouped.length} lỗi (${templateCount} ở component dùng chung)`);

    // ---- sweep: template-level, so the homepage plus any page that showed overflow
    const overflowPages = firstResults.filter((r) => r.caps.some((c) => c.media.length >= 0 && r.page.viewports.some((v) => v.diff.currentHeight > 0)) && false);
    const sweepTargets = [urls[0], ...overflowPages.map((r) => r.page.url)].slice(0, 2);
    const sweeps: Array<{ url: string } & SweepResult> = [];
    for (const u of sweepTargets) {
      const s = await sweep(browser, u).catch(() => null);
      if (s) sweeps.push({ url: u, ...s });
    }

    // ---- approve
    const firstEver = !existsSync(join(approvedRoot, slugOf(urls[0]), 'meta.json'));
    const approvedThisRun = cfg.approve || firstEver;
    if (approvedThisRun) {
      for (const r of firstResults) {
        const dir = join(approvedRoot, r.page.slug);
        mkdirSync(dir, { recursive: true });
        for (const cap of r.caps) copyFileSync(cap.file, join(dir, `${cap.viewport}.png`));
        writeFileSync(join(dir, 'meta.json'), JSON.stringify({ url: r.page.url, at: new Date().toISOString(), run: stamp }, null, 2));
      }
      log(firstEver ? 'lần chạy đầu → đã lưu làm bản duyệt' : 'đã chốt lần chạy này làm bản duyệt mới');
    }

    report = {
      site: cfg.site ?? cfg.url,
      when: new Date().toISOString(),
      durationMs: Date.now() - t0,
      approvedThisRun,
      pages: firstResults.map((r) => r.page),
      findings: grouped,
      sweeps,
      sharedTextCount: shared.texts.size,
      aiModel: provider ? `${provider.name}/${provider.model}` : undefined,
      rawFindingCount: allOccurrences.length,
    };
  } finally {
    await browser.close().catch(() => {});
  }

  writeFileSync(join(runDir, 'report.html'), renderReport(report));
  const slim = { ...report, pages: report.pages.map((p) => ({ ...p, viewports: p.viewports.map(({ textIndex, ...rest }) => rest) })) };
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(slim, null, 2));

  const changed = report.pages.filter((p) => p.viewports.some((v) => v.diff.changed)).length;
  log(
    `xong trong ${((Date.now() - t0) / 1000).toFixed(0)}s — ${report.pages.length} trang, ${report.findings.length} lỗi (${report.findings.filter((f) => f.scope === 'template').length} dùng chung), ${changed} trang khác bản duyệt`,
  );
  console.log(join(runDir, 'report.html'));
}

main().catch((e) => {
  console.error('[qa-visual] ' + (e?.message ?? e));
  process.exit(1);
});
