import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { chromium } from 'playwright';
import { log } from './config.js';

/**
 * Turn a run's report into ONE file you can send to somebody.
 *
 * report.html is 28 KB of markup pointing at ~20 MB of PNGs in sibling folders, so sending the
 * file alone gets the recipient a page of broken images. Everything has to travel inside the file.
 *
 * Straight base64 of the PNGs would make it bigger than the folder (base64 adds a third). So the
 * big pictures are re-encoded as JPEG first — measured at 4.6× smaller with no loss of resolution,
 * which is what turns 21 MB into something you can put in a chat message. The crops stay PNG:
 * they are the actual evidence for each finding, they are small, and a JPEG halo around a 4px red
 * box is exactly the wrong place to save bytes.
 */

/** Crops are named `<viewport>.f<n>.png` or `self.f<n>.png` by annotate.ts. */
const IS_CROP = /\.f\d+\.png$/i;
const QUALITY = { diff: 0.82, shot: 0.75 };

export interface ShareResult {
  file: string;
  bytes: number;
  images: number;
  skipped: string[];
}

export async function buildShare(runDir: string, outFile?: string): Promise<ShareResult> {
  const reportFile = join(runDir, 'report.html');
  if (!existsSync(reportFile)) throw new Error(`không thấy ${reportFile}`);
  let html = readFileSync(reportFile, 'utf8');

  // Every relative path the report points at, from both src= and href=.
  const refs = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:png|jpe?g|webp|svg))"/gi)) refs.add(m[1]);
  if (!refs.size) {
    log('report không tham chiếu ảnh nào — không có gì để nhúng');
  }

  const browser = await chromium.launch({ headless: true, executablePath: process.env.QA_CHROME_PATH || undefined, args: ['--disable-gpu'] });
  const page = await browser.newPage();
  const skipped: string[] = [];
  let inlined = 0;
  let rawBytes = 0;

  try {
    for (const ref of refs) {
      const file = resolve(runDir, decodeURIComponent(ref));
      if (!existsSync(file) || !statSync(file).isFile()) {
        skipped.push(ref);
        continue;
      }
      rawBytes += statSync(file).size;
      const ext = ref.toLowerCase();
      let dataUri: string;

      if (IS_CROP.test(ref) || ext.endsWith('.svg')) {
        // Small and precise — keep byte-for-byte.
        const mime = ext.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
        dataUri = `data:${mime};base64,` + readFileSync(file).toString('base64');
      } else {
        const q = /\.diff\.png$/i.test(ref) ? QUALITY.diff : QUALITY.shot;
        const asPng = 'data:image/png;base64,' + readFileSync(file).toString('base64');
        const asJpeg = await toJpeg(page, file, q).catch(() => null);
        // JPEG wins on photographic screenshots but loses on flat-colour ones, where PNG's run
        // encoding is unbeatable. Take whichever is actually smaller rather than assuming.
        dataUri = asJpeg && asJpeg.length < asPng.length ? asJpeg : asPng;
      }

      // Each picture appears twice: as <img src> and as the <a href> that opens it full size.
      // Substituting both would put two copies of the same megabytes in the file, so the link
      // becomes a marker and a few lines of script open the image already in the <img>.
      html = html.split(`href="${ref}"`).join('href="#" data-full="1"');
      html = html.split(`src="${ref}"`).join(`src="${dataUri}"`);
      inlined++;
    }
  } finally {
    await browser.close().catch(() => {});
  }

  html = addBanner(html, runDir) + FULL_VIEW_SCRIPT;

  const out = outFile ?? join(runDir, 'report-share.html');
  writeFileSync(out, html);
  const bytes = statSync(out).size;
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1) + ' MB';
  log(`file chia sẻ: ${inlined} ảnh, ${mb(rawBytes)} → ${mb(bytes)} · ${out}`);
  if (skipped.length) log(`⚠ ${skipped.length} ảnh không thấy trên đĩa, bỏ qua: ${skipped.slice(0, 3).join(', ')}`);
  return { file: out, bytes, images: inlined, skipped };
}

/**
 * Re-encode through the browser's own canvas.
 *
 * Chromium is already a dependency because it takes the screenshots, so this needs no new package —
 * and a native image library (sharp and friends) is a heavy, platform-specific install to buy an
 * encoder we already have running.
 */
async function toJpeg(page: import('playwright').Page, file: string, quality: number): Promise<string> {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(
    async ([b64, q]) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      // JPEG has no transparency; without this, transparent pixels come out black.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0);
      return c.toDataURL('image/jpeg', q as number);
    },
    [b64, quality] as [string, number],
  );
}

/**
 * Restores "click a screenshot to see it 1:1" without a second copy of the image in the file.
 * It matters most for the tall full-page shots, which are 8000px+ and unreadable scaled down.
 */
const FULL_VIEW_SCRIPT = `
<script>
document.addEventListener('click', function (e) {
  var a = e.target.closest && e.target.closest('a[data-full]');
  if (!a) return;
  e.preventDefault();
  var img = a.querySelector('img');
  if (!img) return;
  var w = window.open('', '_blank');
  if (!w) return;
  w.document.title = img.alt || 'ảnh';
  var big = w.document.createElement('img');
  big.src = img.src;
  big.style.maxWidth = '100%';
  w.document.body.style.margin = '0';
  w.document.body.style.background = '#111';
  w.document.body.appendChild(big);
});
</script>`;

/** Say plainly, inside the shared file, that it is a snapshot and where it came from. */
function addBanner(html: string, runDir: string): string {
  const when = basename(runDir).replace('T', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2');
  const banner =
    `<div style="background:#eef4ff;border-bottom:1px solid #cfdcf7;padding:10px 20px;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#26364d">` +
    `Bản chia sẻ — toàn bộ ảnh đã nhúng trong file này, xem được offline. Ảnh chụp trang và ảnh diff đã nén JPEG; ảnh khoanh vùng lỗi giữ nguyên PNG. ` +
    `Lần chạy <b>${when}</b>.</div>`;
  const i = html.indexOf('<body');
  if (i === -1) return banner + html;
  const j = html.indexOf('>', i);
  return html.slice(0, j + 1) + banner + html.slice(j + 1);
}

/** `npm run share [timestamp|đường dẫn]` — mặc định lấy lần chạy mới nhất. */
async function cli() {
  const arg = process.argv[2];
  const reportsDir = resolve(process.cwd(), 'reports');
  let runDir: string;
  if (arg && existsSync(arg)) runDir = statSync(arg).isDirectory() ? resolve(arg) : dirname(resolve(arg));
  else if (arg && existsSync(join(reportsDir, arg))) runDir = join(reportsDir, arg);
  else {
    const { readdirSync } = await import('node:fs');
    const runs = readdirSync(reportsDir)
      .filter((d) => /^\d{4}-/.test(d) && existsSync(join(reportsDir, d, 'report.html')))
      .sort();
    if (!runs.length) throw new Error('chưa có lần chạy nào trong reports/');
    runDir = join(reportsDir, runs[runs.length - 1]);
    if (arg) log(`không thấy "${arg}" — dùng lần chạy mới nhất`);
  }
  const r = await buildShare(runDir);
  console.log(r.file);
}

// Only when run directly, not when the server imports this module.
if (process.argv[1] && /share\.js$/.test(process.argv[1])) {
  cli().catch((e) => {
    console.error('[qa-visual] ' + (e?.message ?? e));
    process.exit(1);
  });
}
