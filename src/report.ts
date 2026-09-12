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

/** Jump links + open a closed <details> when the hash points inside it. Runs on share files too. */
const TOC_SCRIPT = [
  '<script>',
  '(function () {',
  '  var nav = document.querySelector(".toc");',
  '  if (!nav) return;',
  '  function openTarget(id) {',
  '    var el = id && document.getElementById(id);',
  '    if (!el) return;',
  '    if (el.tagName === "DETAILS") el.open = true;',
  '    var wrap = el.closest && el.closest("details");',
  '    if (wrap) wrap.open = true;',
  '  }',
  '  function fromHash() { openTarget((location.hash || "").replace(/^#/, "")); }',
  '  fromHash();',
  '  window.addEventListener("hashchange", fromHash);',
  '  nav.addEventListener("click", function (ev) {',
  '    var a = ev.target.closest && ev.target.closest(\'a[href^="#"]\');',
  '    if (!a) return;',
  '    openTarget((a.getAttribute("href") || "").slice(1));',
  '  });',
  '  var map = {};',
  '  nav.querySelectorAll(\'a[href^="#"]\').forEach(function (a) {',
  '    var id = (a.getAttribute("href") || "").slice(1);',
  '    if (id && document.getElementById(id)) map[id] = a;',
  '  });',
  '  var ids = Object.keys(map);',
  '  if (!ids.length || !("IntersectionObserver" in window)) return;',
  '  var current = "";',
  '  var io = new IntersectionObserver(function (entries) {',
  '    var vis = entries.filter(function (e) { return e.isIntersecting; })',
  '      .sort(function (a, b) { return a.boundingClientRect.top - b.boundingClientRect.top; });',
  '    if (!vis.length) return;',
  '    var id = vis[0].target.id;',
  '    if (id === current) return;',
  '    current = id;',
  '    ids.forEach(function (k) { if (map[k]) map[k].toggleAttribute("aria-current", k === id); });',
  '  }, { rootMargin: "-20% 0px -60% 0px", threshold: 0 });',
  '  ids.forEach(function (id) { io.observe(document.getElementById(id)); });',
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
        <td><a href="#f${f.num}">${esc(f.title)}</a>${f.isNew === true ? ' <span class="mark">new</span>' : ''}${
          f.measured ? ' <span class="tiny">measured</span>' : ''
        }</td>
        <td class="${f.severity}">${SEV[f.severity]}</td>
        <td class="tiny">${f.scope === 'template' ? 'shared' : 'page'}</td>
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
      <p class="fmeta">${[
        SEV[f.severity],
        f.measured ? 'measured' : 'AI',
        f.scope === 'template' ? 'shared' : null,
        f.viewports.join(' · '),
        f.isNew === true ? '<span class="mark">new</span>' : f.isNew === false ? 'still present' : null,
        f.merged > 1 ? `merged ×${f.merged}` : null,
      ]
        .filter(Boolean)
        .join(' · ')}</p>
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
      <details class="acceptbox" data-num="${f.num}"${f.accepted ? ' open' : ''}>
        <summary>${f.accepted ? 'Dismissed — not counted' : 'Not a defect?'}</summary>
        ${f.accepted ? `<p class="accepted">${esc(f.acceptedWhy ?? '')}</p>` : ''}
        <div class="acceptedit">
          <label class="accepthint">${f.accepted ? 'Edit the reason, or undo if this is still a defect.' : 'Write why, then dismiss. Leave closed if it is a real issue.'}</label>
          <textarea class="why" rows="2" placeholder="e.g. empty space is the right-column form, not a bug.">${f.accepted ? esc(f.acceptedWhy ?? '') : ''}</textarea>
          <div class="acceptrow">
            <button type="button" data-act="save">${f.accepted ? 'Update reason' : 'Dismiss'}</button>
            ${f.accepted ? `<button type="button" data-act="undo">Undo</button>` : ''}
            <span class="acceptstate"></span>
          </div>
        </div>
      </details>
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

  const hasOverflow = (r.sweeps ?? []).some((s) => s.breaks.length);
  const toc: Array<{ href: string; label: string; count?: number }> = [
    { href: '#top', label: 'Top' },
    { href: '#notes', label: 'Notes' },
  ];
  if (open.length) toc.push({ href: '#findings', label: 'Index', count: open.length });
  if (template.length) toc.push({ href: '#shared', label: 'Shared', count: template.length });
  if (accepted.length) toc.push({ href: '#dismissed', label: 'Dismissed', count: accepted.length });
  toc.push({ href: '#pages', label: 'Pages', count: r.pages.length });
  if (hasOverflow) toc.push({ href: '#overflow', label: 'Overflow' });
  toc.push({ href: '#tech', label: 'Tech' });
  const tocNav = `<nav class="toc" aria-label="On this page"><span class="toc-label">On this page</span>${toc
    .map((t) => `<a href="${t.href}">${esc(t.label)}${t.count != null ? ` <span class="n">${t.count}</span>` : ''}</a>`)
    .join('')}</nav>`;

  return `<!doctype html><html lang="en"${stamp ? ` data-stamp="${esc(stamp)}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA Visual — ${esc(host)}</title>
<style>
/* Woo 0862: paper, ink, one red mark. Red is the wordmark — not chrome. */
:root{
  --bg:#fff; --card:#fff; --ink:#111; --mute:#6a6a6a; --faint:#8c8c8c;
  --line:#e6e6e6; --line2:#f0f0f0; --wash:#fafafa;
  --red:#ff021f; --gold:#b8924a;
  --bad:#ff021f; --warn:#8a6a2a;
  --ok:#111; --link:#111;
  --font:"Helvetica Neue",Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:48px}
body{margin:0;background:var(--bg);color:var(--ink);
  font:400 15px/1.5 var(--font);-webkit-font-smoothing:antialiased}
a{color:var(--link);text-decoration-thickness:1px;text-underline-offset:2px}
a:hover{color:var(--red)}
main{max-width:960px;margin:0 auto;padding:0 24px 96px}
header,section,details.tech,.find{scroll-margin-top:56px}

/* Jump list: quiet text. Pills were the AI look. */
.toc{position:sticky;top:0;z-index:20;display:flex;gap:18px;align-items:center;
  overflow-x:auto;flex-wrap:nowrap;padding:12px 20px;background:var(--bg);
  border-bottom:1px solid var(--line);-webkit-overflow-scrolling:touch;scrollbar-width:none}
.toc::-webkit-scrollbar{display:none}
.toc .toc-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.toc a{flex:0 0 auto;font-size:13px;font-weight:400;line-height:1.4;
  padding:0;border:0;text-decoration:none;color:var(--faint);white-space:nowrap}
.toc a .n{margin-left:4px}
.toc a[aria-current="true"]{color:var(--ink)}
@media (min-width:1100px){
  html{scroll-padding-top:16px}
  header,section,details.tech,.find{scroll-margin-top:16px}
  body{padding-left:176px}
  .toc{position:fixed;left:0;top:0;bottom:0;width:176px;flex-direction:column;align-items:flex-start;
    gap:10px;overflow-x:hidden;overflow-y:auto;padding:40px 28px;
    border-bottom:0;border-right:1px solid var(--line)}
  .toc a{font-size:13px}
}

/* ---------------------------------- head --------------------------------- */
header{padding:40px 24px 0;max-width:960px;margin:0 auto}
.brand{font-size:12px;color:var(--faint);font-weight:400}
.brand b{color:var(--red);font-weight:500}
h1{font-size:28px;line-height:1.25;margin:16px 0 6px;letter-spacing:-.02em;font-weight:500;color:var(--ink)}
h1.ok,h1.warn,h1.bad{color:var(--ink)}
.verdict-sub{color:var(--mute);font-size:15px}
.runmeta{color:var(--faint);font-size:13px;margin:18px 0 0;padding-bottom:28px;border-bottom:1px solid var(--line)}
.runmeta b{color:var(--mute);font-weight:500}

/* -------------------------------- sections ------------------------------- */
section{margin:48px 0 0}
h2{font-size:18px;margin:0 0 6px;letter-spacing:-.015em;font-weight:500}
h2+.lead{color:var(--mute);font-size:14px;margin:0 0 20px}
h2:not(:has(+.lead)){margin-bottom:20px}

.card{background:var(--card);border-top:1px solid var(--line);border-radius:0}
.pad{padding:16px 0}

/* --------------------------------- banners ------------------------------- */
.alert,.fatal{border-radius:0;padding:0 0 0 14px;font-size:14px;margin:0 0 16px;
  border:0;border-left:2px solid var(--line);background:transparent;color:var(--ink)}
.alert{border-left-color:var(--gold)}
.fatal{border-left-color:var(--red)}
.alert b,.fatal b{color:inherit;font-weight:500}
.alert ul,.fatal ul{margin:6px 0 0;padding-left:18px}

.mark{color:var(--red);font-size:12px;font-weight:500}
.humannote{padding:4px 0;font-size:15px;line-height:1.55;white-space:pre-wrap}

/* ---------------------------------- table -------------------------------- */
.tablewrap{background:var(--card);overflow-x:auto}
table.grid{width:100%;min-width:660px;border-collapse:collapse;font-size:14px}
table.grid th{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);
  font-size:12px;color:var(--faint);font-weight:400;vertical-align:bottom}
table.grid td{padding:12px 8px;border-bottom:1px solid var(--line2);vertical-align:middle}
table.grid tr:last-child td{border-bottom:1px solid var(--line)}
table.grid th.c,table.grid td.c{text-align:center}
table.grid td.yes{color:var(--ink);font-size:14px;line-height:1}
table.grid td.no{color:var(--line);font-size:14px;line-height:1}
table.grid td.tnum{color:var(--mute);font-variant-numeric:tabular-nums;font-size:13px}
table.grid td a{color:var(--ink);text-decoration:none}
table.grid td a:hover{color:var(--red)}
table.grid td.major{color:var(--red)}
table.grid td.minor,table.grid td.note{color:var(--mute)}
.note{font-size:13px;color:var(--faint);margin:10px 0 0}

/* --------------------------------- findings ------------------------------ */
.find{background:var(--card);border-top:1px solid var(--line);margin:0 0 28px;
  display:grid;grid-template-columns:1fr}
.find .shot{border:0;background:var(--wash);max-height:340px;padding:0;margin:12px 0 0;
  position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden}
@media (min-width:800px){
  .find:has(.shot.pic){grid-template-columns:1fr 400px;gap:32px;align-items:start}
  .find .shot{max-height:none;margin:20px 0 0;background:var(--wash)}
}
.fbody{padding:20px 0 8px;min-width:0}
.fhead{display:flex;gap:12px;align-items:baseline;margin:0 0 6px}
.fhead h3{font-size:18px;margin:0;line-height:1.3;letter-spacing:-.015em;font-weight:500}
.num{flex:0 0 auto;font-size:13px;color:var(--faint);font-variant-numeric:tabular-nums}
.fmeta{margin:0 0 12px;font-size:13px;color:var(--faint)}
.find p{margin:0 0 10px;font-size:15px;color:var(--ink)}
.find p.where{margin:0 0 16px;font-size:13px;color:var(--mute)}
.shot img{max-width:100%;max-height:340px;width:auto;display:block}
@media (min-width:800px){ .shot img{max-height:480px} }
.shot .zoom{position:absolute;bottom:10px;right:10px;color:var(--faint);background:var(--bg);
  font-size:12px;padding:4px 8px;opacity:0}
.shot:hover .zoom{opacity:1}
.find p.noloc{font-size:13px;color:var(--faint);margin:0 0 10px}
.find.ok2{opacity:.62}
.find p.accepted{font-size:13px;color:var(--mute);margin:8px 0}
.acceptbox{margin:8px 0 0;padding:0;border:0;background:transparent}
.acceptbox>summary{cursor:pointer;font-size:13px;color:var(--faint);list-style:none}
.acceptbox>summary::-webkit-details-marker{display:none}
.acceptbox>summary::before{content:'▸ ';color:var(--faint)}
.acceptbox[open]>summary::before{content:'▾ '}
.acceptbox>summary:hover{color:var(--ink)}
.acceptbox .accepthint{display:block;font-size:13px;color:var(--mute);margin:10px 0 8px}
.acceptbox textarea.why,.notesbox textarea.notes{width:100%;box-sizing:border-box;font:14px/1.45 inherit;padding:10px 0;
  border:0;border-bottom:1px solid var(--line);border-radius:0;resize:vertical;min-height:48px;background:transparent;color:inherit}
.acceptbox textarea.why:focus,.notesbox textarea.notes:focus{outline:0;border-bottom-color:var(--ink)}
.acceptbox .acceptrow,.notesbox .acceptrow{display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin-top:10px}
.acceptbox button,.notesbox button{font:400 13px/1 inherit;padding:0;border-radius:0;cursor:pointer;
  border:0;background:transparent;color:var(--ink)}
.acceptbox button:hover,.notesbox button:hover{color:var(--red)}
.acceptbox .acceptstate,.notesbox .acceptstate{font-size:12px;color:var(--mute)}
.acceptbox .acceptstate.bad,.notesbox .acceptstate.bad{color:var(--red)}
.notesbox{background:transparent;border:0;padding:0;margin:0 0 8px}

/* ---------------------------------- pages -------------------------------- */
.page{background:transparent;border-top:1px solid var(--line);margin:0}
.page>summary{padding:14px 0;cursor:pointer;display:flex;gap:10px;align-items:center;
  flex-wrap:wrap;list-style:none}
.page>summary::-webkit-details-marker{display:none}
.page>summary::before{content:'▸';color:var(--faint);font-size:12px;flex:0 0 auto}
.page[open]>summary::before{content:'▾'}
.page .grow{flex:1}
.pbody{padding:0 0 20px}
.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px;margin-top:12px}
.shots figure{margin:0;min-width:0}
.shots figcaption{font-size:12px;color:var(--faint);font-weight:400;margin:0 0 6px}
.shots a{display:block;max-height:300px;overflow:auto;border:1px solid var(--line);background:var(--card)}
.shots img{width:100%;display:block}
.shots .tiny{display:block;margin-top:5px}

/* --------------------------------- details ------------------------------- */
details.tech{margin-top:34px;border-top:1px solid var(--line);padding-top:18px}
details.tech>summary{cursor:pointer;font-size:13px;font-weight:500;letter-spacing:-.01em;color:var(--mute);list-style:none}
details.tech>summary::-webkit-details-marker{display:none}
details.tech>summary::before{content:'▸ ';color:var(--faint)}
details.tech[open]>summary::before{content:'▾ '}
details.tech h3{font-size:13px;color:var(--mute);font-weight:500;margin:22px 0 8px}

/* ----------------------------------- bits -------------------------------- */
.tiny{font-size:12px;color:var(--mute)}
.bad{color:var(--bad)} .ok{color:var(--ok)} .warn{color:var(--warn)}
.mono{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:transparent;
  padding:0;border:0;color:var(--mute)}
ul.plain{margin:8px 0;padding-left:20px;font-size:13px}
ul.plain li{margin:3px 0}
table.plain{width:100%;border-collapse:collapse;font-size:13px}
table.plain th{text-align:left;font-size:12px;
  color:var(--faint);font-weight:400;padding:8px 0;border-bottom:1px solid var(--line)}
table.plain td{padding:10px 8px 10px 0;border-bottom:1px solid var(--line2);vertical-align:top}
table.plain tr:last-child td{border-bottom:0}
.empty{color:var(--mute);font-size:13.5px}
footer{max-width:940px;margin:0 auto;padding:22px 20px 50px;border-top:1px solid var(--line);
  color:var(--faint);font-size:12px}

@media print{
  body{background:#fff;padding-left:0}
  .toc{display:none}
  .find,.page,.card,.tablewrap{break-inside:avoid;box-shadow:none}
  details.tech,.page{display:none}
  .shot{max-height:none}
}
</style></head><body>
${tocNav}
<header id="top">
  <div class="brand"><b>WOO</b> · QA Visual · ${esc(host)}</div>
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

<section class="notesbox" id="notes">
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
    ? `<section id="findings">
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
    ? `<section id="shared">
  <h2>Shared-component findings</h2>
  <p class="lead">Header / nav / footer — fix once and it is gone on every page. Start here.</p>
  ${template.map(findingBlock).join('')}
</section>`
    : ''
}

${
  accepted.length
    ? `<section id="dismissed">
  <h2>Dismissed as intentional (${accepted.length})</h2>
  <p class="lead">A reviewer marked these as false positives or intentional, so they do not count. Edit the reason or undo on the card — later runs will keep them dismissed.</p>
  ${accepted.map(findingBlock).join('')}
</section>`
    : ''
}

${
  perPage.length
    ? `<section id="pages">
  <h2>Page-only findings</h2>
  <p class="lead">Open a page to see its findings with all 3 viewport screenshots.</p>
  ${r.pages.map(pageRow).join('')}
</section>`
    : `<section id="pages">
  <h2>Pages</h2>
  <p class="lead">No page-only findings. Open a page to see its screenshots.</p>
  ${r.pages.map(pageRow).join('')}
</section>`
}

${
  r.sweeps.some((s) => s.breaks.length)
    ? `<section id="overflow">
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

<details class="tech" id="tech">
  <summary>Technical details</summary>

  <h3>URL ↔ design pairing</h3>
  <div class="card" style="overflow-x:auto">
    <table class="plain">
      <thead><tr><th>Page</th><th>Figma frame</th><th>How paired</th></tr></thead>
      <tbody>${r.pages
        .map(
          (p) => `<tr>
        <td><a href="${esc(p.url)}" target="_blank">${esc(path(p.url))}</a></td>
        <td>${p.mapping.frameName ? esc(p.mapping.frameName) + (p.mapping.isTemplate ? ' <span class="tiny">template</span>' : '') : '<span class="warn">unpaired</span>'}</td>
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
${TOC_SCRIPT}
</body></html>`;
}
