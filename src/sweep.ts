import type { Browser } from 'playwright';
import { FREEZE_CSS, triggerLazyLoad } from './browser.js';
import { log } from './config.js';

export interface SweepResult {
  /** Width ranges where the document overflowed horizontally (from = where it starts, going down to = to) */
  breaks: Array<{ from: number; to: number; overflowPx: number }>;
  checked: number;
}

/**
 * Lifted from v1 unchanged in spirit — the one check that never produced a false positive.
 * Coarse scan from wide to narrow reading scrollWidth only (no screenshots), then binary-search
 * each good→broken edge to the exact pixel. Answers "layout breaks from 1148px down to 360px".
 */
export async function sweep(browser: Browser, url: string, minW = 320, maxW = 1600): Promise<SweepResult> {
  const ctx = await browser.newContext({ viewport: { width: maxW, height: 900 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const breaks: SweepResult['breaks'] = [];
  let checked = 0;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.evaluate(triggerLazyLoad).catch(() => {});

    const measure = async (w: number) => {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(60);
      checked++;
      return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    };

    const step = 60;
    const samples: Array<{ w: number; ov: number }> = [];
    for (let w = maxW; w >= minW; w -= step) samples.push({ w, ov: await measure(w) });

    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1];
      const cur = samples[i];
      const prevBad = prev.ov > 2;
      const curBad = cur.ov > 2;
      if (!prevBad && curBad) {
        let lo = cur.w;
        let hi = prev.w;
        while (hi - lo > 4) {
          const mid = Math.round((lo + hi) / 2);
          if ((await measure(mid)) > 2) lo = mid;
          else hi = mid;
        }
        let j = i;
        let maxOv = cur.ov;
        while (j + 1 < samples.length && samples[j + 1].ov > 2) {
          j++;
          maxOv = Math.max(maxOv, samples[j].ov);
        }
        breaks.push({ from: lo, to: samples[j].w, overflowPx: maxOv });
        i = j;
      } else if (i === 1 && prevBad) {
        let j = 0;
        let maxOv = prev.ov;
        while (j + 1 < samples.length && samples[j + 1].ov > 2) {
          j++;
          maxOv = Math.max(maxOv, samples[j].ov);
        }
        breaks.push({ from: prev.w, to: samples[j].w, overflowPx: maxOv });
        i = j;
      }
    }
  } finally {
    await ctx.close().catch(() => {});
  }
  log(`sweep: ${checked} widths, ${breaks.length} break range(s)`);
  return { breaks, checked };
}
