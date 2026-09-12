#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig, USAGE, log } from './config.js';
import { markFindingAccepted, findingByNum } from './accepted.js';
import { renderReport } from './report.js';
import { listFigmaFrames, framesFromFolder, type FigmaFrame } from './design.js';
import { launch } from './capture.js';
import { findPages, runQa } from './core.js';
import { prepareAuth } from './auth.js';
import { readPagesJson, writePagesJson, type PageTarget } from './pages.js';

/**
 * The terminal front end. All of the work lives in core.ts; this decides where the pairing comes
 * from (pages.json, or a fresh guess) and prints the result.
 */
/**
 * `accept <số lỗi> "lý do"` — sign off one finding from the last run as intended.
 *
 * Reads the finding out of the newest report rather than asking for it to be retyped: the entry
 * has to carry the anchors to match on next run, and nobody is going to copy those by hand.
 */
function acceptCommand(argv: string[]): number {
  const runFlag = argv.indexOf('--run');
  const want = runFlag > 0 ? argv[runFlag + 1] : undefined;
  const rest = runFlag > 0 ? [...argv.slice(0, runFlag), ...argv.slice(runFlag + 2)] : argv;
  const num = Number(rest[1]);
  const why = rest.slice(2).join(' ').trim();
  if (!Number.isInteger(num) || num < 1 || !why) {
    console.error('Dùng: qa-visual accept <số lỗi> "lý do vì sao đây là chủ ý" [--run <timestamp>]');
    return 1;
  }
  const dir = resolve(process.cwd(), 'reports');
  const stamps = existsSync(dir)
    ? readdirSync(dir).filter((d) => /^\d{4}-/.test(d) && existsSync(join(dir, d, 'report.json'))).sort()
    : [];
  if (!stamps.length) {
    console.error('Chưa có lần chạy nào trong reports/ để duyệt.');
    return 1;
  }
  const stamp = want ?? stamps[stamps.length - 1];
  if (!stamps.includes(stamp)) {
    console.error(`Không có lần chạy ${stamp}. Có: ${stamps.slice(-5).join(', ')}`);
    return 1;
  }
  const report = JSON.parse(readFileSync(join(dir, stamp, 'report.json'), 'utf8'));
  // Which run this reads from is not a detail: the newest run may well be a different site, and
  // accepting there writes a rule that silences nothing you meant and something you did not.
  console.log(`Đọc lần chạy ${stamp} — site ${report.site}`);
  const f = findingByNum(report, num);
  if (!f) {
    console.error(`Lần chạy ${stamp} không có lỗi số ${num}.`);
    return 1;
  }
  markFindingAccepted(f, why);
  const runDir = join(dir, stamp);
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(runDir, 'report.html'), renderReport(report, stamp));
  console.log(`Đã duyệt “${f.title}” là cố ý — ghi vào report ${stamp} và accepted.json. Lần chạy sau sẽ không tính lỗi này nữa.`);
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    process.exit(argv.length ? 0 : 1);
  }
  if (argv[0] === 'accept') process.exit(acceptCommand(argv));
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
