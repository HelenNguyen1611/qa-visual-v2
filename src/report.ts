import type { DiffResult } from './compare.js';
import type { SweepResult } from './sweep.js';
import type { MediaRegion, TextItem, ReservedRegion } from './browser.js';
import type { GroupedFinding } from './group.js';
import { formatQaWhen } from './time.js';

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
 * Editors talk to the local tool. Stamp is baked into the HTML so opening the file from Finder
 * still knows which run this is; the script then posts to 127.0.0.1 if the page is not already
 * served from there. A share file hides the editors — the recipient should not rewrite judgement.
 */
const ACCEPT_SCRIPT = [
  '<script>',
  '(function () {',
  "  var stamp = document.documentElement.getAttribute('data-stamp') || ((location.pathname.match(/\\/reports\\/([^/]+)\\//) || [])[1] || '');",
  "  var local = (location.protocol === 'http:' || location.protocol === 'https:') && (location.hostname === '127.0.0.1' || location.hostname === 'localhost');",
  "  var api = local ? '' : 'http://127.0.0.1:5173';",
  '  function post(path, body) {',
  "    return fetch(api + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })",
  '      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, d: d }; }); });',
  '  }',
  "  if (/share/i.test(location.pathname)) {",
  "    document.querySelectorAll('.acceptedit, .notesedit').forEach(function (e) { e.hidden = true; });",
  '    return;',
  '  }',
  "  document.querySelectorAll('.acceptbox').forEach(function (box) {",
  "    box.addEventListener('click', function (ev) {",
  "      var btn = ev.target.closest && ev.target.closest('[data-act]');",
  '      if (!btn || !box.contains(btn)) return;',
  "      var act = btn.getAttribute('data-act');",
  "      var ta = box.querySelector('textarea.why');",
  "      var st = box.querySelector('.acceptstate');",
  "      var why = ta ? ta.value : '';",
  "      var accepted = act !== 'undo';",
  "      if (!stamp) { if (st) { st.className = 'acceptstate bad'; st.textContent = 'open the report from QA Visual (localhost) to save'; } return; }",
  "      if (accepted && !why.trim()) {",
  "        if (st) { st.className = 'acceptstate bad'; st.textContent = 'a reason is required — will not save silently'; }",
  '        return;',
  '      }',
  '      btn.disabled = true;',
  "      if (st) { st.className = 'acceptstate'; st.textContent = 'Saving…'; }",
  "      post('/api/findings/accept', { stamp: stamp, num: Number(box.getAttribute('data-num')), why: why, accepted: accepted })",
  '        .then(function (x) {',
  "          if (!x.ok) throw new Error(x.d.error || 'could not save');",
  '          location.reload();',
  '        })',
  '        .catch(function (e) {',
  '          btn.disabled = false;',
  "          if (st) { st.className = 'acceptstate bad'; st.textContent = (e.message || String(e)) + ' — open QA Visual.command and reload this page.'; }",
  '        });',
  '    });',
  '  });',
  "  var notes = document.querySelector('.notesbox');",
  '  if (notes) {',
  "    var nbtn = notes.querySelector('[data-act=savenote]');",
  "    var nta = notes.querySelector('textarea.notes');",
  "    var nst = notes.querySelector('.acceptstate');",
    "    if (nbtn) nbtn.addEventListener('click', function () {",
  "      if (!stamp) { if (nst) { nst.className = 'acceptstate bad'; nst.textContent = 'open the report from QA Visual (localhost) to save'; } return; }",
  '      nbtn.disabled = true;',
  "      if (nst) { nst.className = 'acceptstate'; nst.textContent = 'Saving…'; }",
  "      post('/api/notes', { stamp: stamp, notes: nta ? nta.value : '' })",
  '        .then(function (x) {',
  "          if (!x.ok) throw new Error(x.d.error || 'could not save');",
  '          location.reload();',
  '        })',
  '        .catch(function (e) {',
  '          nbtn.disabled = false;',
  "          if (nst) { nst.className = 'acceptstate bad'; nst.textContent = (e.message || String(e)) + ' — open QA Visual.command and reload this page.'; }",
  '        });',
  '    });',
  '  }',
  '})();',
  '</script>',
].join('\n');

export function renderReport(r: RunReport, stamp?: string): string {
  const host = (() => {
    try {
      return new URL(r.site).host;
    } catch {
      return r.site;
    }
  })();

  // Accepted findings stay in the report but never in a count — a suppression you cannot see is
  // one nobody re-examines when the page changes underneath it.
  const findings = r.findings ?? [];
  const open = findings.filter((f) => !f.accepted);
  const accepted = findings.filter((f) => f.accepted);
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
  const SEV = { major: 'major', minor: 'minor', note: 'note' } as Record<string, string>;
  const VP_COLS = ['mobile', 'tablet', 'desktop'] as const;
  const VP_W = { mobile: 390, tablet: 768, desktop: 1440 } as const;

  /**
   * The one sentence somebody reads before deciding whether to keep reading.
   *
   * A run whose model calls mostly failed must not open with "no problems found" — that reads as
   * good news and it is the opposite. Coverage is stated before any count.
   */
  const verdict = (() => {
    if (r.ai?.failures && r.ai.failures >= r.ai.calls) return { tone: 'bad', line: 'Could not review', sub: 'Every AI call failed — there is no conclusion about the site.' };
    if (!open.length && r.ai?.silent)
      return {
        tone: 'warn',
        line: 'No results — the model may be too weak',
        sub: `${r.ai.calls}/${r.ai.calls} AI calls succeeded but the model reported no findings. That is not a “clean site” verdict.`,
      };
    // Zero findings right after a run that found several, with no errors, is a red flag not a pass.
    if (!open.length && (r.drift?.gone.length ?? 0) >= 3)
      return {
        tone: 'warn',
        line: 'No findings — suspicious',
        sub: `The previous run reported ${r.drift!.gone.length} findings on this same site. Check the list below before treating them as all fixed.`,
      };
    if (!open.length) return { tone: 'ok', line: 'No findings', sub: `Compared ${r.pages.length} pages at 3 viewports.` };
    const parts = [`${open.length} findings`];
    if (template.length) parts.push(`${template.length} on shared components`);
    if (majors) parts.push(`${majors} major`);
    return { tone: majors ? 'bad' : 'warn', line: parts[0], sub: parts.slice(1).join(' · ') || `Across ${r.pages.length} pages.` };
  })();

  /** Index of findings — the fast scan, with a column per screen size. Cards below are the detail. */
  const indexTable = () =>
    !open.length
      ? ''
      : `<div class="tablewrap">
  <table class="grid">
    <thead><tr>
      <th class="c">#</th><th>Finding</th><th>Severity</th><th>Scope</th>
      ${VP_COLS.map((v) => `<th class="c">${v[0].toUpperCase() + v.slice(1)}<br><span class="tiny">${VP_W[v]}px</span></th>`).join('')}
      <th class="c">Pages</th>
    </tr></thead>
    <tbody>${open
      .map(
        (f) => `<tr>
        <td class="c tnum">${f.num}</td>
        <td><a href="#f${f.num}">${esc(f.title)}</a>${f.isNew === true ? ' <span class="chip new">new</span>' : ''}${
          f.measured ? ' <span class="chip meas">measured</span>' : ''
        }</td>
        <td><span class="chip ${f.severity}">${SEV[f.severity]}</span></td>
        <td>${f.scope === 'template' ? '<span class="chip tpl">shared</span>' : '<span class="tiny">page-only</span>'}</td>
        ${VP_COLS.map((v) => `<td class="c ${f.viewports.includes(v) ? 'yes' : 'no'}">${f.viewports.includes(v) ? '●' : '·'}</td>`).join('')}
        <td class="c tnum">${f.pages.length}/${r.pages.length}</td>
      </tr>`,
      )
      .join('')}</tbody>
  </table>
  <p class="note">● = reported at that viewport. An empty cell means it was <b>not reported</b> there — not that it is absent.
  <b>measured</b> = the tool measured it on the DOM (overlapping boxes, type scale, empty space), so it does not depend on the model; no label means an AI comment.</p>
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
            ? `<p class="accepted"><b>Dismissed — false positive / intentional.</b> ${esc(f.acceptedWhy ?? '')}</p>`
            : `<p class="acceptlab">Human check</p>`
        }
        <div class="acceptedit">
          <label class="accepthint">${f.accepted ? 'Edit the reason, or undo if this is still a defect.' : 'If this is not a defect: write a reason and click Dismiss. Leave empty if it is a real issue.'}</label>
          <textarea class="why" rows="2" placeholder="Reason / note, e.g. empty space is the right-column form, not a bug.">${f.accepted ? esc(f.acceptedWhy ?? '') : ''}</textarea>
          <div class="acceptrow">
            <button type="button" data-act="save">${f.accepted ? 'Update reason' : 'Dismiss this finding'}</button>
            ${f.accepted ? `<button type="button" data-act="undo">Undo dismiss</button>` : ''}
            <span class="acceptstate"></span>
          </div>
        </div>
      </div>
      <div class="chips">
        <span class="chip ${f.severity}">${SEV[f.severity]}</span>
        ${f.measured ? `<span class="chip meas" title="${esc(f.locatedHow ?? '')}">measured</span>` : `<span class="chip quiet">AI comment</span>`}
        ${f.scope === 'template' ? `<span class="chip tpl">shared component</span>` : ''}
        ${f.viewports.map((v) => `<span class="chip">${v}</span>`).join('')}
        ${f.isNew === true ? `<span class="chip new">new</span>` : f.isNew === false ? `<span class="chip">still present</span>` : ''}
        ${f.merged > 1 ? `<span class="chip quiet">merged from ${f.merged} comments</span>` : ''}
      </div>
      <p>${esc(f.detail)}</p>
      ${
        !f.crop && f.anchors?.length
          ? `<p class="noloc">Could not crop a region — AI quoted: <code>${esc(f.anchors.slice(0, 2).join('</code> <code>'))}</code></p>`
          : ''
      }
      <p class="where">${
        f.scope === 'template'
          ? `On <b>${f.pages.length}/${r.pages.length} pages</b> — fix once and it is gone everywhere: ${f.pages.map((p) => `<code>${esc(path(p))}</code>`).join(' ')}`
          : `Pages: ${f.pages.map((p) => `<code>${esc(path(p))}</code>`).join(' ')}`
      }</p>
    </div>
    ${
      f.crop
        ? `<a class="shot pic" href="${esc(f.crop)}" target="_blank"><img src="${esc(f.crop)}" alt="finding ${f.num}" loading="lazy"><span class="zoom">Click to enlarge</span></a>`
        : ''
    }
  </article>`;

  const pageRow = (p: PageReport) => {
    const mine = perPage.filter((f) => f.pages.includes(p.url));
    const changed = p.viewports.filter((v) => v.diff.changed);
    const assets = p.viewports[0] ? [...p.viewports[0].brokenImages, ...p.viewports[0].failedBackgrounds] : [];
    const flags = [
      mine.length ? `${mine.length} page-only findings` : '',
      changed.length ? `${changed.length} viewports differ from baseline` : '',
      p.mispaired ? 'possible design mismatch' : '',
      p.aiError ? 'AI error' : '',
    ].filter(Boolean);
    return `
    <details class="page"${mine.length || p.mispaired ? ' open' : ''}>
      <summary>
        <code>${esc(path(p.url))}</code>
        <span class="tiny">${p.mapping.frameName ? '↔ ' + esc(p.mapping.frameName) : 'no design paired'}</span>
        <span class="grow"></span>
        ${flags.length ? `<span class="tiny ${mine.length || p.mispaired ? 'bad' : ''}">${flags.join(' · ')}</span>` : '<span class="tiny ok">ok</span>'}
      </summary>
      <div class="pbody">
        ${p.mispaired ? `<div class="alert"><b>This page may be paired with the wrong design</b> — unusually many “missing element / wrong order” comments. Recheck the pairing table before trusting the findings below.</div>` : ''}
        ${p.aiError ? `<div class="alert">AI error on this page: ${esc(p.aiError)}</div>` : ''}
        ${mine.map(findingBlock).join('')}
        ${assets.length ? `<ul class="plain">${assets.map((m: any) => `<li class="bad">${m.why ? `CSS background failed (${esc(m.why)})` : 'Image failed to load'}: <span class="mono">${esc(m.src)}</span></li>`).join('')}</ul>` : ''}
        <div class="shots">
          ${p.viewports
            .map(
              (v) => `<figure>
                <figcaption>${v.name} <span class="tiny">${v.width}px · ${v.pageHeight}px tall</span></figcaption>
                <a href="${esc(v.shot)}" target="_blank"><img src="${esc(v.shot)}" alt="" loading="lazy"></a>
                ${
                  v.diff.noBaseline
                    ? `<span class="tiny">no baseline yet</span>`
                    : v.diff.changed
                      ? `<span class="tiny bad">${v.diff.changedPixels.toLocaleString()} px changed${v.diff.baselineHeight !== v.diff.currentHeight ? ` · height ${v.diff.baselineHeight}→${v.diff.currentHeight}` : ''}${v.diff.diffRel ? ` · <a href="${esc(v.diff.diffRel)}" target="_blank">diff image</a>` : ''}</span>`
                      : `<span class="tiny ok">unchanged</span>`
                }
              </figure>`,
            )
            .join('')}
          ${p.designFile ? `<figure><figcaption>design <span class="tiny">${p.mapping.frameWidth ?? ''}px</span></figcaption><a href="${esc(p.designFile)}" target="_blank"><img src="${esc(p.designFile)}" alt="" loading="lazy"></a></figure>` : ''}
        </div>
      </div>
    </details>`;
  };

  return `<!doctype html><html lang="en"${stamp ? ` data-stamp="${esc(stamp)}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
.acceptbox{margin:0 0 12px;padding:10px 12px;border:1px solid var(--warn-line);background:var(--warn-bg);border-radius:10px}
.acceptbox .acceptlab{font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--warn);margin:0 0 6px}
.acceptbox .accepthint{display:block;font-size:12.5px;color:var(--ink);margin:0 0 6px}
.acceptbox textarea.why,.notesbox textarea.notes{width:100%;box-sizing:border-box;font:13px/1.45 inherit;padding:8px 10px;
  border:1px solid var(--line);border-radius:8px;resize:vertical;min-height:56px;background:var(--card);color:inherit}
.acceptbox .acceptrow,.notesbox .acceptrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}
.acceptbox button,.notesbox button{font:12.5px/1 inherit;font-weight:600;padding:7px 12px;border-radius:7px;cursor:pointer;
  border:1px solid var(--line);background:var(--card);color:inherit}
.acceptbox button[data-act=save],.notesbox button[data-act=savenote]{background:var(--ok);border-color:var(--ok);color:#fff}
.acceptbox .acceptstate,.notesbox .acceptstate{font-size:12px;color:var(--mute)}
.acceptbox .acceptstate.bad,.notesbox .acceptstate.bad{color:var(--bad)}
.notesbox{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--ok);
  border-radius:12px;padding:16px 18px;margin:0 0 22px}

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
    <b>${esc(formatQaWhen(r.when))}</b> · ${r.pages.length} pages${
      r.coverage && r.coverage.seen > r.coverage.ran ? ` / ${r.coverage.seen} URLs already QA’d` : ''
    } · 3 viewports · ${(r.durationMs / 1000).toFixed(0)}s
    · ${r.aiModel ? 'AI ' + esc(r.aiModel) : 'AI off'}${r.authHow ? ' · ' + esc(r.authHow) : ''}${r.approvedThisRun ? ' · <b>saved as baseline</b>' : ''}
  </p>
</header>
<main>

${
  r.coverage && r.coverage.seen > r.coverage.ran
    ? `<div class="alert"><b>Only ${r.coverage.ran} pages in this run.</b> This site has been QA’d on ${r.coverage.seen} URLs across runs. Pages not in this batch were not inspected — do not read that as clean.</div>`
    : ''
}
${
  r.ai && r.ai.failures
    ? `<div class="fatal"><b>⚠ Report is incomplete.</b> ${r.ai.failures}/${r.ai.calls} AI calls failed, so those regions were <b>not reviewed</b> — the list below is missing items, not a clean site.
       <div class="tiny" style="margin-top:6px;color:inherit;opacity:.85">${r.ai.stopped ? esc(r.ai.stopped) : esc(r.ai.lastError ?? '')}</div></div>`
    : ''
}
${
  r.ai?.silent
    ? `<div class="fatal"><b>⚠ The model returned no findings.</b> ${r.ai.calls}/${r.ai.calls} AI calls <b>succeeded</b> (no network error, no quota) but the model reported nothing on any pass.
       <div class="tiny" style="margin-top:6px;color:inherit;opacity:.85">A successful call is not a useful answer. The model is likely too weak for image compare — change <code>QA_AI_MODEL</code> and run again (<code>npm run models</code>). Do not read this report as a clean site.</div></div>`
    : ''
}
${
  r.ai?.wrongLang
    ? `<div class="alert"><b>The model answered in the wrong language.</b> ${r.ai.wrongLang} comments are not in English — the model ignored the prompt. The findings are still usable, but switch <code>QA_AI_MODEL</code> to a stronger model (<code>npm run models</code>).</div>`
    : ''
}
${
  mispaired.length
    ? `<div class="alert"><b>Possible design mismatch</b> on ${mispaired.length} pages: ${mispaired.map((p) => `<code>${esc(path(p.url))}</code>`).join(' ')}. Recheck the pairing table before trusting those findings.</div>`
    : ''
}
${
  r.drift && r.drift.gone.length
    ? `<div class="alert"><b>Reported last run, missing this run</b> — confirm they were fixed, or that the AI missed them:
       <ul>${r.drift.gone.map((g) => `<li>${esc(g.title)} <span class="tiny" style="color:inherit;opacity:.8">(${esc(SEV[g.severity] ?? g.severity)}${g.scope === 'template' ? ', shared' : ''})</span></li>`).join('')}</ul></div>`
    : ''
}

<section class="notesbox">
  <h2>Reviewer notes</h2>
  <p class="lead">Things the AI missed, or notes for the next reader.${
    r.humanNotesAt ? ` Written ${esc(formatQaWhen(r.humanNotesAt))}.` : ''
  }</p>
  <div class="notesedit">
    <textarea class="notes" rows="4" placeholder="Notes for this run…">${esc(r.humanNotes ?? '')}</textarea>
    <div class="acceptrow">
      <button type="button" data-act="savenote">Save notes</button>
      <span class="acceptstate"></span>
    </div>
  </div>
</section>

${
  open.length
    ? `<section>
  <h2>Findings</h2>
  <p class="lead">Click a title to jump to the cropped screenshot.${
    r.drift ? ` vs last run: ${open.filter((f) => f.isNew).length} new · ${open.filter((f) => f.isNew === false).length} still present.` : ''
  }${r.rawFindingCount > open.length ? ` Merged ${r.rawFindingCount} raw comments into ${open.length} findings.` : ''}</p>
  ${indexTable()}
</section>`
    : ''
}

${
  template.length
    ? `<section>
  <h2>Shared-component findings</h2>
  <p class="lead">Header / nav / footer — fix once and it is gone on every page. Start here.</p>
  ${template.map(findingBlock).join('')}
</section>`
    : ''
}

${
  accepted.length
    ? `<section>
  <h2>Dismissed as intentional (${accepted.length})</h2>
  <p class="lead">A reviewer marked these as false positives or intentional, so they do not count. Edit the reason or undo on the card — later runs will keep them dismissed.</p>
  ${accepted.map(findingBlock).join('')}
</section>`
    : ''
}

${
  perPage.length
    ? `<section>
  <h2>Page-only findings</h2>
  <p class="lead">Open a page to see its findings with all 3 viewport screenshots.</p>
  ${r.pages.map(pageRow).join('')}
</section>`
    : `<section>
  <h2>Pages</h2>
  <p class="lead">No page-only findings. Open a page to see its screenshots.</p>
  ${r.pages.map(pageRow).join('')}
</section>`
}

${
  r.sweeps.some((s) => s.breaks.length)
    ? `<section>
  <h2>Horizontal overflow</h2>
  <p class="lead">Width ranges where the page is wider than the viewport — a media query is needed.</p>
  <div class="card pad">${r.sweeps
    .filter((s) => s.breaks.length)
    .map(
      (s) =>
        `<code>${esc(path(s.url))}</code><ul class="plain">${s.breaks
          .map((b) => `<li>From <b>${b.from}px</b> down to <b>${b.to}px</b>: ${b.overflowPx}px wider than the screen — add a media query around ${b.from}px.</li>`)
          .join('')}</ul>`,
    )
    .join('')}<p class="tiny" style="margin:0">Swept on the homepage only — overflow breakpoints belong to the template.</p></div>
</section>`
    : ''
}

<details class="tech">
  <summary>Technical details</summary>

  <h3>URL ↔ design pairing</h3>
  <div class="card" style="overflow-x:auto">
    <table class="plain">
      <thead><tr><th>Page</th><th>Figma frame</th><th>How paired</th></tr></thead>
      <tbody>${r.pages
        .map(
          (p) => `<tr>
        <td><a href="${esc(p.url)}" target="_blank">${esc(path(p.url))}</a></td>
        <td>${p.mapping.frameName ? esc(p.mapping.frameName) + (p.mapping.isTemplate ? ' <span class="chip">template</span>' : '') : '<span class="warn">unpaired</span>'}</td>
        <td class="tiny">${esc(p.mapping.how)}</td>
      </tr>`,
        )
        .join('')}</tbody>
    </table>
  </div>
  ${unmapped.length ? `<p class="tiny warn">${unmapped.length} pages have no design — still compared to the baseline, swept, and checked for broken images, but not compared to design.</p>` : ''}

  <h3>Run stats</h3>
  <div class="card pad">
    <table class="plain">
      <tbody>
        <tr><td>Major findings</td><td class="${majors ? 'bad' : 'ok'}">${majors}</td></tr>
        <tr><td>Shared-component findings</td><td>${template.length}</td></tr>
        <tr><td>Page-only findings</td><td>${perPage.length}</td></tr>
        <tr><td>Pages that differ from baseline</td><td class="${changedPages.length ? 'bad' : 'ok'}">${changedPages.length}/${r.pages.length}</td></tr>
        <tr><td>Images / backgrounds that failed</td><td class="${brokenAssets.size ? 'bad' : 'ok'}">${brokenAssets.size}</td></tr>
        <tr><td>Failed script / CSS / font</td><td class="${criticalReq.length ? 'bad' : 'ok'}">${criticalReq.length}</td></tr>
        <tr><td>Raw AI comments</td><td>${r.rawFindingCount}</td></tr>
        <tr><td>Strings treated as shared chrome</td><td>${r.sharedTextCount}</td></tr>
        ${r.ai ? `<tr><td>AI calls</td><td>${r.ai.calls - r.ai.failures}/${r.ai.calls} succeeded</td></tr>` : ''}
        ${r.coverage && r.coverage.seen > r.coverage.ran ? `<tr><td>This batch / URLs previously QA’d</td><td>${r.coverage.ran}/${r.coverage.seen}</td></tr>` : ''}
        ${r.drift ? `<tr><td>Compared with run</td><td class="mono">${esc(r.drift.previousRun)}</td></tr>` : ''}
      </tbody>
    </table>
  </div>

  ${
    criticalReq.length
      ? `<h3>Failed requests</h3><div class="card pad"><ul class="plain">${criticalReq.slice(0, 20).map((f) => `<li class="bad mono">${esc(f)}</li>`).join('')}</ul></div>`
      : ''
  }
</details>

</main>
<footer>
  Video / iframe / canvas regions render white in screenshots, so they are excluded from the compare.
  Finding crops are located by looking up the AI’s quoted text in the DOM, not from guessed coordinates.
  Re-run with <code>--approve</code> to save a new baseline.
</footer>
${ACCEPT_SCRIPT}
</body></html>`;
}
