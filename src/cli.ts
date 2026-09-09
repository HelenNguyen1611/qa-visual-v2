#!/usr/bin/env node
import { mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { loadConfig, USAGE, log, VIEWPORTS } from './config.js';
import { launch, captureAll } from './capture.js';
import { sweep } from './sweep.js';
import { compare } from './compare.js';
import { renderReport, type RunReport, type ViewportReport } from './report.js';
import { resolveDesigns } from './design.js';
import { createProvider } from './provider.js';
import { compareWithDesign, compareSelf } from './ai.js';
import { annotateCrop } from './annotate.js';
import { locate } from './locate.js';

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
  const approvedDir = join(cfg.stateDir, '_approved');
  mkdirSync(runDir, { recursive: true });

  log(`${cfg.url}`);
  const browser = await launch(cfg);
  let report: RunReport;
  try {
    // 1. capture
    const caps = await captureAll(browser, cfg, runDir);

    // 4. sweep (runs in its own context while we do the rest)
    const sweepP = sweep(browser, cfg.url);

    // 2. design references (Figma or folder) — resolved once, paired per viewport
    const designs = await resolveDesigns(cfg, join(cfg.stateDir, '_design')).catch((e) => {
      log(`design: ${e?.message ?? e}`);
      return new Map();
    });

    // 3. compare against the approved baseline
    const approvedMeta = existsSync(join(approvedDir, 'meta.json')) ? JSON.parse(readFileSync(join(approvedDir, 'meta.json'), 'utf8')) : undefined;
    const provider = createProvider(cfg);

    const viewports: ViewportReport[] = [];
    for (const cap of caps) {
      const baseline = join(approvedDir, `${cap.viewport}.png`);
      const diff = compare(existsSync(baseline) ? baseline : undefined, cap.file, cap.media, join(runDir, `${cap.viewport}.diff.png`));
      const failedSet = new Set(cap.failedRequests.map((f) => f.split(' ').pop()!.split('?')[0]));
      const design = designs.get(cap.viewport);
      viewports.push({
        name: cap.viewport,
        width: cap.width,
        shot: relative(runDir, cap.file),
        pageHeight: cap.pageHeight,
        diff: { ...diff, diffRel: diff.diffFile ? relative(runDir, diff.diffFile) : undefined },
        design: design ? { file: relative(runDir, design.file), mode: design.mode, source: design.source, width: design.width } : undefined,
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

    // AI: design comparison per viewport, in parallel, plus a desktop↔mobile self-check
    let selfCompare: RunReport['selfCompare'];
    if (provider) {
      await Promise.all(
        viewports.map(async (v) => {
          if (!v.design) return;
          try {
            const vpH = VIEWPORTS.find((x) => x.name === v.name)?.height ?? 900;
            v.ai = await compareWithDesign(provider, join(runDir, v.shot), join(runDir, v.design.file), v.design.mode, v.width, v.design.width, vpH, v.mediaRegions);
          } catch (e: any) {
            v.aiError = String(e?.message ?? e).slice(0, 200);
          }
        }),
      );
      const d = viewports.find((v) => v.name === 'desktop');
      const m = viewports.find((v) => v.name === 'mobile');
      if (d && m) {
        const mH = VIEWPORTS.find((x) => x.name === 'mobile')?.height ?? 844;
        selfCompare = await compareSelf(provider, join(runDir, d.shot), join(runDir, m.shot), mH, m.mediaRegions).catch(() => undefined);
      }

      // Mark each finding on the screenshot and crop that region, so the reader sees where it is
      // instead of scanning a 7000px page.
      for (const v of viewports) {
        let n = 0;
        for (const f of v.ai ?? []) {
          n++;
          f.num = n;
          // The box comes from the DOM via the text the model quoted — not from its coordinate guess.
          const loc = locate(f.anchors, v.textIndex, f.y);
          if (!loc) continue;
          f.locatedHow = loc.how;
          const res = annotateCrop(join(runDir, v.shot), loc.box, n, join(runDir, `${v.name}.f${n}.png`));
          if (res) f.crop = relative(runDir, res.file);
        }
      }
      if (selfCompare && m) {
        let n = 0;
        for (const f of selfCompare) {
          n++;
          f.num = n;
          const loc = locate(f.anchors, m.textIndex, f.y);
          if (!loc) continue;
          f.locatedHow = loc.how;
          const res = annotateCrop(join(runDir, m.shot), loc.box, n, join(runDir, `self.f${n}.png`));
          if (res) f.crop = relative(runDir, res.file);
        }
      }
    }

    const sw = await sweepP;

    // approve: first run ever, or explicit --approve
    const firstRun = !existsSync(join(approvedDir, 'meta.json'));
    const approvedThisRun = cfg.approve || firstRun;
    if (approvedThisRun) {
      mkdirSync(approvedDir, { recursive: true });
      for (const cap of caps) copyFileSync(cap.file, join(approvedDir, `${cap.viewport}.png`));
      writeFileSync(join(approvedDir, 'meta.json'), JSON.stringify({ url: cfg.url, at: new Date().toISOString(), run: stamp }, null, 2));
      log(firstRun ? 'first run → saved as approved baseline' : 'approved: this run is the new baseline');
    }

    report = {
      url: cfg.url,
      title: caps[0]?.title ?? '',
      when: new Date().toISOString(),
      durationMs: Date.now() - t0,
      approvedAt: approvedMeta?.at,
      approvedThisRun,
      viewports,
      sweep: sw,
      failedRequests: caps[0]?.failedRequests ?? [],
      jsErrors: caps[0]?.jsErrors ?? [],
      aiModel: provider ? `${provider.name}/${provider.model}` : undefined,
      selfCompare,
    };
  } finally {
    await browser.close().catch(() => {});
  }

  writeFileSync(join(runDir, 'report.html'), renderReport(report));
  const slim = { ...report, viewports: report.viewports.map(({ textIndex, ...rest }) => rest) };
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(slim, null, 2));
  const changed = report.viewports.filter((v) => v.diff.changed).length;
  const ai = report.viewports.reduce((n, v) => n + (v.ai?.filter((f) => f.severity !== 'note').length ?? 0), 0);
  log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${changed} viewport(s) changed, ${ai} AI finding(s), ${report.sweep.breaks.length} break range(s)`);
  console.log(join(runDir, 'report.html'));
}

main().catch((e) => {
  console.error('[qa-visual] ' + (e?.message ?? e));
  process.exit(1);
});
