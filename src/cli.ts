#!/usr/bin/env node
import { loadConfig, USAGE, log } from './config.js';
import { listFigmaFrames, framesFromFolder, type FigmaFrame } from './design.js';
import { launch } from './capture.js';
import { findPages, runQa } from './core.js';
import { prepareAuth } from './auth.js';
import { readPagesJson, writePagesJson, type PageTarget } from './pages.js';

/**
 * The terminal front end. All of the work lives in core.ts; this decides where the pairing comes
 * from (pages.json, or a fresh guess) and prints the result.
 */
async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    process.exit(argv.length ? 0 : 1);
  }
  const cfg = loadConfig(argv);

  let frames: FigmaFrame[] = [];
  try {
    if (cfg.figma) frames = await listFigmaFrames(cfg.figma, cfg.figmaToken);
    else if (cfg.designDir) frames = framesFromFolder(cfg.designDir);
  } catch (e: any) {
    log(`design: ${e?.message ?? e}`);
  }

  let rows = readPagesJson();
  if (rows?.length) {
    rows = rows.slice(0, cfg.maxPages);
    log(`pages.json: ${rows.length} trang (đã có sẵn, không đoán lại)`);
  } else {
    // No pairing on file: work out the page list, pair it, and write it down for next time.
    const browser = await launch(cfg);
    let urls: string[];
    try {
      // Open the login gate BEFORE looking for pages: the sitemap and the homepage nav are the
      // first two things it hides, and a blocked probe looks exactly like a one-page site.
      cfg.authState = await prepareAuth(browser, cfg.site ?? cfg.url, cfg.auth);
      urls = cfg.site ? (await findPages(browser, cfg.site, cfg.maxPages, cfg)).urls : [cfg.url];
    } finally {
      await browser.close().catch(() => {});
    }
    log(`${urls.length} trang: ${urls.map((u) => new URL(u).pathname).join(', ')}`);
    const { mapUrlsToFrames } = await import('./mapping.js');
    const mapped = mapUrlsToFrames(urls, frames);
    rows = mapped.map((m) => ({ url: m.url, figmaNodeId: m.figmaNodeId, frameName: m.frameName, how: m.how }) as PageTarget);
    if (frames.length) {
      writePagesJson(rows);
      log('đã ghi pages.json — mở ra sửa dòng nào ghép sai, lần sau tool dùng nguyên file này');
    }
  }
  for (const r of rows) log(`  ${new URL(r.url).pathname} → ${r.frameName ?? '(không có design)'} · ${r.how ?? ''}`);

  const out = await runQa(cfg, rows, frames);
  console.log(out.reportPath);
}

main().catch((e) => {
  console.error('[qa-visual] ' + (e?.message ?? e));
  process.exit(1);
});
