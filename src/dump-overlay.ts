/**
 * Phase A diagnose: largest Figma TEXT nodes vs DOM h1/h2 on Projects and Journal.
 * Not part of the QA run. Usage: node dist/dump-overlay.js
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { fetchFigmaOverlay, type FigmaOverlayText } from './design.js';
import { launch, captureAll } from './capture.js';
import { prepareAuth } from './auth.js';
import { withPreservedQuery } from './pages.js';
import { uniqueTextPairs, overlayTypeCompare } from './verify.js';

const FIGMA = 'https://www.figma.com/design/JVbTu31gPVjeAzEm5HUQSN/?node-id=2366-8900';
const SEED = 'http://new-wooagency:8888/?qa-showcase=1';

const TARGETS = [
  { name: 'journal', url: 'http://new-wooagency:8888/journal/', nodeId: '2430:11986' },
  { name: 'projects', url: 'http://new-wooagency:8888/projects/', nodeId: '2430:9420' },
  { name: 'home', url: 'http://new-wooagency:8888/?qa-showcase=1', nodeId: '2366:8900' },
];

function topTexts(texts: FigmaOverlayText[], n = 10) {
  return texts
    .slice()
    .sort((a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0) || a.y - b.y)
    .slice(0, n);
}

async function main() {
  const cfg = loadConfig(['--site', SEED, '--figma', FIGMA, '--pages', '7', '--ai', 'none', '--preserve-query', 'qa-showcase']);
  const browser = await launch(cfg);
  cfg.authState = await prepareAuth(browser, SEED, cfg.auth);
  const tmp = mkdtempSync(join(tmpdir(), 'qav-dump-'));
  try {
    for (const t of TARGETS) {
      const overlay = await fetchFigmaOverlay(FIGMA, t.nodeId, cfg.figmaToken);
      const sized = overlay.texts.filter((x) => (x.fontSize ?? 0) >= 20);
      console.log(`\n======== FIGMA ${t.name} ${t.nodeId} pageW=${overlay.pageWidth} texts=${overlay.texts.length} >=20px=${sized.length}`);
      for (const x of topTexts(overlay.texts, 10)) {
        console.log(
          `  ${String(x.fontSize ?? '—').padStart(5)} w${x.fontWeight ?? '—'} y=${Math.round(x.y)} d=${x.depth ?? '—'} ${x.id ?? ''} | ${JSON.stringify(x.text.slice(0, 80))}`,
        );
      }
      const url = withPreservedQuery(t.url, SEED, cfg.preserveQuery);
      const caps = await captureAll(browser, { ...cfg, url }, join(tmp, t.name));
      const desk = caps.find((c) => c.viewport === 'desktop');
      const heads = (desk?.textIndex ?? []).filter((i) => i.heading === 'h1' || i.heading === 'h2');
      console.log(`-------- DOM ${t.name} desktop h1/h2 (${heads.length})`);
      for (const h of heads.slice(0, 16)) {
        console.log(
          `  ${h.heading} ${String(h.fontSize ?? '—').padStart(5)} w${h.fontWeight ?? '—'} y=${h.y} | ${JSON.stringify(h.text.slice(0, 80))}`,
        );
      }
      const vis = (desk?.textIndex ?? []).filter((i) => i.tag !== 'img' && !i.ariaHidden && (i.w ?? 0) >= 8);
      const pairs = uniqueTextPairs(overlay.texts, vis);
      console.log(`-------- unique pairs ≥32px`);
      for (const p of pairs) {
        const f = overlay.texts[p.fi];
        if ((f.fontSize ?? 0) < 32) continue;
        const d = vis[p.di];
        console.log(
          `  F ${f.fontSize} y=${Math.round(f.y)} ${JSON.stringify(f.text.slice(0, 50))} → D ${d.fontSize} ${d.heading ?? ''} y=${d.y} ${JSON.stringify(d.text.slice(0, 50))}`,
        );
      }
      if (!pairs.some((p) => (overlay.texts[p.fi].fontSize ?? 0) >= 32)) {
        console.log('  (none)');
      }
      const typeHits = overlayTypeCompare(desk?.textIndex ?? [], overlay, desk?.width ?? 1440);
      console.log(`-------- type hits ${typeHits.length}`);
      for (const h of typeHits) console.log(`  ${h.finding.title} | ${h.finding.detail.replace(/\n/, ' / ')}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
