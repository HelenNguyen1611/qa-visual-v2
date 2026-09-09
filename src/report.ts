import type { DiffResult } from './compare.js';
import type { SweepResult } from './sweep.js';
import type { MediaRegion, TextItem } from './browser.js';

export interface AiFinding {
  title: string;
  severity: 'major' | 'minor' | 'note';
  detail: string;
  /** rough y the model guessed — only a disambiguation hint, never the box */
  y?: number;
  /** verbatim text the model quoted; the box is resolved from this against the DOM */
  anchors?: string[];
  /** how the region was located, so a wrong box is recognisable */
  locatedHow?: string;
  /** cropped screenshot with the region boxed in red */
  crop?: string;
  num?: number;
}

export interface DesignRef {
  /** path relative to the report */
  file: string;
  /** exact-width design → fidelity; desktop design reused for a smaller viewport → adaptation */
  mode: 'fidelity' | 'adaptation';
  source: string;
  width: number;
}

export interface ViewportReport {
  name: string;
  width: number;
  shot: string;
  pageHeight: number;
  diff: DiffResult & { diffRel?: string };
  design?: DesignRef;
  ai?: AiFinding[];
  aiError?: string;
  brokenImages: MediaRegion[];
  distortedImages: MediaRegion[];
  failedBackgrounds: Array<MediaRegion & { why: string }>;
  mediaRegions: MediaRegion[];
  /** kept for locating findings; stripped before the JSON dump to keep the file small */
  textIndex: TextItem[];
}

export interface RunReport {
  url: string;
  title: string;
  when: string;
  durationMs: number;
  approvedAt?: string;
  approvedThisRun: boolean;
  viewports: ViewportReport[];
  sweep: SweepResult;
  failedRequests: string[];
  jsErrors: string[];
  aiModel?: string;
  selfCompare?: AiFinding[];
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderReport(r: RunReport): string {
  const host = (() => {
    try {
      return new URL(r.url).host;
    } catch {
      return r.url;
    }
  })();

  const totalAi = r.viewports.reduce((n, v) => n + (v.ai?.filter((f) => f.severity !== 'note').length ?? 0), 0);
  const changedVps = r.viewports.filter((v) => v.diff.changed).length;
  // One broken asset is one problem, however many viewports show it — count unique URLs.
  const brokenCount = new Set(r.viewports.flatMap((v) => [...v.brokenImages, ...v.failedBackgrounds].map((m) => (m.src ?? '').split('?')[0]))).size;
  const criticalReq = r.failedRequests.filter((f) => /\b(script|stylesheet|font|document)\b/.test(f));

  const verdict =
    changedVps || totalAi || brokenCount || r.sweep.breaks.length || criticalReq.length
      ? `<span class="bad">Cần xem</span>`
      : `<span class="ok">Không phát hiện vấn đề</span>`;

  const vpRow = (v: ViewportReport) => {
    const diffCell = v.diff.noBaseline
      ? `<div class="muted">Chưa có bản duyệt — lần chạy này ${r.approvedThisRun ? '<b>đã trở thành bản duyệt</b>' : 'không được lưu làm bản duyệt (thêm <code>--approve</code>)'}.</div>`
      : v.diff.changed
        ? `<a href="${esc(v.diff.diffRel)}" target="_blank"><img src="${esc(v.diff.diffRel)}" alt="diff"></a>
           <div class="cap bad">${v.diff.changedPixels.toLocaleString()} pixel thay đổi${v.diff.baselineHeight !== v.diff.currentHeight ? ` · chiều cao ${v.diff.baselineHeight}→${v.diff.currentHeight}px` : ''}</div>
           ${v.diff.hotspots.length ? `<div class="cap">Vùng thay đổi: ${v.diff.hotspots.map((h) => `y≈${h.y}–${h.y + h.h}`).join(', ')}</div>` : ''}`
        : `<div class="ok big">✓</div><div class="cap">Không đổi so với bản duyệt${r.approvedAt ? ` (${esc(r.approvedAt.slice(0, 16).replace('T', ' '))})` : ''}</div>`;

    const designCell = v.design
      ? `<div class="shotbox"><a href="${esc(v.design.file)}" target="_blank"><img src="${esc(v.design.file)}" alt="design"></a></div>
         <div class="cap">${v.design.mode === 'fidelity' ? `Design ${v.design.width}px — <b>đối chiếu trực tiếp</b>` : `Không có design ${v.width}px — dùng design ${v.design.width}px, <b>chế độ chuyển thể</b>`}</div>`
      : `<div class="muted">Không có design cho viewport này</div>`;

    const det = [
      ...v.brokenImages.map((m) => `<li class="bad"><b>Ảnh không load</b>: <code>${esc(m.selector)}</code><br><span class="mono">${esc(m.src)}</span></li>`),
      ...v.failedBackgrounds.map((m) => `<li class="bad"><b>Ảnh nền CSS lỗi</b> (${esc(m.why)}): <code>${esc(m.selector)}</code><br><span class="mono">${esc(m.src)}</span></li>`),
      ...v.distortedImages.map((m) => `<li><b>Ảnh bị méo</b> ${Math.round((m.distortion ?? 0) * 100)}%: <code>${esc(m.selector)}</code></li>`),
    ];
    const aiList = v.aiError
      ? `<div class="muted">AI không chạy: ${esc(v.aiError)}</div>`
      : v.ai
        ? v.ai.length
          ? `<ul class="find">${v.ai.map((f) => `<li class="${f.severity === 'major' ? 'bad' : f.severity === 'minor' ? 'warn' : ''}">${f.num ? `<span class="num">${f.num}</span>` : ''}<b>${esc(f.title)}</b><br>${esc(f.detail)}${f.crop ? `<a href="${esc(f.crop)}" target="_blank"><img class="crop" src="${esc(f.crop)}" alt="vùng lỗi ${f.num}"></a><div class="cap">Vùng khoanh: ${esc(f.locatedHow ?? '')}</div>` : f.anchors?.length ? `<div class="cap">Không định vị được trên trang (chữ trích: ${esc(f.anchors.join(' / '))})</div>` : ''}</li>`).join('')}</ul>`
          : `<div class="ok">AI không thấy khác biệt đáng kể</div>`
        : `<div class="muted">AI tắt</div>`;

    const mediaNote = v.mediaRegions.filter((m) => m.kind === 'video' || m.kind === 'iframe' || m.kind === 'canvas');

    return `<section class="vp">
      <h2>${esc(v.name)} <small>${v.width}px · trang cao ${v.pageHeight}px</small></h2>
      <div class="grid">
        <div class="col"><h3>Site</h3><div class="shotbox"><a href="${esc(v.shot)}" target="_blank"><img src="${esc(v.shot)}" alt="site"></a></div>
          ${mediaNote.length ? `<div class="cap">${mediaNote.length} vùng video/embed — hiện trắng trong ảnh, đã tự loại khỏi so sánh</div>` : ''}</div>
        <div class="col"><h3>Design</h3>${designCell}</div>
        <div class="col"><h3>So với bản duyệt</h3>${diffCell}</div>
        <div class="col wide"><h3>Phát hiện</h3>
          ${det.length ? `<ul>${det.join('')}</ul>` : ''}
          <h4>AI so với design</h4>${aiList}
        </div>
      </div>
    </section>`;
  };

  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA Visual — ${esc(host)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1a1d23;--mute:#6b7280;--line:#e5e7eb;--bad:#b91c1c;--warn:#a16207;--ok:#15803d}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{background:var(--card);border-bottom:1px solid var(--line);padding:18px 28px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
h1{font-size:18px;margin:0}h1 small{color:var(--mute);font-weight:400;margin-left:8px}
.meta{color:var(--mute);font-size:12px}
main{max-width:1500px;margin:0 auto;padding:20px 28px}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:18px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.stat b{display:block;font-size:22px}.stat span{color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.vp{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:16px}
.vp h2{margin:0 0 12px;font-size:16px}.vp h2 small{color:var(--mute);font-weight:400;margin-left:6px}
.grid{display:grid;grid-template-columns:1fr 1fr 1fr 1.4fr;gap:14px}@media(max-width:1100px){.grid{grid-template-columns:1fr 1fr}}@media(max-width:700px){.grid{grid-template-columns:1fr}}
.col h3{margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mute)}.col h4{margin:12px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mute)}
.col img{width:100%;height:auto;border:1px solid var(--line);border-radius:8px;display:block;background:#fff}
.shotbox{max-height:560px;overflow:auto;border:1px solid var(--line);border-radius:8px;background:#fff}.shotbox img{border:0;border-radius:0}
img.crop{margin-top:8px;border:2px solid var(--bad);border-radius:6px}
.find li{position:relative;padding-left:26px}.num{position:absolute;left:0;top:1px;background:var(--bad);color:#fff;font-size:11px;font-weight:700;width:18px;height:18px;line-height:18px;text-align:center;border-radius:4px}
.cap{font-size:12px;color:var(--mute);margin-top:6px}.muted{color:var(--mute);font-size:13px}.mono{font:11px ui-monospace,Menlo,monospace;word-break:break-all;color:var(--mute)}
.bad{color:var(--bad)}.warn{color:var(--warn)}.ok{color:var(--ok)}.big{font-size:40px;text-align:center;padding:30px 0 6px}
ul{margin:4px 0;padding-left:18px}li{margin:6px 0}code{font:12px ui-monospace,Menlo,monospace;background:var(--bg);padding:1px 5px;border-radius:4px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin-bottom:16px}
.panel h3{margin:0 0 8px;font-size:14px}
footer{color:var(--mute);font-size:12px;padding:18px 28px;border-top:1px solid var(--line);margin-top:20px}
</style></head><body>
<header><div><h1>QA Visual <small>${esc(host)}</small></h1><div class="meta">${esc(r.title)} · ${esc(r.when.slice(0, 19).replace('T', ' '))} · ${(r.durationMs / 1000).toFixed(0)}s${r.aiModel ? ' · AI: ' + esc(r.aiModel) : ''}</div></div><div style="font-size:16px;font-weight:600">${verdict}</div></header>
<main>
<div class="summary">
  <div class="stat"><b class="${changedVps ? 'bad' : 'ok'}">${changedVps}/${r.viewports.length}</b><span>viewport đổi so với bản duyệt</span></div>
  <div class="stat"><b class="${totalAi ? 'warn' : 'ok'}">${totalAi}</b><span>khác biệt AI so với design</span></div>
  <div class="stat"><b class="${brokenCount ? 'bad' : 'ok'}">${brokenCount}</b><span>ảnh / nền không load</span></div>
  <div class="stat"><b class="${r.sweep.breaks.length ? 'bad' : 'ok'}">${r.sweep.breaks.length}</b><span>khoảng width layout vỡ</span></div>
  <div class="stat"><b class="${criticalReq.length ? 'bad' : 'ok'}">${criticalReq.length}</b><span>script/css/font lỗi</span></div>
</div>

${r.sweep.breaks.length ? `<div class="panel"><h3 class="bad">Layout tràn ngang</h3><ul>${r.sweep.breaks.map((b) => `<li>Từ <b>${b.from}px</b> xuống <b>${b.to}px</b> trang rộng hơn màn hình tới ${b.overflowPx}px — cần media query quanh ${b.from}px.</li>`).join('')}</ul><div class="cap">Quét ${r.sweep.checked} chiều rộng từ 1600px xuống 320px.</div></div>` : ''}

${r.selfCompare?.length ? `<div class="panel"><h3>Desktop ↔ Mobile của chính site</h3><ul>${r.selfCompare.map((f) => `<li class="${f.severity === 'major' ? 'bad' : f.severity === 'minor' ? 'warn' : ''}">${f.num ? `<span class="num">${f.num}</span>` : ''}<b>${esc(f.title)}</b><br>${esc(f.detail)}${f.crop ? `<a href="${esc(f.crop)}" target="_blank"><img class="crop" src="${esc(f.crop)}" alt="vùng lỗi"></a><div class="cap">Vùng khoanh: ${esc(f.locatedHow ?? '')}</div>` : ''}</li>`).join('')}</ul></div>` : ''}

${r.viewports.map(vpRow).join('')}

${r.failedRequests.length || r.jsErrors.length ? `<div class="panel"><h3>Request lỗi & JS error</h3>${criticalReq.length ? `<ul>${criticalReq.map((f) => `<li class="bad mono">${esc(f)}</li>`).join('')}</ul>` : ''}<details><summary class="muted">Tất cả (${r.failedRequests.length} request, ${r.jsErrors.length} JS error)</summary><ul>${[...r.failedRequests, ...r.jsErrors].map((f) => `<li class="mono">${esc(f)}</li>`).join('')}</ul></details></div>` : ''}
</main>
<footer>qa-visual v2 · Ảnh video/iframe/canvas hiện trắng trong screenshot và được tự động loại khỏi so sánh. "So với bản duyệt" dùng ngưỡng ${150} pixel tuyệt đối. Chạy lại với <code>--approve</code> để chốt lần chạy này làm bản duyệt mới.</footer>
</body></html>`;
}
