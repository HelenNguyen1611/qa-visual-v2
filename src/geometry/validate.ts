#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { launch, captureAll } from '../capture.js';
import { prepareAuth } from '../auth.js';
import { fetchFigmaSubtree } from '../design.js';
import { flattenFigmaTree } from './figmaTree.js';
import { matchFigmaToDom } from './match.js';
import { mapBlocks } from './blockMap.js';
import { detectAllGeometry } from './run.js';
import { rankCandidates } from './rank.js';

/** Capture one URL and dump geometry candidates — used to review AINO without a full QA run. */
const fallbackUrl = 'https://aino.energy.wootech.com.au/';
const argv = process.argv.slice(2);
const url = argv.find((a) => /^https?:\/\//i.test(a) && !a.includes('figma.com')) ?? fallbackUrl;
if (!argv.some((a) => /^https?:\/\//i.test(a) && !a.includes('figma.com'))) argv.push(url);
if (!argv.includes('--ai')) argv.push('--ai', 'none');
const cfg = loadConfig(argv);
const outDir = join(cfg.stateDir, '_geom-validate', Date.now().toString(36));
mkdirSync(outDir, { recursive: true });

const pagesFile = join(process.cwd(), 'pages.json');
const pages = existsSync(pagesFile) ? JSON.parse(readFileSync(pagesFile, 'utf8')) : { pages: [] };
const row = (pages.pages ?? []).find((p: { url?: string }) => p.url === url);
const frameId = row?.figmaNodeId as string | undefined;
const figmaLink = cfg.figma ?? process.env.FIGMA_LINK;

let figma;
let figmaError: string | undefined;
if (figmaLink && cfg.figmaToken && frameId) {
  try {
    const raw = await fetchFigmaSubtree(figmaLink, frameId, cfg.figmaToken);
    figma = flattenFigmaTree(raw, frameId);
    if (figma) {
      writeFileSync(
        join(outDir, 'figma-tree.json'),
        JSON.stringify({ frame: figma.frame, frameName: figma.frameName, nodes: figma.nodes.length, sample: figma.nodes.slice(0, 30) }, null, 2),
      );
    }
  } catch (e: any) {
    figmaError = String(e?.message ?? e);
  }
} else {
  figmaError = !figmaLink ? 'không có --figma / FIGMA_LINK' : !frameId ? 'không có figmaNodeId trong pages.json' : 'FIGMA_TOKEN trống';
}

const browser = await launch(cfg);
try {
  cfg.authState = await prepareAuth(browser, cfg.url, cfg.auth);
  const caps = await captureAll(browser, cfg, outDir);
  const all = [];
  for (const cap of caps) {
    const raw = detectAllGeometry(cap.geometry, figma);
    const ranked = rankCandidates(raw);
    const match = figma ? matchFigmaToDom(cap.geometry, figma) : undefined;
    const blocks = figma && match ? mapBlocks(cap.geometry, figma, match.pairs) : undefined;
    writeFileSync(join(outDir, `${cap.viewport}.candidates.json`), JSON.stringify({ raw, ranked, figma: match, blocks }, null, 2));
    all.push({
      viewport: cap.viewport,
      raw: raw.length,
      strong: ranked.filter((c) => c.keep).length,
      kinds: tally(raw),
      figma: match?.stats,
      blocks: blocks
        ? {
            mapped: blocks.blocks.length,
            skipped: blocks.skipped.length,
            rows: blocks.blocks.map((b) => ({
              figmaId: b.figma.id,
              figmaName: b.figma.name,
              figmaBox: b.figma.box,
              figmaLevel: b.figmaLevel,
              locator: b.dom.locator,
              domBox: b.dom.box,
              domLevel: b.domLevel,
              compatible: true,
              widthRatio: b.widthRatio,
              confidence: b.confidence,
              figmaPad: b.figmaPad,
              domPad: b.domPad,
              scale: b.scale,
              texts: b.anchors.map((a) => a.figma.text),
            })),
            skippedRows: blocks.skipped,
            insets: blocks.insets.map((p) => ({
              parentFigmaId: p.parentFigma.id,
              parentFigmaName: p.parentFigma.name,
              parentFigmaBox: p.parentFigma.box,
              parentFigmaLevel: p.parentFigmaLevel,
              childFigmaId: p.child.figma.id,
              childFigmaName: p.child.figma.name,
              childFigmaBox: p.child.figma.box,
              childFigmaLevel: p.child.figmaLevel,
              parentLocator: p.parentDom.locator,
              parentDomBox: p.parentDom.box,
              parentDomLevel: p.parentDomLevel,
              childLocator: p.child.dom.locator,
              childDomBox: p.child.dom.box,
              childDomLevel: p.child.domLevel,
              parentWidthRatio: p.parentWidthRatio,
              confidence: p.confidence,
              figmaInset: p.figmaInset,
              domInset: p.domInset,
            })),
            insetSkipped: blocks.insetSkipped,
            owners: blocks.owners.map((o) => ({
              figmaId: o.figma.id,
              figmaName: o.figma.name,
              figmaBox: o.figma.box,
              figmaLevel: o.figmaLevel,
              locator: o.dom.locator,
              domBox: o.dom.box,
              domLevel: o.domLevel,
              role: o.role,
              why: o.why,
              widthRatio: o.widthRatio,
              confidence: o.confidence,
              figmaPad: o.figmaPad,
              domPad: o.domPad,
              texts: o.anchors.map((a) => a.figma.text),
            })),
            ownerSkipped: blocks.ownerSkipped,
          }
        : undefined,
    });
  }
  const summary = { url, outDir, frameId, figmaError, figmaNodes: figma?.nodes.length, all };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close().catch(() => {});
}

function tally(raw: { kind: string }[]) {
  const m: Record<string, number> = {};
  for (const c of raw) m[c.kind] = (m[c.kind] ?? 0) + 1;
  return m;
}
