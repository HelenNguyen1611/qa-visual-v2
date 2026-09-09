import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { VIEWPORTS, type Config, type ViewportName, log, progressTick } from './config.js';
import { FREEZE_CSS, triggerLazyLoad, collectMedia, collectTextIndex, type MediaRegion, type TextItem } from './browser.js';

export interface Capture {
  viewport: ViewportName;
  width: number;
  /** absolute path to the full-page PNG */
  file: string;
  pageHeight: number;
  media: MediaRegion[];
  /** every visible text run with its real box — used to locate AI findings precisely */
  textIndex: TextItem[];
  failedRequests: string[];
  jsErrors: string[];
  title: string;
}

export async function launch(cfg: Config): Promise<Browser> {
  return chromium.launch({
    headless: true,
    executablePath: process.env.QA_CHROME_PATH || undefined,
    args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', '--disable-gpu'],
  });
}

/**
 * Wait until the page is really settled. Fonts and lazy images are the two things that make an
 * unchanged page screenshot differently twice — skipping this is how you get noisy diffs.
 */
async function settle(page: Page, cfg: Config) {
  await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});
  await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  for (const sel of cfg.mask.hide) {
    await page.locator(sel).evaluateAll((els) => els.forEach((e) => ((e as HTMLElement).style.display = 'none'))).catch(() => {});
  }
  await page.evaluate(triggerLazyLoad).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(250);
}

/** One URL at the three viewports. Same tab, resized — one navigation, three screenshots. */
export async function captureAll(browser: Browser, cfg: Config, outDir: string): Promise<Capture[]> {
  mkdirSync(outDir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: VIEWPORTS[2].width, height: VIEWPORTS[2].height },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    reducedMotion: 'reduce',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 qa-visual/2',
  });
  const page = await ctx.newPage();
  const failed: string[] = [];
  const jsErrors: string[] = [];
  page.on('pageerror', (e) => jsErrors.push(String(e.message).slice(0, 200)));
  page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText ?? 'failed'} ${r.resourceType()} ${r.url().slice(0, 200)}`));
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`HTTP ${r.status()} ${r.request().resourceType()} ${r.url().slice(0, 200)}`);
  });

  const out: Capture[] = [];
  try {
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const title = await page.title().catch(() => '');
    // Widest first: lazy assets requested once at desktop are already cached for the smaller sizes.
    for (const vp of [...VIEWPORTS].reverse()) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await settle(page, cfg);
      const media = await page.evaluate(collectMedia).catch(() => [] as MediaRegion[]);
      const textIndex = await page.evaluate(collectTextIndex, 800).catch(() => [] as TextItem[]);
      const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const file = join(outDir, `${vp.name}.png`);
      await page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide', timeout: 20000 });
      out.push({ viewport: vp.name, width: vp.width, file, pageHeight, media, textIndex, failedRequests: dedupe(failed), jsErrors: dedupe(jsErrors), title });
      const nAv = media.filter((m) => m.kind === 'video' || m.kind === 'iframe' || m.kind === 'canvas').length;
      const nImg = media.filter((m) => m.kind === 'img').length;
      const nBg = media.filter((m) => m.kind === 'background').length;
      log(`captured ${vp.name} ${vp.width}px — trang cao ${pageHeight}px · ${nImg} ảnh, ${nBg} ảnh nền CSS, ${nAv} video/iframe/canvas`);
      progressTick(`Chụp ${vp.name} · ${shortUrl(cfg.url)}`, 'capture');
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  return out.sort((a, b) => a.width - b.width);
}

const dedupe = (a: string[]) => Array.from(new Set(a));

/** Just the path, for a progress label that has to fit on one line. */
const shortUrl = (u: string) => {
  try {
    return new URL(u).pathname || '/';
  } catch {
    return u;
  }
};
