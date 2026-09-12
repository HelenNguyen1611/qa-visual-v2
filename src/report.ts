import type { DiffResult } from './compare.js';
import type { SweepResult } from './sweep.js';
import type { MediaRegion, TextItem, ReservedRegion } from './browser.js';
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
  /** proved by the browser's own measurements rather than reported by a model */
  measured?: boolean;
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
  /** kept for the measured checks; stripped before the JSON dump */
  reserved: ReservedRegion[];
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
  /** of those raw findings, how many came from measurement rather than from the model */
  measuredFindingCount?: number;
  /** vision calls attempted and how many never answered — a partial run must not read as a clean one */
  ai?: { calls: number; failures: number; lastError?: string; stopped?: string; wrongLang?: number; silent?: boolean };
  /** the run this one was compared against, and what it reported that this run did not */
  drift?: { previousRun: string; gone: Array<{ title: string; severity: string; scope: string }> };
  /** free text a person added after reading the report — what the AI missed, or context for readers */
  humanNotes?: string;
  humanNotesAt?: string;
  /** how the run got past a login gate — the method, never the credentials */
  authHow?: string;
  /** this batch vs every URL of the same site that has appeared in any run */
  coverage?: { ran: number; seen: number };
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

/**
 * False-positive sign-off only works when this file is served by the local tool (so /api exists).
 * A downloaded share file hides the editor: there is no server, and the recipient should not
 * rewrite someone else's judgement.
 */
const ACCEPT_SCRIPT = [
  '<script>',
  '(function () {',
  "  var m = location.pathname.match(/\\/reports\\/([^/]+)\\//);",
  "  var boxes = document.querySelectorAll('.acceptbox');",
  '  if (!m || /share/i.test(location.pathname)) {',
  "    boxes.forEach(function (b) { var e = b.querySelector('.acceptedit'); if (e) e.hidden = true; });",
  '    return;',
  '  }',
  '  var stamp = m[1];',
  "  boxes.forEach(function (box) {",
  "    box.addEventListener('click', function (ev) {",
  "      var btn = ev.target.closest && ev.target.closest('[data-act]');",
  '      if (!btn || !box.contains(btn)) return;',
  "      var act = btn.getAttribute('data-act');",
  "      var ta = box.querySelector('textarea.why');",
  "      var st = box.querySelector('.acceptstate');",
  "      var why = ta ? ta.value : '';",
  "      var accepted = act !== 'undo';",
  "      if (accepted && !why.trim()) {",
  "        if (st) { st.className = 'acceptstate bad'; st.textContent = 'cần lý do — không lưu im lặng'; }",
  '        return;',
  '      }',
  "      btn.disabled = true;",
  "      if (st) { st.className = 'acceptstate'; st.textContent = 'Đang lưu…'; }",
  "      fetch('/api/findings/accept', {",
  "        method: 'POST',",
  "        headers: { 'content-type': 'application/json' },",
  "        body: JSON.stringify({ stamp: stamp, num: Number(box.getAttribute('data-num')), why: why, accepted: accepted })",
  '      }).then(function (res) { return res.json().then(function (d) { return { ok: res.ok, d: d }; }); })',
  '        .then(function (x) {',
  "          if (!x.ok) throw new Error(x.d.error || 'không lưu được');",
  '          location.reload();',
  '        })',
  '        .catch(function (e) {',
  "          btn.disabled = false;",
  "          if (st) { st.className = 'acceptstate bad'; st.textContent = e.message || String(e); }",
  '        });',
  '    });',
  '  });',
  '})();',
  '</script>',
].join('\n');

export function renderReport(r: RunReport): string {
  const host = (() => {
    try {
      return new URL(r.site).host;
    } catch {
      return r.site;
    }
  })();

  // Accepted findings stay in the report but never in a count — a suppression you cannot see is
  // one nobody re-examines when the page changes underneath it.
  const open = r.findings.filter((f) => !f.accepted);
  const accepted = r.findings.filter((f) => f.accepted);
  const template = open.filter((f) => f.scope === 'template');
  const perPage = open.filter((f) => f.scope === 'page');
  const changedPages = r.pages.filter((p) => p.viewports.some((v) => v.diff.changed));
  const brokenAssets = new Set(
    r.pages.flatMap((p) => p.viewports.flatMap((v) => [...v.brokenImages, ...v.failedBackgrounds].map((m) => (m.src ?? '').split('?')[0]))),
  );
  brokenAssets.delete('');
  const criticalReq = Array.from(new Set(r.pages.flatMap((p) => p.failedRequests))).filter((f) => /\b(script|stylesheet|font|document)\b/.test(f));
  const unmapped = r.pages.filter((p) => !p.mapping.frameName);
  const mispaired = r.pages.filter((p) => p.mispaired);
  const majors = open.filter((f) => f.severity === 'major').length;
  const SEV = { major: 'nặng', minor: 'vừa', note: 'nhẹ' } as Record<string, string>;
  const VP_COLS = ['mobile', 'tablet', 'desktop'] as const;
  const VP_W = { mobile: 390, tablet: 768, desktop: 1440 } as const;

  /**
   * The one sentence somebody reads before deciding whether to keep reading.
   *
   * A run whose model calls mostly failed must not open with "no problems found" — that reads as
   * good news and it is the opposite. Coverage is stated before any count.
   */
  const verdict = (() => {
    if (r.ai?.failures && r.ai.failures >= r.ai.calls) return { tone: 'bad', line: 'Chưa kiểm được', sub: 'Toàn bộ lời gọi AI thất bại — chưa có kết luận nào về site.' };
    if (!open.length && r.ai?.silent)
      return {
        tone: 'warn',
        line: 'Không có kết quả — nghi model quá yếu',
        sub: `${r.ai.calls}/${r.ai.calls} lời gọi AI thành công nhưng model không nêu một lỗi nào. Đây không phải kết luận "site sạch".`,
      };
    // Zero findings right after a run that found several, with no errors, is a red flag not a pass.
    if (!open.length && (r.drift?.gone.length ?? 0) >= 3)
      return {
        tone: 'warn',
        line: 'Không tìm thấy lỗi nào — đáng ngờ',
        sub: `Lần chạy trước báo ${r.drift!.gone.length} lỗi trên cùng site này. Kiểm tra danh sách bên dưới trước khi coi là đã sửa hết.`,
      };
    if (!open.length) return { tone: 'ok', line: 'Không tìm thấy lỗi nào', sub: `Đã đối chiếu ${r.pages.length} trang ở 3 kích thước màn hình.` };
    const parts = [`${open.length} lỗi`];
    if (template.length) parts.push(`${template.length} ở component dùng chung`);
    if (majors) parts.push(`${majors} mức nặng`);
    return { tone: majors ? 'bad' : 'warn', line: parts[0], sub: parts.slice(1).join(' · ') || `Trên ${r.pages.length} trang.` };
  })();

  /** Index of findings — the fast scan, with a column per screen size. Cards below are the detail. */
  const indexTable = () =>
    !open.length
      ? ''
      : `<div class="tablewrap">
  <table class="grid">
    <thead><tr>
      <th class="c">#</th><th>Lỗi</th><th>Mức</th><th>Phạm vi</th>
      ${VP_COLS.map((v) => `<th class="c">${v[0].toUpperCase() + v.slice(1)}<br><span class="tiny">${VP_W[v]}px</span></th>`).join('')}
      <th class="c">Trang</th>
    </tr></thead>
    <tbody>${open
      .map(
        (f) => `<tr>
        <td class="c tnum">${f.num}</td>
        <td><a href="#f${f.num}">${esc(f.title)}</a>${f.isNew === true ? ' <span class="chip new">mới</span>' : ''}${
          f.measured ? ' <span class="chip meas">đo được</span>' : ''
        }</td>
        <td><span class="chip ${f.severity}">${SEV[f.severity]}</span></td>
        <td>${f.scope === 'template' ? '<span class="chip tpl">dùng chung</span>' : '<span class="tiny">riêng trang</span>'}</td>
        ${VP_COLS.map((v) => `<td class="c ${f.viewports.includes(v) ? 'yes' : 'no'}">${f.viewports.includes(v) ? '●' : '·'}</td>`).join('')}
        <td class="c tnum">${f.pages.length}/${r.pages.length}</td>
      </tr>`,
      )
      .join('')}</tbody>
  </table>
  <p class="note">● = lỗi được báo ở kích thước đó. Ô trống nghĩa là <b>không được báo</b> ở kích thước đó — chưa chắc là không có lỗi.
  <b>đo được</b> = tool đo trên DOM (box chồng nhau, cỡ chữ, khoảng trống) nên đúng sai không phụ thuộc model; không có nhãn đó là nhận xét của AI.</p>
</div>`;

  /**
   * One finding.
   *
   * The cropped screenshot leads, because it answers "where" in a glance that no sentence can. The
   * prose that used to sit above it made every card look the same until you read it.
   */
  const findingBlock = (f: GroupedFinding) => `
  <article class="find ${f.severity}${f.accepted ? ' ok2' : ''}" id="f${f.num}">
    <div class="fbody">
      <div class="fhead">
        <span class="num">${f.num}</span>
        <h3>${esc(f.title)}</h3>
      </div>
      <div class="acceptbox" data-num="${f.num}">
        ${
          f.accepted
            ? `<p class="accepted"><b>False positive / chủ ý.</b> ${esc(f.acceptedWhy ?? '')}</p>`
            : `<p class="acceptcmd">Human check: đây là false positive hoặc chủ ý? Ghi lý do rồi lưu — lần sau vẫn hiện nhưng không tính.</p>`
        }
        <div class="acceptedit">
          <textarea class="why" rows="2" placeholder="Lý do, ví dụ: khoảng trống do form nằm cột phải, không phải lỗi.">${f.accepted ? esc(f.acceptedWhy ?? '') : ''}</textarea>
          <div class="acceptrow">
            <button type="button" data-act="save">${f.accepted ? 'Cập nhật lý do' : 'Bỏ qua lỗi này'}</button>
            ${f.accepted ? `<button type="button" data-act="undo">Bỏ xác nhận</button>` : ''}
            <span class="acceptstate"></span>
          </div>
        </div>
      </div>
      <div class="chips">
        <span class="chip ${f.severity}">${SEV[f.severity]}</span>
        ${f.measured ? `<span class="chip meas" title="${esc(f.locatedHow ?? '')}">đo được</span>` : `<span class="chip quiet">AI nhận xét</span>`}
        ${f.scope === 'template' ? `<span class="chip tpl">component dùng chung</span>` : ''}
        ${f.viewports.map((v) => `<span class="chip">${v}</span>`).join('')}
        ${f.isNew === true ? `<span class="chip new">mới</span>` : f.isNew === false ? `<span class="chip">vẫn còn từ lần trước</span>` : ''}
        ${f.merged > 1 ? `<span class="chip quiet">gộp từ ${f.merged} nhận xét</span>` : ''}
      </div>
      <p>${esc(f.detail)}</p>
      ${
        !f.crop && f.anchors?.length
          ? `<p class="noloc">Chưa khoanh được vùng trên ảnh — chữ AI trích: <code>${esc(f.anchors.slice(0, 2).join('</code> <code>'))}</code></p>`
          : ''
      }
      <p class="where">${
        f.scope === 'template'
          ? `Có ở <b>${f.pages.length}/${r.pages.length} trang</b> — sửa một lần là hết ở tất cả: ${f.pages.map((p) => `<code>${esc(path(p))}</code>`).join(' ')}`
          : `Trang: ${f.pages.map((p) => `<code>${esc(path(p))}</code>`).join(' ')}`
      }</p>
    </div>
    ${
      f.crop
        ? `<a class="shot pic" href="${esc(f.crop)}" target="_blank"><img src="${esc(f.crop)}" alt="vùng lỗi ${f.num}" loading="lazy"><span class="zoom">Bấm để xem to</span></a>`
        : ''
    }
  </article>`;

  const pageRow = (p: PageReport) => {
    const mine = perPage.filter((f) => f.pages.includes(p.url));
    const changed = p.viewports.filter((v) => v.diff.changed);
    const assets = p.viewports[0] ? [...p.viewports[0].brokenImages, ...p.viewports[0].failedBackgrounds] : [];
    const flags = [
      mine.length ? `${mine.length} lỗi riêng` : '',
      changed.length ? `${changed.length} kích thước khác bản duyệt` : '',
      p.mispaired ? 'nghi ghép sai design' : '',
      p.aiError ? 'AI lỗi' : '',
    ].filter(Boolean);
    return `
    <details class="page"${mine.length || p.mispaired ? ' open' : ''}>
      <summary>
        <code>${esc(path(p.url))}</code>
        <span class="tiny">${p.mapping.frameName ? '↔ ' + esc(p.mapping.frameName) : 'chưa ghép design'}</span>
        <span class="grow"></span>
        ${flags.length ? `<span class="tiny ${mine.length || p.mispaired ? 'bad' : ''}">${flags.join(' · ')}</span>` : '<span class="tiny ok">ổn</span>'}
      </summary>
      <div class="pbody">
        ${p.mispaired ? `<div class="alert"><b>Có thể ghép sai design cho trang này</b> — số nhận xét kiểu "thiếu phần tử / sai thứ tự" cao bất thường. Kiểm tra lại bảng ghép trước khi tin các lỗi bên dưới.</div>` : ''}
        ${p.aiError ? `<div class="alert">AI lỗi ở trang này: ${esc(p.aiError)}</div>` : ''}
        ${mine.map(findingBlock).join('')}
        ${assets.length ? `<ul class="plain">${assets.map((m: any) => `<li class="bad">${m.why ? `Ảnh nền CSS lỗi (${esc(m.why)})` : 'Ảnh không load'}: <span class="mono">${esc(m.src)}</span></li>`).join('')}</ul>` : ''}
        <div class="shots">
          ${p.viewports
            .map(
              (v) => `<figure>
                <figcaption>${v.name} <span class="tiny">${v.width}px · cao ${v.pageHeight}px</span></figcaption>
                <a href="${esc(v.shot)}" target="_blank"><img src="${esc(v.shot)}" alt="" loading="lazy"></a>
                ${
                  v.diff.noBaseline
                    ? `<span class="tiny">chưa có bản duyệt</span>`
                    : v.diff.changed
                      ? `<span class="tiny bad">${v.diff.changedPixels.toLocaleString()} px đổi${v.diff.baselineHeight !== v.diff.currentHeight ? ` · cao ${v.diff.baselineHeight}→${v.diff.currentHeight}` : ''}${v.diff.diffRel ? ` · <a href="${esc(v.diff.diffRel)}" target="_blank">ảnh diff</a>` : ''}</span>`
                      : `<span class="tiny ok">không đổi</span>`
                }
              </figure>`,
            )
            .join('')}
          ${p.designFile ? `<figure><figcaption>design <span class="tiny">${p.mapping.frameWidth ?? ''}px</span></figcaption><a href="${esc(p.designFile)}" target="_blank"><img src="${esc(p.designFile)}" alt="" loading="lazy"></a></figure>` : ''}
        </div>
      </div>
    </details>`;
  };

  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA Visual — ${esc(host)}</title>
<style>
/* Light by default, dark when the reader's system says so — a report gets opened at night too. */
:root{
  --bg:#f7f8fa; --card:#fff; --ink:#15181d; --mute:#697280; --faint:#9aa3af;
  --line:#e4e7ec; --line2:#eef0f4;
  --bad:#b42318; --bad-bg:#fef3f2; --bad-line:#f6cfca;
  --warn:#b45309; --warn-bg:#fffaeb; --warn-line:#fedf89;
  --ok:#067647; --ok-bg:#ecfdf3;
  --tpl:#6941c6; --link:#1f6feb;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0f1216; --card:#171b21; --ink:#e6e9ee; --mute:#98a2b3; --faint:#6b7480;
    --line:#252a32; --line2:#1e232a;
    --bad:#fda29b; --bad-bg:#2a1614; --bad-line:#5a2521;
    --warn:#fec84b; --warn-bg:#2a2014; --warn-line:#5a4321;
    --ok:#6ce9a6; --ok-bg:#0f2a1d;
    --tpl:#c3b5fd; --link:#84b6ff;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif}
a{color:var(--link)}
main{max-width:940px;margin:0 auto;padding:0 20px 80px}

/* ---------------------------------- head --------------------------------- */
header{padding:34px 20px 0;max-width:940px;margin:0 auto}
.brand{font-size:12px;letter-spacing:.10em;text-transform:uppercase;color:var(--faint);font-weight:600}
h1{font-size:30px;line-height:1.2;margin:14px 0 2px;letter-spacing:-.02em}
h1.ok{color:var(--ok)} h1.warn{color:var(--warn)} h1.bad{color:var(--bad)}
.verdict-sub{color:var(--mute);font-size:15px}
.runmeta{color:var(--faint);font-size:13px;margin:16px 0 0;padding-bottom:22px;border-bottom:1px solid var(--line)}
.runmeta b{color:var(--mute);font-weight:600}

/* -------------------------------- sections ------------------------------- */
section{margin:34px 0 0}
h2{font-size:17px;margin:0 0 4px;letter-spacing:-.01em}
h2+.lead{color:var(--mute);font-size:13.5px;margin:0 0 14px}
h2:not(:has(+.lead)){margin-bottom:14px}

.card{background:var(--card);border:1px solid var(--line);border-radius:12px}
.pad{padding:16px 18px}

/* --------------------------------- banners ------------------------------- */
.alert,.fatal{border-radius:10px;padding:12px 14px;font-size:13.5px;margin:0 0 12px}
.alert{background:var(--warn-bg);border:1px solid var(--warn-line);color:var(--warn)}
.fatal{background:var(--bad-bg);border:1px solid var(--bad-line);color:var(--bad)}
.alert b,.fatal b{color:inherit}
.alert ul,.fatal ul{margin:6px 0 0;padding-left:20px}

/* ---------------------------------- chips -------------------------------- */
.chip{display:inline-block;font-size:11.5px;line-height:18px;padding:0 8px;border-radius:999px;
  border:1px solid var(--line);color:var(--mute);white-space:nowrap;background:var(--card)}
.chip.major{border-color:var(--bad);color:var(--bad)}
.chip.minor{border-color:var(--warn);color:var(--warn)}
.chip.tpl{border-color:var(--tpl);color:var(--tpl);font-weight:600}
.chip.new{background:var(--ok-bg);border-color:transparent;color:var(--ok);font-weight:600}
/* Proved by measurement. Deliberately plain: it is a fact about the finding, not a severity. */
.chip.meas{border-color:var(--ok);color:var(--ok);font-weight:600}
/* Written by a person, so it must not look like one more generated panel. */
.humannote{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--ok);
  border-radius:12px;padding:16px 18px;font-size:14.5px;line-height:1.65;white-space:pre-wrap}
.chip.quiet{border-style:dashed;color:var(--faint)}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px}

/* ---------------------------------- table -------------------------------- */
.tablewrap{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow-x:auto}
table.grid{width:100%;min-width:660px;border-collapse:collapse;font-size:13.5px}
table.grid th{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line);
  font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);font-weight:600;vertical-align:bottom}
table.grid td{padding:11px 12px;border-bottom:1px solid var(--line2);vertical-align:middle}
table.grid tr:last-child td{border-bottom:0}
table.grid th.c,table.grid td.c{text-align:center}
table.grid td.yes{color:var(--bad);font-size:16px;line-height:1}
table.grid td.no{color:var(--line);font-size:16px;line-height:1}
table.grid td.tnum{color:var(--mute);font-variant-numeric:tabular-nums;font-size:12.5px}
table.grid td a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line)}
table.grid td a:hover{color:var(--link);border-bottom-color:var(--link)}
.note{font-size:12px;color:var(--faint);margin:0;padding:10px 12px;border-top:1px solid var(--line2)}

/* --------------------------------- findings ------------------------------ */
.find{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:0 0 12px;
  overflow:hidden;display:grid;grid-template-columns:1fr;box-shadow:0 1px 2px rgba(16,24,40,.04)}
@media (min-width:760px){ .find:has(.shot.pic){grid-template-columns:1fr 300px} }
.find{border-left:3px solid var(--line)}
.find.major{border-left-color:var(--bad)}
.find.minor{border-left-color:var(--warn)}
.fbody{padding:16px 18px;min-width:0}
.fhead{display:flex;gap:10px;align-items:baseline;margin:0 0 9px}
.fhead h3{font-size:16px;margin:0;line-height:1.35;letter-spacing:-.01em}
.num{flex:0 0 auto;font-size:11px;font-weight:700;color:var(--faint);
  font-variant-numeric:tabular-nums;line-height:22px}
.find p{margin:0 0 8px;font-size:14px;color:var(--ink)}
.find p.where{margin:0;font-size:12.5px;color:var(--mute)}
.shot{position:relative;display:flex;align-items:center;justify-content:center;padding:12px;
  border-left:1px solid var(--line2);background:var(--bg);max-height:280px;overflow:hidden}
.shot img{max-width:100%;max-height:256px;width:auto;display:block;border-radius:6px}
.shot .zoom{position:absolute;bottom:8px;right:8px;background:rgba(0,0,0,.66);color:#fff;
  font-size:11px;padding:3px 8px;border-radius:999px;opacity:0;transition:opacity .15s}
.shot:hover .zoom{opacity:1}
.find p.noloc{font-size:12.5px;color:var(--faint);margin:0 0 8px}
/* Signed off as intended: still legible, but visibly not part of the count. */
.find.ok2{opacity:.72}
.find p.accepted{font-size:13px;color:var(--ok);margin:0 0 8px}
.find p.acceptcmd{font-size:12px;color:var(--faint);margin:0 0 8px}
.acceptbox{margin:0 0 10px}
.acceptbox textarea.why{width:100%;box-sizing:border-box;font:13px/1.45 inherit;padding:8px 10px;
  border:1px solid var(--line);border-radius:8px;resize:vertical;min-height:52px;background:var(--card);color:inherit}
.acceptbox .acceptrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}
.acceptbox button{font:12.5px/1 inherit;font-weight:600;padding:6px 10px;border-radius:7px;cursor:pointer;
  border:1px solid var(--line);background:var(--card);color:inherit}
.acceptbox button[data-act=save]{background:var(--ok);border-color:var(--ok);color:#fff}
.acceptbox .acceptstate{font-size:12px;color:var(--mute)}
.acceptbox .acceptstate.bad{color:var(--bad)}

/* ---------------------------------- pages -------------------------------- */
.page{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:0 0 8px}
.page>summary{padding:13px 16px;cursor:pointer;display:flex;gap:10px;align-items:center;
  flex-wrap:wrap;list-style:none}
.page>summary::-webkit-details-marker{display:none}
.page>summary::before{content:'▸';color:var(--faint);font-size:11px;flex:0 0 auto}
.page[open]>summary::before{content:'▾'}
.page[open]>summary{border-bottom:1px solid var(--line2)}
.page .grow{flex:1}
.pbody{padding:14px 16px 16px}
.pbody .find{box-shadow:none}
.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-top:12px}
.shots figure{margin:0;min-width:0}
.shots figcaption{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);
  font-weight:600;margin:0 0 6px}
.shots a{display:block;max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}
.shots img{width:100%;display:block}
.shots .tiny{display:block;margin-top:5px}

/* --------------------------------- details ------------------------------- */
details.tech{margin-top:34px;border-top:1px solid var(--line);padding-top:18px}
details.tech>summary{cursor:pointer;font-size:14px;font-weight:600;color:var(--mute);list-style:none}
details.tech>summary::-webkit-details-marker{display:none}
details.tech>summary::before{content:'▸ ';color:var(--faint)}
details.tech[open]>summary::before{content:'▾ '}
details.tech h3{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);margin:22px 0 8px}

/* ----------------------------------- bits -------------------------------- */
.tiny{font-size:12px;color:var(--mute)}
.bad{color:var(--bad)} .ok{color:var(--ok)} .warn{color:var(--warn)}
.mono{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);
  border:1px solid var(--line2);padding:1px 5px;border-radius:5px;color:var(--mute)}
ul.plain{margin:8px 0;padding-left:20px;font-size:13px}
ul.plain li{margin:3px 0}
table.plain{width:100%;border-collapse:collapse;font-size:13px}
table.plain th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;
  color:var(--faint);padding:8px 10px;border-bottom:1px solid var(--line)}
table.plain td{padding:8px 10px;border-bottom:1px solid var(--line2);vertical-align:top}
table.plain tr:last-child td{border-bottom:0}
.empty{color:var(--mute);font-size:13.5px}
footer{max-width:940px;margin:0 auto;padding:22px 20px 50px;border-top:1px solid var(--line);
  color:var(--faint);font-size:12px}

@media print{
  body{background:#fff}
  .find,.page,.card,.tablewrap{break-inside:avoid;box-shadow:none}
  details.tech,.page{display:none}
  .shot{max-height:none}
}
</style></head><body>
<header>
  <div class="brand">QA Visual · ${esc(host)}</div>
  <h1 class="${verdict.tone}">${esc(verdict.line)}</h1>
  <div class="verdict-sub">${esc(verdict.sub)}</div>
  <p class="runmeta">
    <b>${esc(r.when.slice(0, 16).replace('T', ' '))}</b> · ${r.pages.length} trang${
      r.coverage && r.coverage.seen > r.coverage.ran ? ` / ${r.coverage.seen} URL đã QA` : ''
    } · 3 kích thước · ${(r.durationMs / 1000).toFixed(0)}s
    · ${r.aiModel ? 'AI ' + esc(r.aiModel) : 'AI tắt'}${r.authHow ? ' · ' + esc(r.authHow) : ''}${r.approvedThisRun ? ' · <b>đã chốt làm bản duyệt</b>' : ''}
  </p>
</header>
<main>

${
  r.coverage && r.coverage.seen > r.coverage.ran
    ? `<div class="alert"><b>Chỉ kiểm ${r.coverage.ran} trang lần này.</b> Site này đã từng QA ${r.coverage.seen} URL qua các lần chạy. Trang không nằm trong đợt này không được soi — đừng đọc là sạch.</div>`
    : ''
}
${
  r.ai && r.ai.failures
    ? `<div class="fatal"><b>⚠ Báo cáo chưa đầy đủ.</b> ${r.ai.failures}/${r.ai.calls} lời gọi AI thất bại, nên những vùng đó <b>chưa được kiểm</b> — danh sách dưới đây thiếu, không phải site sạch.
       <div class="tiny" style="margin-top:6px;color:inherit;opacity:.85">${r.ai.stopped ? esc(r.ai.stopped) : esc(r.ai.lastError ?? '')}</div></div>`
    : ''
}
${
  r.ai?.silent
    ? `<div class="fatal"><b>⚠ Model không trả về kết quả nào.</b> ${r.ai.calls}/${r.ai.calls} lời gọi AI <b>thành công</b> (không có lỗi mạng, không hết quota) nhưng model không nêu một lỗi nào ở bất kỳ lượt nào.
       <div class="tiny" style="margin-top:6px;color:inherit;opacity:.85">Gọi được ≠ trả lời được. Rất có thể model đang dùng quá yếu cho việc so ảnh — đổi <code>QA_AI_MODEL</code> rồi chạy lại (<code>npm run models</code>). Đừng đọc báo cáo này là "site sạch".</div></div>`
    : ''
}
${
  r.ai?.wrongLang
    ? `<div class="alert"><b>Model trả lời sai ngôn ngữ.</b> ${r.ai.wrongLang} nhận xét không phải tiếng Việt — model đang bỏ qua yêu cầu trong prompt. Nội dung lỗi vẫn dùng được, nhưng nên đổi <code>QA_AI_MODEL</code> sang model khoẻ hơn (<code>npm run models</code>).</div>`
    : ''
}
${
  mispaired.length
    ? `<div class="alert"><b>Có thể ghép sai design</b> ở ${mispaired.length} trang: ${mispaired.map((p) => `<code>${esc(path(p.url))}</code>`).join(' ')}. Kiểm tra lại bảng ghép trước khi tin các lỗi của những trang này.</div>`
    : ''
}
${
  r.drift && r.drift.gone.length
    ? `<div class="alert"><b>Lần chạy trước báo, lần này không thấy</b> — cần bạn xác nhận đã sửa hay AI bỏ sót:
       <ul>${r.drift.gone.map((g) => `<li>${esc(g.title)} <span class="tiny" style="color:inherit;opacity:.8">(${esc(SEV[g.severity] ?? g.severity)}${g.scope === 'template' ? ', dùng chung' : ''})</span></li>`).join('')}</ul></div>`
    : ''
}

${
  r.humanNotes && r.humanNotes.trim()
    ? `<section>
  <h2>Ghi chú của người kiểm</h2>
  <p class="lead">Do người viết tay sau khi đọc báo cáo — những gì AI bỏ sót, hoặc lưu ý cho người đọc.${
    r.humanNotesAt ? ` Ghi lúc ${esc(r.humanNotesAt.slice(0, 16).replace('T', ' '))}.` : ''
  }</p>
  <div class="humannote">${esc(r.humanNotes.trim())}</div>
</section>`
    : ''
}

${
  open.length
    ? `<section>
  <h2>Danh sách lỗi</h2>
  <p class="lead">Bấm tên lỗi để xem ảnh khoanh vùng.${
    r.drift ? ` So với lần chạy trước: ${open.filter((f) => f.isNew).length} mới · ${open.filter((f) => f.isNew === false).length} vẫn còn.` : ''
  }${r.rawFindingCount > open.length ? ` Đã gộp ${r.rawFindingCount} nhận xét thô thành ${open.length} lỗi.` : ''}</p>
  ${indexTable()}
</section>`
    : ''
}

${
  template.length
    ? `<section>
  <h2>Lỗi ở component dùng chung</h2>
  <p class="lead">Header / nav / footer — sửa một lần là hết ở mọi trang. Đây là chỗ đáng sửa trước.</p>
  ${template.map(findingBlock).join('')}
</section>`
    : ''
}

${
  accepted.length
    ? `<section>
  <h2>Đã duyệt là cố ý (${accepted.length})</h2>
  <p class="lead">Người xem đã xác nhận những chỗ này là false positive hoặc chủ ý, nên không tính vào số lỗi. Sửa lý do hoặc bỏ xác nhận ngay trên thẻ — lần chạy sau cũng không tính lại.</p>
  ${accepted.map(findingBlock).join('')}
</section>`
    : ''
}

${
  perPage.length
    ? `<section>
  <h2>Lỗi riêng từng trang</h2>
  <p class="lead">Mở từng trang để xem lỗi kèm ảnh chụp cả 3 kích thước.</p>
  ${r.pages.map(pageRow).join('')}
</section>`
    : `<section>
  <h2>Từng trang</h2>
  <p class="lead">Không có lỗi riêng của trang nào. Mở ra nếu muốn xem ảnh chụp.</p>
  ${r.pages.map(pageRow).join('')}
</section>`
}

${
  r.sweeps.some((s) => s.breaks.length)
    ? `<section>
  <h2>Layout tràn ngang</h2>
  <p class="lead">Dải chiều rộng mà trang rộng hơn màn hình — cần thêm media query.</p>
  <div class="card pad">${r.sweeps
    .filter((s) => s.breaks.length)
    .map(
      (s) =>
        `<code>${esc(path(s.url))}</code><ul class="plain">${s.breaks
          .map((b) => `<li>Từ <b>${b.from}px</b> xuống <b>${b.to}px</b>: rộng hơn màn hình tới ${b.overflowPx}px — cần media query quanh ${b.from}px.</li>`)
          .join('')}</ul>`,
    )
    .join('')}<p class="tiny" style="margin:0">Chỉ quét ở trang chủ — điểm vỡ layout là chuyện của template.</p></div>
</section>`
    : ''
}

<details class="tech">
  <summary>Chi tiết kỹ thuật</summary>

  <h3>Bảng ghép URL ↔ design</h3>
  <div class="card" style="overflow-x:auto">
    <table class="plain">
      <thead><tr><th>Trang</th><th>Frame Figma</th><th>Cách ghép</th></tr></thead>
      <tbody>${r.pages
        .map(
          (p) => `<tr>
        <td><a href="${esc(p.url)}" target="_blank">${esc(path(p.url))}</a></td>
        <td>${p.mapping.frameName ? esc(p.mapping.frameName) + (p.mapping.isTemplate ? ' <span class="chip">template</span>' : '') : '<span class="warn">chưa ghép</span>'}</td>
        <td class="tiny">${esc(p.mapping.how)}</td>
      </tr>`,
        )
        .join('')}</tbody>
    </table>
  </div>
  ${unmapped.length ? `<p class="tiny warn">${unmapped.length} trang chưa có design — vẫn so với bản duyệt, quét sweep và kiểm ảnh lỗi, nhưng không đối chiếu design.</p>` : ''}

  <h3>Số liệu lần chạy</h3>
  <div class="card pad">
    <table class="plain">
      <tbody>
        <tr><td>Lỗi nặng</td><td class="${majors ? 'bad' : 'ok'}">${majors}</td></tr>
        <tr><td>Lỗi ở component dùng chung</td><td>${template.length}</td></tr>
        <tr><td>Lỗi riêng từng trang</td><td>${perPage.length}</td></tr>
        <tr><td>Trang khác bản duyệt</td><td class="${changedPages.length ? 'bad' : 'ok'}">${changedPages.length}/${r.pages.length}</td></tr>
        <tr><td>Ảnh / nền không load</td><td class="${brokenAssets.size ? 'bad' : 'ok'}">${brokenAssets.size}</td></tr>
        <tr><td>Script / CSS / font lỗi</td><td class="${criticalReq.length ? 'bad' : 'ok'}">${criticalReq.length}</td></tr>
        <tr><td>Nhận xét thô từ AI</td><td>${r.rawFindingCount}</td></tr>
        <tr><td>Chuỗi chữ nhận là component dùng chung</td><td>${r.sharedTextCount}</td></tr>
        ${r.ai ? `<tr><td>Lời gọi AI</td><td>${r.ai.calls - r.ai.failures}/${r.ai.calls} thành công</td></tr>` : ''}
        ${r.coverage && r.coverage.seen > r.coverage.ran ? `<tr><td>Đợt này / URL đã từng QA</td><td>${r.coverage.ran}/${r.coverage.seen}</td></tr>` : ''}
        ${r.drift ? `<tr><td>Đối chiếu với lần chạy</td><td class="mono">${esc(r.drift.previousRun)}</td></tr>` : ''}
      </tbody>
    </table>
  </div>

  ${
    criticalReq.length
      ? `<h3>Request lỗi</h3><div class="card pad"><ul class="plain">${criticalReq.slice(0, 20).map((f) => `<li class="bad mono">${esc(f)}</li>`).join('')}</ul></div>`
      : ''
  }
</details>

</main>
<footer>
  Vùng video/iframe/canvas hiện trắng trong ảnh chụp nên được tự loại khỏi so sánh.
  Vùng lỗi được khoanh bằng cách tra chữ AI trích dẫn vào DOM, không dùng toạ độ AI đoán.
  Chạy lại với <code>--approve</code> để chốt bản duyệt mới.
</footer>
${ACCEPT_SCRIPT}
</body></html>`;
}
