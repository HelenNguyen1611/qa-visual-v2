import type { DiffResult } from './compare.js';
import type { SweepResult } from './sweep.js';
import type { MediaRegion, TextItem } from './browser.js';
import type { GroupedFinding } from './group.js';

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
  crop?: string;
  num?: number;
}

export interface DesignRef {
  file: string;
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
  brokenImages: MediaRegion[];
  distortedImages: MediaRegion[];
  failedBackgrounds: Array<MediaRegion & { why: string }>;
  mediaRegions: MediaRegion[];
  /** kept for locating findings; stripped before the JSON dump */
  textIndex: TextItem[];
}

export interface PageReport {
  url: string;
  slug: string;
  title: string;
  viewports: ViewportReport[];
  mapping: { frameName?: string; frameWidth?: number; how: string; score: number; isTemplate: boolean };
  designFile?: string;
  aiError?: string;
  /** the design pairing looks wrong — an implausible pile of structural findings */
  mispaired: boolean;
  failedRequests: string[];
  jsErrors: string[];
}

export interface RunReport {
  site: string;
  when: string;
  durationMs: number;
  approvedThisRun: boolean;
  pages: PageReport[];
  /** one entry per defect, already collapsed across pages and viewports */
  findings: GroupedFinding[];
  sweeps: Array<{ url: string } & SweepResult>;
  sharedTextCount: number;
  aiModel?: string;
  rawFindingCount: number;
  /** vision calls attempted and how many never answered — a partial run must not read as a clean one */
  ai?: { calls: number; failures: number; lastError?: string; stopped?: string };
  /** the run this one was compared against, and what it reported that this run did not */
  drift?: { previousRun: string; gone: Array<{ title: string; severity: string; scope: string }> };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const path = (u: string) => {
  try {
    const x = new URL(u);
    return (x.pathname.replace(/\/+$/, '') || '/') + x.search;
  } catch {
    return u;
  }
};

export function renderReport(r: RunReport): string {
  const host = (() => {
    try {
      return new URL(r.site).host;
    } catch {
      return r.site;
    }
  })();

  const template = r.findings.filter((f) => f.scope === 'template');
  const perPage = r.findings.filter((f) => f.scope === 'page');
  const changedPages = r.pages.filter((p) => p.viewports.some((v) => v.diff.changed));
  const brokenAssets = new Set(
    r.pages.flatMap((p) => p.viewports.flatMap((v) => [...v.brokenImages, ...v.failedBackgrounds].map((m) => (m.src ?? '').split('?')[0]))),
  );
  brokenAssets.delete('');
  const criticalReq = Array.from(new Set(r.pages.flatMap((p) => p.failedRequests))).filter((f) => /\b(script|stylesheet|font|document)\b/.test(f));
  const unmapped = r.pages.filter((p) => !p.mapping.frameName);
  const mispaired = r.pages.filter((p) => p.mispaired);
  const majors = r.findings.filter((f) => f.severity === 'major').length;

/**
 * Every finding as one row, with a column per screen size.
 *
 * The chip list ("mobile, tablet") answered the question one finding at a time; a developer
 * planning the fix needs the other cut — which sizes are affected, and whether a bug is
 * mobile-only or everywhere. That only reads off a grid.
 *
 * A blank cell means the model did not report it at that width, which is NOT proof the defect is
 * absent there: it may simply not have been mentioned. The caption says so, because a grid invites
 * being read as measurement.
 */
const VP_COLS = ['mobile', 'tablet', 'desktop'] as const;

const findingTable = (list: GroupedFinding[], r: RunReport) => {
  if (!list.length) return '';
  const sev = { major: 'nặng', minor: 'vừa', note: 'nhẹ' } as Record<string, string>;
  return `<div class="panel" style="padding:0;overflow-x:auto">
  <table class="grid">
    <thead><tr>
      <th>#</th><th>Lỗi</th><th>Mức</th><th>Phạm vi</th>
      ${VP_COLS.map((v) => `<th class="c">${v === 'mobile' ? 'Mobile<br><span class="cap">390</span>' : v === 'tablet' ? 'Tablet<br><span class="cap">768</span>' : 'Desktop<br><span class="cap">1440</span>'}</th>`).join('')}
      <th class="c">Trang</th><th></th>
    </tr></thead>
    <tbody>${list
      .map(
        (f) => `<tr>
        <td class="mono">${f.num}</td>
        <td><a href="#f${f.num}">${esc(f.title)}</a></td>
        <td><span class="chip ${f.severity}">${sev[f.severity]}</span></td>
        <td>${f.scope === 'template' ? '<span class="chip tpl">dùng chung</span>' : '<span class="cap">riêng trang</span>'}</td>
        ${VP_COLS.map((v) => `<td class="c ${f.viewports.includes(v) ? 'yes' : 'no'}">${f.viewports.includes(v) ? '●' : '·'}</td>`).join('')}
        <td class="c mono">${f.pages.length}/${r.pages.length}</td>
        <td class="c">${f.isNew === true ? '<span class="chip new">mới</span>' : ''}</td>
      </tr>`,
      )
      .join('')}</tbody>
  </table>
  <div class="cap" style="padding:8px 12px">● = AI báo lỗi ở kích thước đó. Ô trống nghĩa là <b>không được báo</b> ở kích thước đó — chưa chắc là không có lỗi.</div>
</div>`;
};


  const findingBlock = (f: GroupedFinding, showScope: boolean) => `
    <div class="find ${f.severity}" id="f${f.num}">
      <div class="fhead"><span class="num">${f.num}</span>
        <b>${esc(f.title)}</b>
        <span class="chip ${f.severity}">${f.severity === 'major' ? 'nặng' : f.severity === 'minor' ? 'nhẹ' : 'ghi chú'}</span>
        ${showScope && f.scope === 'template' ? `<span class="chip tpl">component dùng chung</span>` : ''}
        <span class="chip">${f.viewports.join(', ')}</span>
        ${f.merged > 1 ? `<span class="chip">gộp từ ${f.merged} nhận xét</span>` : ''}
        ${f.isNew === true ? `<span class="chip new">mới</span>` : f.isNew === false ? `<span class="chip">vẫn còn từ lần trước</span>` : ''}
      </div>
      <p>${esc(f.detail)}</p>
      <div class="cap">
        ${f.scope === 'template'
          ? `Xuất hiện ở <b>${f.pages.length}/${r.pages.length} trang</b> — sửa một lần là hết ở tất cả: ${f.pages.map((p) => `<code>${esc(path(p))}</code>`).join(' ')}`
          : `Trang: ${f.pages.map((p) => `<code>${esc(path(p))}</code>`).join(' ')}`}
      </div>
      ${f.crop
        ? `<a href="${esc(f.crop)}" target="_blank"><img class="crop" src="${esc(f.crop)}" alt="vùng lỗi ${f.num}"></a><div class="cap">Vùng khoanh: ${esc(f.locatedHow ?? '')}</div>`
        : f.anchors?.length
          ? `<div class="cap warn">Không định vị được trên trang — chữ AI trích: ${esc(f.anchors.join(' / '))}</div>`
          : ''}
    </div>`;

  const pageRow = (p: PageReport) => {
    const mine = perPage.filter((f) => f.pages.includes(p.url));
    const changed = p.viewports.filter((v) => v.diff.changed);
    const assets = p.viewports[0] ? [...p.viewports[0].brokenImages, ...p.viewports[0].failedBackgrounds] : [];
    return `
    <details class="page" ${mine.length || changed.length || p.mispaired ? 'open' : ''}>
      <summary>
        <b>${esc(path(p.url))}</b>
        <span class="chip">${mine.length} lỗi riêng</span>
        ${changed.length ? `<span class="chip bad">khác bản duyệt: ${changed.map((v) => v.name).join(', ')}</span>` : `<span class="chip ok">không đổi</span>`}
        ${p.mapping.frameName ? `<span class="chip">design: ${esc(p.mapping.frameName)}</span>` : `<span class="chip warn">chưa có design</span>`}
        ${assets.length ? `<span class="chip bad">${assets.length} ảnh lỗi</span>` : ''}
      </summary>
      <div class="pbody">
        <div class="cap">Ghép design: ${esc(p.mapping.how)}</div>
        ${p.mispaired ? `<div class="alert">Cảnh báo: có thể đã <b>ghép sai design</b> cho trang này — số lượng nhận xét kiểu "thiếu phần tử / sai thứ tự" bất thường cao. Kiểm tra lại <code>pages.json</code> trước khi tin các lỗi bên dưới.</div>` : ''}
        ${p.aiError ? `<div class="cap warn">AI lỗi: ${esc(p.aiError)}</div>` : ''}
        <div class="shots">
          ${p.viewports
            .map(
              (v) => `<div class="col">
                <h4>${v.name} <span class="cap">${v.width}px · cao ${v.pageHeight}px</span></h4>
                <div class="shotbox"><a href="${esc(v.shot)}" target="_blank"><img src="${esc(v.shot)}" alt=""></a></div>
                ${v.diff.noBaseline
                  ? `<div class="cap">chưa có bản duyệt</div>`
                  : v.diff.changed
                    ? `<div class="cap bad">${v.diff.changedPixels.toLocaleString()} px đổi${v.diff.baselineHeight !== v.diff.currentHeight ? ` · cao ${v.diff.baselineHeight}→${v.diff.currentHeight}` : ''}</div>
                       ${v.diff.diffRel ? `<a href="${esc(v.diff.diffRel)}" target="_blank">xem ảnh diff</a>` : ''}`
                    : `<div class="cap ok">không đổi</div>`}
              </div>`,
            )
            .join('')}
          ${p.designFile ? `<div class="col"><h4>design <span class="cap">${p.mapping.frameWidth ?? ''}px</span></h4><div class="shotbox"><a href="${esc(p.designFile)}" target="_blank"><img src="${esc(p.designFile)}" alt=""></a></div></div>` : ''}
        </div>
        ${assets.length ? `<ul>${assets.map((m: any) => `<li class="bad">${m.why ? `Ảnh nền CSS lỗi (${esc(m.why)})` : 'Ảnh không load'}: <span class="mono">${esc(m.src)}</span></li>`).join('')}</ul>` : ''}
        ${mine.length ? mine.map((f) => findingBlock(f, false)).join('') : `<div class="cap">Không có lỗi riêng của trang này.</div>`}
      </div>
    </details>`;
  };

  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA Visual — ${esc(host)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1a1d23;--mute:#6b7280;--line:#e5e7eb;--bad:#b91c1c;--warn:#a16207;--ok:#15803d;--tpl:#6d28d9}
*{box-sizing:border-box}body{margin:0;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{background:var(--card);border-bottom:1px solid var(--line);padding:18px 28px}
h1{font-size:19px;margin:0}h1 small{color:var(--mute);font-weight:400;margin-left:8px}
.meta{color:var(--mute);font-size:12px;margin-top:4px}
main{max-width:1180px;margin:0 auto;padding:20px 28px 60px}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:28px 0 10px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.stat b{display:block;font-size:22px}.stat span{color:var(--mute);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.find{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--mute);border-radius:10px;padding:14px 16px;margin-bottom:12px}
.find.major{border-left-color:var(--bad)}.find.minor{border-left-color:var(--warn)}
.fhead{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
.find p{margin:4px 0 8px}
.num{background:var(--ink);color:#fff;font-size:11px;font-weight:700;min-width:20px;height:20px;line-height:20px;text-align:center;border-radius:5px;padding:0 5px}
.chip{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--mute);white-space:nowrap}
.chip.major{border-color:var(--bad);color:var(--bad)}.chip.minor{border-color:var(--warn);color:var(--warn)}
.chip.tpl{border-color:var(--tpl);color:var(--tpl);font-weight:600}
.chip.bad{border-color:var(--bad);color:var(--bad)}.chip.ok{border-color:var(--ok);color:var(--ok)}.chip.warn{border-color:var(--warn);color:var(--warn)}
img.crop{max-width:100%;margin-top:8px;border:2px solid var(--bad);border-radius:6px;display:block}
.cap{font-size:12px;color:var(--mute)}.cap.bad,.bad{color:var(--bad)}.cap.ok,.ok{color:var(--ok)}.cap.warn,.warn{color:var(--warn)}
.mono{font:11px ui-monospace,Menlo,monospace;word-break:break-all}
code{font:11px ui-monospace,Menlo,monospace;background:var(--bg);padding:1px 5px;border-radius:4px}
.page{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:10px}
.page summary{padding:12px 16px;cursor:pointer;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pbody{padding:0 16px 16px}
.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:10px 0}
.col h4{margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mute);font-weight:600}
.shotbox{max-height:320px;overflow:auto;border:1px solid var(--line);border-radius:8px;background:#fff}.shotbox img{width:100%;display:block}
.alert{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:8px;padding:10px 12px;font-size:13px;margin:8px 0}

.chip.new{background:#ecfdf3;border-color:#abefc6;color:#067647}
table.grid{width:100%;border-collapse:collapse;font-size:13px}
table.grid th{text-align:left;padding:8px 10px;border-bottom:1px solid #e3e6ea;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;vertical-align:bottom}
table.grid td{padding:8px 10px;border-bottom:1px solid #eef0f3;vertical-align:middle}
table.grid tr:last-child td{border-bottom:0}
table.grid th.c,table.grid td.c{text-align:center}
table.grid td.yes{color:#b42318;font-size:15px}
table.grid td.no{color:#cbd2d9}
table.grid td a{color:inherit;text-decoration:none;border-bottom:1px solid #d5dae0}
table.grid td a:hover{border-bottom-color:#1f6feb;color:#1f6feb}
.gone li{margin:3px 0}
.fatal{background:#fef3f2;border:1px solid #f6cfca;color:#b42318;border-radius:8px;padding:12px 14px;font-size:13.5px;margin:8px 0}
.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}th{color:var(--mute);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
ul{margin:6px 0;padding-left:18px}li{margin:3px 0}
footer{color:var(--mute);font-size:12px;padding:16px 28px;border-top:1px solid var(--line)}
</style></head><body>
<header>
  <h1>QA Visual <small>${esc(host)}</small></h1>
  <div class="meta">${esc(r.when.slice(0, 19).replace('T', ' '))} · ${(r.durationMs / 1000).toFixed(0)}s · ${r.pages.length} trang${r.aiModel ? ' · AI: ' + esc(r.aiModel) : ' · AI tắt'}${r.approvedThisRun ? ' · <b>lần chạy này đã thành bản duyệt</b>' : ''}</div>
</header>
<main>

<div class="stats">
  <div class="stat"><b class="${majors ? 'bad' : 'ok'}">${majors}</b><span>lỗi nặng</span></div>
  <div class="stat"><b class="${template.length ? 'bad' : 'ok'}" style="color:var(--tpl)">${template.length}</b><span>lỗi component dùng chung</span></div>
  <div class="stat"><b>${perPage.length}</b><span>lỗi riêng từng trang</span></div>
  <div class="stat"><b class="${changedPages.length ? 'bad' : 'ok'}">${changedPages.length}/${r.pages.length}</b><span>trang khác bản duyệt</span></div>
  <div class="stat"><b class="${brokenAssets.size ? 'bad' : 'ok'}">${brokenAssets.size}</b><span>ảnh / nền không load</span></div>
  <div class="stat"><b class="${criticalReq.length ? 'bad' : 'ok'}">${criticalReq.length}</b><span>script/css/font lỗi</span></div>
</div>

${r.ai && r.ai.failures
  ? `<div class="panel fatal"><b>⚠ Báo cáo KHÔNG đầy đủ.</b> ${r.ai.failures}/${r.ai.calls} lời gọi AI thất bại (đã thử lại 3 lần), nên những vùng đó <b>chưa được kiểm</b> — danh sách lỗi dưới đây thiếu, không phải site sạch.<br><span class="cap">${r.ai.stopped ? esc(r.ai.stopped) : 'Lỗi đầu tiên: ' + esc(r.ai.lastError ?? '')}</span></div>`
  : ''}
${r.drift
  ? `<div class="panel"><h3 style="margin:0 0 6px;font-size:13px">Đối chiếu với lần chạy trước (${esc(r.drift.previousRun)})</h3>` +
    `<div class="cap">${r.findings.filter((f) => f.isNew).length} lỗi mới · ${r.findings.filter((f) => f.isNew === false).length} vẫn còn · ${r.drift.gone.length} lần trước có mà lần này không thấy</div>` +
    (r.drift.gone.length
      ? `<div class="alert" style="margin-top:8px"><b>Lần trước báo, lần này không thấy — cần bạn xác nhận đã sửa hay AI bỏ sót:</b><ul class="gone">${r.drift.gone
          .map((g) => `<li>${esc(g.title)} <span class="cap">(${esc(g.severity)}${g.scope === 'template' ? ', component dùng chung' : ''})</span></li>`)
          .join('')}</ul></div>`
      : '')
    + `</div>`
  : ''}
${r.rawFindingCount > r.findings.length
  ? `<div class="panel cap">Đã gộp <b>${r.rawFindingCount}</b> nhận xét thô thành <b>${r.findings.length}</b> lỗi — nhờ nhận diện ${r.sharedTextCount} chuỗi chữ thuộc component dùng chung (có mặt ở ≥60% số trang).</div>`
  : ''}

${mispaired.length
  ? `<div class="alert"><b>Có thể ghép sai design</b> ở ${mispaired.length} trang: ${mispaired.map((p) => `<code>${esc(path(p.url))}</code>`).join(' ')}. Mở <code>pages.json</code> kiểm tra lại trước khi tin các lỗi của những trang này.</div>`
  : ''}

<h2>Bảng ghép URL ↔ design</h2>
<div class="panel">
  <table>
    <tr><th>Trang</th><th>Frame Figma</th><th>Cách ghép</th></tr>
    ${r.pages
      .map(
        (p) => `<tr>
          <td><a href="${esc(p.url)}" target="_blank">${esc(path(p.url))}</a></td>
          <td>${p.mapping.frameName ? esc(p.mapping.frameName) + (p.mapping.isTemplate ? ' <span class="chip">template</span>' : '') : '<span class="warn">chưa ghép</span>'}</td>
          <td class="cap">${esc(p.mapping.how)}</td>
        </tr>`,
      )
      .join('')}
  </table>
  ${unmapped.length ? `<div class="cap warn" style="margin-top:8px">${unmapped.length} trang chưa có design — vẫn được so với bản duyệt, quét sweep và kiểm ảnh lỗi, nhưng không đối chiếu design.</div>` : ''}
</div>

${r.sweeps.some((s) => s.breaks.length)
  ? `<h2>Layout tràn ngang</h2><div class="panel">${r.sweeps
      .filter((s) => s.breaks.length)
      .map(
        (s) =>
          `<div><code>${esc(path(s.url))}</code><ul>${s.breaks
            .map((b) => `<li>Từ <b>${b.from}px</b> xuống <b>${b.to}px</b> trang rộng hơn màn hình tới ${b.overflowPx}px — cần media query quanh ${b.from}px.</li>`)
            .join('')}</ul></div>`,
      )
      .join('')}<div class="cap">Sweep chạy ở trang chủ (điểm vỡ layout là chuyện của template, không cần quét mọi trang).</div></div>`
  : ''}

${r.findings.length ? `<h2>Tất cả lỗi theo kích thước màn hình</h2>${findingTable(r.findings, r)}` : ''}

${template.length
  ? `<h2>Lỗi ở component dùng chung — sửa một lần, hết ở mọi trang</h2>${template.map((f) => findingBlock(f, true)).join('')}`
  : `<h2>Lỗi ở component dùng chung</h2><div class="panel cap">Không phát hiện lỗi nào ở header / nav / footer.</div>`}

<h2>Từng trang</h2>
${r.pages.map(pageRow).join('')}

${criticalReq.length
  ? `<h2>Request lỗi</h2><div class="panel"><ul>${criticalReq.slice(0, 20).map((f) => `<li class="bad mono">${esc(f)}</li>`).join('')}</ul></div>`
  : ''}

</main>
<footer>qa-visual v2 · Vùng video/iframe/canvas hiện trắng trong ảnh chụp nên được tự loại khỏi so sánh. Vùng lỗi được khoanh bằng cách tra chữ AI trích dẫn vào DOM, không dùng toạ độ AI đoán. Chạy lại với <code>--approve</code> để chốt bản duyệt mới.</footer>
</body></html>`;
}
