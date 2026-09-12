#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve, normalize, sep, basename } from 'node:path';
import { loadConfig, setLogSink, setProgressSink, log, type Config, type Progress } from './config.js';
import { discover, runQa, designCache, openFindings, type DiscoveredFrame } from './core.js';
import { frameFromLink, type FigmaFrame } from './design.js';
import { writePagesJson, type PageTarget } from './pages.js';
import { buildShare } from './share.js';
import { renderReport, type RunReport } from './report.js';
import { listPageCoverage, listRunSummaries, reportSite, siteKey } from './site.js';
import { findingByNum, markFindingAccepted } from './accepted.js';

/**
 * The web front end: one page, a few JSON endpoints, and a log stream.
 *
 * Bound to 127.0.0.1 on purpose and with no auth — .env holds a Figma token, so this is a local
 * tool for one person, not a service. Do not move it to 0.0.0.0 without adding real auth.
 */

const HOST = '127.0.0.1';
const PORT = Number(process.env.QA_PORT ?? 5173);
const UI_DIR = resolve(import.meta.dirname ?? '.', '..', 'ui');

/** One run at a time. A queue would be machinery for a problem one person cannot have. */
interface Run {
  id: string;
  lines: string[];
  done: boolean;
  error?: string;
  reportUrl?: string;
  findings?: number;
  /** last progress seen, replayed to a client that connects late or reconnects */
  progress?: Progress;
  clients: Set<(chunk: string) => void>;
}
const runs = new Map<string, Run>();
let busy = false;

/** Frames from the last discover, so a run can resolve a row's frame by name. */
let lastFrames: FigmaFrame[] = [];
let lastConfig: Config | null = null;

function push(run: Run, event: string, data: unknown) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const send of run.clients) {
    try {
      send(chunk);
    } catch {}
  }
}

/** Build a Config the same way the CLI does, so both front ends behave identically. */
function configFor(siteUrl: string, design: string | undefined, maxPages: number, creds?: { user?: string; pass?: string }): Config {
  const argv = [siteUrl, '--site', siteUrl, '--pages', String(maxPages)];
  // One field in the UI takes either: a figma.com link, or a folder of design PNGs.
  if (design) argv.push(/figma\.com\//.test(design) ? '--figma' : '--design', design);
  const cfg = loadConfig(argv);
  // Typed into the form rather than the URL — the form is the place that does not get remembered.
  if (creds?.user || creds?.pass) {
    cfg.auth = { ...(cfg.auth ?? {}), user: creds.user || cfg.auth?.user, pass: creds.pass || cfg.auth?.pass };
  }
  return cfg;
}

/** Credentials the browser typed in, kept only in memory for as long as the server runs. */
let lastCreds: { user?: string; pass?: string } | undefined;

const json = (res: any, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Serve a file from under one root.
 *
 * The containment check is on the RESOLVED path, not the URL text: `..` and encoded variants are
 * easy to miss by pattern, and this server has the whole reports folder behind it.
 */
async function serveFile(res: any, root: string, rel: string) {
  const target = resolve(root, normalize(rel).replace(/^(\.\.(\/|\\|$))+/, ''));
  if (target !== root && !target.startsWith(root + sep)) return json(res, 403, { error: 'ngoài phạm vi' });
  try {
    const s = await stat(target);
    if (s.isDirectory()) return json(res, 404, { error: 'không thấy' });
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    json(res, 404, { error: 'không thấy: ' + rel });
  }
}

const readBody = (req: any) =>
  new Promise<any>((ok, bad) => {
    let s = '';
    req.on('data', (c: any) => {
      s += c;
      if (s.length > 2_000_000) bad(new Error('body quá lớn'));
    });
    req.on('end', () => {
      try {
        ok(s ? JSON.parse(s) : {});
      } catch (e) {
        bad(new Error('JSON không hợp lệ'));
      }
    });
  });

const reportsRoot = () => resolve(lastConfig?.stateDir ?? join(process.cwd(), 'reports'));

/** A run folder, only if the stamp really names one inside the reports root. */
function runDirFor(stamp: string): string | null {
  if (!/^[\w:.-]{4,40}$/.test(stamp)) return null;
  const root = reportsRoot();
  const dir = resolve(root, stamp);
  if (dir !== root && !dir.startsWith(root + sep)) return null;
  return existsSync(join(dir, 'report.json')) ? dir : null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const path = url.pathname;

  try {
    /* ---------------------------------- UI ---------------------------------- */
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) return serveFile(res, UI_DIR, 'index.html');
    if (req.method === 'GET' && path.startsWith('/ui/')) return serveFile(res, UI_DIR, path.slice(4));

    /* ------------------------------- pictures ------------------------------- */
    // Rendered Figma frames, for the pairing table's thumbnails.
    if (req.method === 'GET' && path.startsWith('/design/')) {
      if (!lastConfig) return json(res, 409, { error: 'chưa có lần dò nào' });
      const name = decodeURIComponent(path.slice(8));
      // Two possible homes: rendered Figma frames in the cache, or PNGs in the design folder.
      const roots = [resolve(designCache(lastConfig)), lastConfig.designDir ? resolve(lastConfig.designDir) : null].filter(Boolean) as string[];
      const root = roots.find((r) => existsSync(join(r, name))) ?? roots[0];
      return serveFile(res, root, name);
    }
    // The report and everything it links to (screenshots, diffs, crops).
    if (req.method === 'GET' && path.startsWith('/reports/')) {
      const root = resolve(lastConfig?.stateDir ?? join(process.cwd(), 'reports'));
      const rel = decodeURIComponent(path.slice(9));
      // Rebuild report.html from report.json so a run from last week still gets today's
      // editor (false-positive box, notes, …). Share files stay frozen snapshots.
      const stampMatch = rel.match(/^([^/]+)\/report\.html$/);
      if (stampMatch) {
        const dir = runDirFor(stampMatch[1]);
        if (dir && existsSync(join(dir, 'report.json'))) {
          try {
            const report: RunReport = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
            await writeFile(join(dir, 'report.html'), renderReport(report));
          } catch (e: any) {
            log(`⚠ không dựng lại được report.html của ${stampMatch[1]}: ${e?.message ?? e}`);
          }
        }
      }
      return serveFile(res, root, rel);
    }

    /* ------------------------------- discover ------------------------------- */
    if (req.method === 'POST' && path === '/api/discover') {
      const body = await readBody(req);
      const siteUrl = String(body.siteUrl ?? '').trim();
      const figmaLink = String(body.figmaLink ?? '').trim() || undefined;
      const maxPages = Math.max(1, Math.min(80, Number(body.maxPages ?? 8)));
      if (!/^https?:\/\//i.test(siteUrl)) return json(res, 400, { error: 'URL trang chủ phải bắt đầu bằng http:// hoặc https://' });
      if (figmaLink && !/figma\.com\//.test(figmaLink) && !figmaLink.startsWith('/')) {
        return json(res, 400, { error: 'phần design phải là link figma.com/… hoặc đường dẫn tuyệt đối tới folder PNG' });
      }
      if (busy) return json(res, 409, { error: 'đang có một lượt chạy — đợi nó xong đã' });

      busy = true;
      const lines: string[] = [];
      setLogSink((l) => lines.push(l));
      try {
        lastCreds = { user: String(body.user ?? '').trim() || undefined, pass: String(body.pass ?? '').trim() || undefined };
        const cfg = configFor(siteUrl, figmaLink, maxPages, lastCreds);
        lastConfig = cfg;
        const d = await discover(cfg);
        lastFrames = d.frames.map((f) => ({ id: f.id, name: f.name, width: f.width, height: f.height, file: f.file }));
        return json(res, 200, {
          ...d,
          log: lines,
          hasFigmaToken: Boolean(cfg.figmaToken),
          aiModel: cfg.ai.provider === 'none' ? null : `${cfg.ai.provider}/${cfg.ai.model}`,
          // The URL with any credentials removed — this is the one the page should show and remember.
          siteUrl: cfg.site ?? cfg.url,
          authHow: cfg.authState?.how ?? null,
        });
      } catch (e: any) {
        return json(res, 500, { error: String(e?.message ?? e), log: lines });
      } finally {
        setLogSink(null);
        busy = false;
      }
    }

    /* ---------------------- resolve one pasted Figma link -------------------- */
    if (req.method === 'POST' && path === '/api/frame') {
      const body = await readBody(req);
      const link = String(body.link ?? '').trim();
      if (!lastConfig) return json(res, 409, { error: 'chưa có lần dò nào' });
      try {
        const f = await frameFromLink(link, lastConfig.figmaToken);
        // Render it so the row can show a thumbnail like every other row.
        const { renderFigmaFrames } = await import('./design.js');
        const rendered = await renderFigmaFrames(link, [f], lastConfig.figmaToken, designCache(lastConfig)).catch(() => new Map<string, string>());
        const file = rendered.get(f.id);
        if (!lastFrames.some((x) => x.id === f.id)) lastFrames.push({ ...f, file });
        const out: DiscoveredFrame = { ...f, file, thumb: file ? file.split(/[\\/]/).pop() : undefined };
        return json(res, 200, out);
      } catch (e: any) {
        return json(res, 400, { error: String(e?.message ?? e) });
      }
    }

    /* ---------------------------------- run --------------------------------- */
    if (req.method === 'POST' && path === '/api/run') {
      const body = await readBody(req);
      const rows: PageTarget[] = Array.isArray(body.pages) ? body.pages : [];
      if (!rows.length) return json(res, 400, { error: 'chưa chọn trang nào để chạy' });
      if (!lastConfig) return json(res, 409, { error: 'chưa có lần dò nào — bấm Dò trang trước' });
      if (busy) return json(res, 409, { error: 'đang có một lượt chạy' });

      const cfg = lastConfig;
      const id = Date.now().toString(36);
      const run: Run = { id, lines: [], done: false, clients: new Set() };
      runs.set(id, run);
      busy = true;

      // The full pairing stays on disk even when this run is a subset, so the next session still
      // has every URL — not only the ones just checked.
      const catalog: PageTarget[] = Array.isArray(body.catalog) && body.catalog.length ? body.catalog : rows;
      try {
        writePagesJson(
          catalog
            .filter((r) => typeof r?.url === 'string' && r.url.trim())
            .map((r) => ({ url: r.url, figmaNodeId: r.figmaNodeId, frameName: r.frameName, how: r.how ?? 'ghép trên web' })),
        );
      } catch {}

      setLogSink((l) => {
        run.lines.push(l);
        push(run, 'log', l);
      });
      setProgressSink((p) => {
        run.progress = p;
        push(run, 'progress', p);
      });
      // Answer immediately; the browser then opens the stream and watches.
      json(res, 200, { runId: id });

      (async () => {
        try {
          const out = await runQa(cfg, rows, lastFrames);
          run.reportUrl = '/reports/' + out.stamp + '/report.html';
          run.findings = openFindings(out.report).length;
          push(run, 'done', { reportUrl: run.reportUrl, findings: run.findings, durationMs: out.report.durationMs });
        } catch (e: any) {
          run.error = String(e?.message ?? e);
          push(run, 'failed', { error: run.error });
        } finally {
          run.done = true;
          setLogSink(null);
          setProgressSink(null);
          busy = false;
          for (const send of run.clients) {
            try {
              send('');
            } catch {}
          }
        }
      })();
      return;
    }

    /* -------------------------------- stream -------------------------------- */
    if (req.method === 'GET' && path.startsWith('/api/stream/')) {
      const run = runs.get(path.slice('/api/stream/'.length));
      if (!run) return json(res, 404, { error: 'không thấy lượt chạy này' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // Replay what already happened — the browser may connect a moment late, or reconnect.
      if (run.progress) res.write(`event: progress\ndata: ${JSON.stringify(run.progress)}\n\n`);
      for (const l of run.lines) res.write(`event: log\ndata: ${JSON.stringify(l)}\n\n`);
      if (run.done) {
        if (run.error) res.write(`event: failed\ndata: ${JSON.stringify({ error: run.error })}\n\n`);
        else res.write(`event: done\ndata: ${JSON.stringify({ reportUrl: run.reportUrl, findings: run.findings })}\n\n`);
        return res.end();
      }
      const send = (chunk: string) => (chunk ? res.write(chunk) : res.end());
      run.clients.add(send);
      const beat = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(beat);
        run.clients.delete(send);
      });
      return;
    }

    /* ----------------------------- past runs -------------------------------- */
    /**
     * A flat reports/ folder is timestamp-only, so the UI lists host + time here instead of
     * making someone open each report.json. Optional ?site= keeps the list on one project.
     */
    if (req.method === 'GET' && path === '/api/runs') {
      const root = reportsRoot();
      const site = url.searchParams.get('site') ?? '';
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset') ?? 0) || 0));
      const limit = Math.min(50, Math.max(1, Math.floor(Number(url.searchParams.get('limit') ?? 12) || 12)));
      const rows = listRunSummaries(root, { site: site || undefined }).reverse();
      return json(res, 200, {
        runs: rows.slice(offset, offset + limit).map((r) => ({
          ...r,
          reportUrl: '/reports/' + r.stamp + '/report.html',
        })),
        total: rows.length,
        offset,
        limit,
      });
    }

    if (req.method === 'GET' && path === '/api/coverage') {
      const site = url.searchParams.get('site') ?? '';
      if (!siteKey(site)) return json(res, 200, { pages: [] });
      return json(res, 200, { pages: listPageCoverage(reportsRoot(), site) });
    }

    /* ---------------------------- share one file ---------------------------- */
    if (req.method === 'POST' && path === '/api/share') {
      const body = await readBody(req);
      const stamp = String(body.stamp ?? '').trim();
      if (!/^[\w:.-]{4,40}$/.test(stamp)) return json(res, 400, { error: 'thiếu mã lần chạy' });
      const root = resolve(lastConfig?.stateDir ?? join(process.cwd(), 'reports'));
      const runDir = resolve(root, stamp);
      if (runDir !== root && !runDir.startsWith(root + sep)) return json(res, 403, { error: 'ngoài phạm vi' });
      if (busy) return json(res, 409, { error: 'đang có một lượt chạy — đợi nó xong đã' });
      busy = true;
      try {
        const r = await buildShare(runDir);
        return json(res, 200, { url: '/reports/' + stamp + '/' + basename(r.file), bytes: r.bytes, images: r.images, skipped: r.skipped.length });
      } catch (e: any) {
        return json(res, 500, { error: String(e?.message ?? e) });
      } finally {
        busy = false;
      }
    }

    /* ------------------- restore a session without re-probing ---------------- */
    /**
     * Re-arm the server from a pairing the browser had saved, instead of discovering again.
     *
     * A run needs two things the server holds in memory: which site and design this is (Config),
     * and the frame list a row's name resolves against. Discovering supplies both, which is why
     * skipping it used to make the run fail with "chưa có lần dò nào". This sets both from what
     * the page already has — no browser, no Figma call, no wait.
     */
    if (req.method === 'POST' && path === '/api/session') {
      const body = await readBody(req);
      const siteUrl = String(body.siteUrl ?? '').trim();
      const figmaLink = String(body.figmaLink ?? '').trim() || undefined;
      const maxPages = Math.max(1, Math.min(80, Number(body.maxPages ?? 8)));
      if (!/^https?:\/\//i.test(siteUrl)) return json(res, 400, { error: 'URL trang chủ không hợp lệ' });

      const frames: FigmaFrame[] = (Array.isArray(body.frames) ? body.frames : [])
        .filter((f: any) => f && typeof f.id === 'string' && typeof f.name === 'string')
        .map((f: any) => ({
          id: f.id,
          name: f.name,
          width: Number(f.width) || 0,
          height: Number(f.height) || 0,
          file: typeof f.file === 'string' ? f.file : undefined,
        }))
        .slice(0, 200);

      const creds = { user: String(body.user ?? '').trim() || lastCreds?.user, pass: String(body.pass ?? '').trim() || lastCreds?.pass };
      lastCreds = creds.user || creds.pass ? creds : lastCreds;
      const cfg = configFor(siteUrl, figmaLink, maxPages, lastCreds);
      lastConfig = cfg;
      lastFrames = frames;
      log(`dùng lại bảng ghép đã lưu (${frames.length} frame) — bỏ qua bước dò`);
      return json(res, 200, {
        ok: true,
        frames: frames.length,
        hasFigmaToken: Boolean(cfg.figmaToken),
        aiModel: cfg.ai.provider === 'none' ? null : `${cfg.ai.provider}/${cfg.ai.model}`,
      });
    }

    /* ------------------------ human notes on a report ----------------------- */
    /**
     * A person's note is written AFTER reading the report, so the report has to be rebuilt to
     * carry it. Everything needed is already in report.json — the same object the HTML was
     * rendered from — so this re-renders rather than patching the HTML, and the note therefore
     * shows up in the shared single-file export too, with no separate code path.
     */
    if (req.method === 'GET' && path === '/api/notes') {
      const stamp = url.searchParams.get('stamp') ?? '';
      const dir = runDirFor(stamp);
      if (!dir) return json(res, 400, { error: 'mã lần chạy không hợp lệ' });
      try {
        const r = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
        return json(res, 200, { notes: r.humanNotes ?? '', at: r.humanNotesAt ?? null });
      } catch {
        return json(res, 404, { error: 'không thấy report của lần chạy này' });
      }
    }

    /**
     * The previous run's note, offered as a starting point — standing reminders usually still apply.
     *
     * Only the same site: a note about one client's hero video must not land on another client's
     * report just because that run happened to be the most recent one with a note.
     */
    if (req.method === 'GET' && path === '/api/notes/previous') {
      const before = url.searchParams.get('before') ?? '';
      const root = reportsRoot();
      let site = url.searchParams.get('site') ?? '';
      const fromStamp = runDirFor(before);
      if (fromStamp) {
        try {
          const current = JSON.parse(await readFile(join(fromStamp, 'report.json'), 'utf8'));
          site = reportSite(current) || site;
        } catch {}
      }
      if (!siteKey(site)) return json(res, 200, { notes: '', from: null });
      try {
        const rows = listRunSummaries(root, { before: before || undefined, site });
        for (let i = rows.length - 1; i >= 0; i--) {
          if (!rows[i].hasNotes) continue;
          const r = JSON.parse(await readFile(join(root, rows[i].stamp, 'report.json'), 'utf8'));
          if (typeof r.humanNotes === 'string' && r.humanNotes.trim()) {
            return json(res, 200, { notes: r.humanNotes, from: rows[i].stamp });
          }
        }
      } catch {}
      return json(res, 200, { notes: '', from: null });
    }

    if (req.method === 'POST' && path === '/api/notes') {
      const body = await readBody(req);
      const stamp = String(body.stamp ?? '').trim();
      const notes = String(body.notes ?? '');
      if (notes.length > 20000) return json(res, 400, { error: 'ghi chú quá dài (tối đa 20.000 ký tự)' });
      const dir = runDirFor(stamp);
      if (!dir) return json(res, 400, { error: 'mã lần chạy không hợp lệ' });
      try {
        const report: RunReport = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
        report.humanNotes = notes;
        report.humanNotesAt = notes.trim() ? new Date().toISOString() : undefined;
        await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2));
        await writeFile(join(dir, 'report.html'), renderReport(report));
        // Also as plain text, so the note is findable with grep and readable without the report.
        if (notes.trim()) await writeFile(join(dir, 'notes.md'), notes.trim() + '\n');

        // If a share file was already exported, it is now missing this note — and it is the copy
        // that gets sent to somebody. Rebuild it rather than leaving a stale file with the right
        // name, which is the kind of thing nobody checks before forwarding.
        let reshared = false;
        if (existsSync(join(dir, 'report-share.html'))) {
          try {
            await buildShare(dir);
            reshared = true;
          } catch (e: any) {
            log(`⚠ không dựng lại được file chia sẻ: ${e?.message ?? e}`);
          }
        }

        log(`ghi chú đã lưu vào ${stamp} (${notes.trim().length} ký tự) — report.html đã dựng lại${reshared ? ', file chia sẻ đã dựng lại' : ''}`);
        return json(res, 200, { ok: true, chars: notes.trim().length, reshared });
      } catch (e: any) {
        return json(res, 500, { error: String(e?.message ?? e) });
      }
    }

    /* -------------- sign off a finding as false positive / intended --------- */
    if (req.method === 'POST' && path === '/api/findings/accept') {
      const body = await readBody(req);
      const stamp = String(body.stamp ?? '').trim();
      const num = Number(body.num);
      const accepted = body.accepted !== false;
      const why = String(body.why ?? '');
      if (!Number.isInteger(num) || num < 1) return json(res, 400, { error: 'thiếu số lỗi' });
      if (accepted && !why.trim()) return json(res, 400, { error: 'cần lý do — không lưu im lặng' });
      if (why.length > 2000) return json(res, 400, { error: 'lý do quá dài (tối đa 2.000 ký tự)' });
      const dir = runDirFor(stamp);
      if (!dir) return json(res, 400, { error: 'mã lần chạy không hợp lệ' });
      try {
        const report: RunReport = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
        const f = findingByNum(report, num);
        if (!f) return json(res, 404, { error: 'không có lỗi số ' + num + ' trong report này' });
        markFindingAccepted(f, accepted ? why : null);
        await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2));
        await writeFile(join(dir, 'report.html'), renderReport(report));
        let reshared = false;
        if (existsSync(join(dir, 'report-share.html'))) {
          try {
            await buildShare(dir);
            reshared = true;
          } catch (e: any) {
            log(`⚠ không dựng lại được file chia sẻ: ${e?.message ?? e}`);
          }
        }
        log(
          accepted
            ? `đã duyệt lỗi #${num} “${f.title}” là false positive — report.html đã dựng lại`
            : `đã bỏ xác nhận lỗi #${num} “${f.title}” — report.html đã dựng lại`,
        );
        return json(res, 200, { ok: true, num, accepted, reshared });
      } catch (e: any) {
        return json(res, 500, { error: String(e?.message ?? e) });
      }
    }

    /* -------------------------------- status -------------------------------- */
    if (req.method === 'GET' && path === '/api/status') return json(res, 200, { busy, runs: runs.size });

    json(res, 404, { error: 'không có route ' + path });
  } catch (e: any) {
    json(res, 500, { error: String(e?.message ?? e) });
  }
});

/**
 * Stay alive through a bug.
 *
 * A QA run touches a browser, a filesystem and two HTTP APIs, so something will eventually throw
 * where nothing catches it. Node's default is to exit — and a dead server shows up in the browser
 * as the bare message "Failed to fetch", which says nothing about what happened and loses the one
 * place the reason was printed. Logging and staying up keeps the tool usable and the cause visible.
 */
process.on('uncaughtException', (e: any) => {
  log(`⚠ lỗi không bắt được (server vẫn chạy): ${e?.stack ?? e?.message ?? e}`);
  busy = false;
});
process.on('unhandledRejection', (e: any) => {
  log(`⚠ promise lỗi không bắt được (server vẫn chạy): ${e?.stack ?? e?.message ?? e}`);
  busy = false;
});

server.on('error', (e: any) => {
  if (e?.code === 'EADDRINUSE') {
    log(`⚠ cổng ${PORT} đang bị chiếm — QA Visual có lẽ đã mở ở một cửa sổ Terminal khác.`);
    log(`  Mở http://${HOST}:${PORT} là dùng được ngay. Muốn chạy bản mới thì đóng cửa sổ cũ trước,`);
    log(`  hoặc đổi cổng: QA_PORT=5174 npm start`);
  } else {
    log(`⚠ không mở được server: ${e?.message ?? e}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.error('');
  log(`QA Visual đang chạy tại ${url}`);
  if (!existsSync(join(UI_DIR, 'index.html'))) log(`⚠ không thấy ${join(UI_DIR, 'index.html')} — chạy npm run build chưa?`);
  log('Mở link trên trong browser. Ctrl+C để tắt.');
  console.error('');
});

/** A liveness probe the page can poll, so the UI can tell "server died" from "request failed". */
export {};
