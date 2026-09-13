import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type AiProvider = 'openrouter' | 'openai' | 'anthropic' | 'none';

/** The three widths every check runs at. Fixed on purpose — fewer knobs, comparable runs. */
export const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;
export type ViewportName = (typeof VIEWPORTS)[number]['name'];

export interface Config {
  url: string;
  /** scan the whole site from its sitemap */
  site?: string;
  maxPages: number;
  concurrency: number;
  /**
   * At least 3 vision requests in flight. Same 24 calls, shorter wall-clock.
   * Does not change screenshots, viewports, or token count on a clean run.
   */
  aiFast?: boolean;
  /** Figma file/frame link, if the design lives in Figma */
  figma?: string;
  /** Optional second Figma link — usually the mobile page of the same file, or a mobile file */
  figmaMobile?: string;
  /** Folder of design PNGs (desktop.png / tablet.png / mobile.png), if not using Figma */
  designDir?: string;
  /** Promote this run to the approved baseline after comparing */
  approve: boolean;
  /** Where runs and the approved baseline live */
  stateDir: string;
  ai: { provider: AiProvider; model: string; apiKey: string; baseUrl: string };
  /** credentials for a site behind a gate, and how to use them */
  auth?: import('./auth.js').AuthConfig;
  /** filled in once the gate is open — every browser context is created with it */
  authState?: import('./auth.js').AuthState;
  /**
   * Query keys copied from the seed URL onto every discovered page.
   * Empty = strip all query (default). Tracking params are never kept unless listed here.
   */
  preserveQuery: string[];
  figmaToken: string;
  mask: { mask: string[]; hide: string[] };
  verbose: boolean;
}

export function loadDotEnv(dir = process.cwd()) {
  const p = resolve(dir, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function arg(flags: string[], argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (flags.includes(argv[i])) return argv[i + 1];
    for (const f of flags) if (argv[i].startsWith(f + '=')) return argv[i].slice(f.length + 1);
  }
  return undefined;
}

export const USAGE = `qa-visual <url|--site url> [options]
qa-visual accept <finding#> "reason"  Sign off a finding on the latest run as INTENDED.
                                      Writes accepted.json; later runs still show it, but do not count it.

  --site <url>       Scan the whole site: page list from sitemap.xml
  --pages <n>        Max pages (default 8)
  --concurrency <n>  Pages in parallel (default 2)
  --fast             Up to 3 AI calls at once (same number of calls, finishes sooner)
  --preserve-query <keys>  Keep these query keys from the seed URL on every discovered
                     page (comma-separated). Example: --preserve-query qa-showcase
                     so /?qa-showcase=1 becomes /about/?qa-showcase=1. Default: strip all.
                     Also: QA_PRESERVE_QUERY in .env
  --figma <link>     Figma file / page / frame link. Frames are paired to URLs by name;
                     the pairing is written to pages.json so you can edit it.
  --figma-mobile <link>  Figma page (or file) of mobile frames. Without this, only the
                     dominant (usually desktop) width from --figma is kept.
  --design <folder>  Folder with desktop.png / tablet.png / mobile.png (alternative to --figma)
  --approve          Make this run the approved baseline for future comparisons
  --ai <provider>    openrouter | openai | anthropic | none   (default: from .env, else none)
  --model <id>       Vision model (default: from .env)
  --verbose

Site behind a user/password:
  Paste a URL with credentials:     https://user:password@site.com/
  or set in .env:                   QA_HTTP_USER=... / QA_HTTP_PASS=...
                                    QA_TZ=Asia/Ho_Chi_Minh  (default: Hanoi time)
  If it is a login form (not the browser popup), add as needed:
                                    QA_LOGIN_URL=... (default /wp-login.php)
                                    QA_LOGIN_USER_SEL / QA_LOGIN_PASS_SEL / QA_LOGIN_SUBMIT_SEL

Output: reports/<timestamp>/report.html
`;

/**
 * Take credentials out of a pasted URL.
 *
 * `https://user:pass@host/` is the first thing anyone tries, and Chrome strips the credentials and
 * shows the login popup anyway — so the URL alone does not work. Pulling them out here makes the
 * paste behave the way people expect, and keeps the secret out of every place the URL is stored:
 * pages.json, the report, the browser's localStorage.
 */
export function stripCredentials(raw: string): { url: string; user?: string; pass?: string } {
  try {
    const u = new URL(raw);
    if (!u.username && !u.password) return { url: raw };
    const user = decodeURIComponent(u.username);
    const pass = decodeURIComponent(u.password);
    u.username = '';
    u.password = '';
    return { url: u.toString(), user: user || undefined, pass: pass || undefined };
  } catch {
    return { url: raw };
  }
}


/**
 * Query keys to copy from the seed URL onto every discovered page.
 *
 * Empty (the default) strips all query, including tracking. A listed key is kept with the
 * value from the seed — `/?qa-showcase=1` becomes `/about/?qa-showcase=1`. Names not listed
 * are still dropped, even if they were on the seed.
 */
export function parsePreserveQuery(raw?: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const name = part.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function loadConfig(argv: string[], cwd = process.cwd()): Config {
  loadDotEnv(cwd);
  const url = argv.find((a) => /^https?:\/\//i.test(a) && !a.includes('figma.com'));
  const siteArg = arg(['--site'], argv);
  if (!url && !siteArg) throw new Error('Missing URL (or --site).\n\n' + USAGE);

  const figmaMobile = arg(['--figma-mobile'], argv);
  const figma =
    arg(['--figma'], argv) ??
    argv.find((a) => /figma\.com\//.test(a) && a !== figmaMobile);
  const provider = (arg(['--ai'], argv) ?? process.env.QA_AI_PROVIDER ?? 'none') as AiProvider;

  let apiKey = '';
  let baseUrl = '';
  let defaultModel = '';
  if (provider === 'openrouter') {
    apiKey = process.env.OPENROUTER_API_KEY ?? '';
    // Overridable so a corporate gateway (or a test) can stand in front of OpenRouter.
    baseUrl = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
    defaultModel = 'google/gemini-3.7-flash';
  } else if (provider === 'openai') {
    apiKey = process.env.OPENAI_API_KEY ?? '';
    baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    defaultModel = 'gpt-4o';
  } else if (provider === 'anthropic') {
    apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    baseUrl = 'https://api.anthropic.com/v1';
    defaultModel = 'claude-sonnet-4-5';
  } else if (provider !== 'none') {
    throw new Error(`Unknown --ai provider: ${provider}`);
  }

  const maskPath = resolve(cwd, 'mask.json');
  const mask = existsSync(maskPath) ? JSON.parse(readFileSync(maskPath, 'utf8')) : { mask: [], hide: [] };

  // Credentials may arrive inside the URL (https://user:pass@host/) — take them out so they never
  // reach pages.json, the report, or the browser's saved session.
  const site = arg(['--site'], argv);
  const bare = stripCredentials(url ?? site!);
  const bareSite = site ? stripCredentials(site).url : undefined;
  const auth = {
    user: bare.user ?? process.env.QA_HTTP_USER ?? undefined,
    pass: bare.pass ?? process.env.QA_HTTP_PASS ?? undefined,
    loginUrl: process.env.QA_LOGIN_URL ?? undefined,
    userSel: process.env.QA_LOGIN_USER_SEL ?? undefined,
    passSel: process.env.QA_LOGIN_PASS_SEL ?? undefined,
    submitSel: process.env.QA_LOGIN_SUBMIT_SEL ?? undefined,
  };

  return {
    url: bare.url,
    site: bareSite,
    auth: auth.user || auth.pass ? auth : undefined,
    maxPages: Math.max(1, Number(arg(['--pages'], argv) ?? 8)),
    concurrency: Math.max(1, Math.min(4, Number(arg(['--concurrency'], argv) ?? 2))),
    aiFast: argv.includes('--fast'),
    figma,
    figmaMobile,
    designDir: arg(['--design'], argv),
    approve: argv.includes('--approve'),
    stateDir: resolve(cwd, 'reports'),
    ai: { provider, model: arg(['--model'], argv) ?? process.env.QA_AI_MODEL ?? defaultModel, apiKey, baseUrl },
    figmaToken: process.env.FIGMA_TOKEN ?? '',
    mask: { mask: mask.mask ?? [], hide: mask.hide ?? [] },
    verbose: argv.includes('--verbose'),
    preserveQuery: parsePreserveQuery(arg(['--preserve-query'], argv) ?? process.env.QA_PRESERVE_QUERY),
  };
}

/**
 * Where log lines go, besides stderr.
 *
 * One sink instead of threading a logger through every module: the web UI wants the exact lines the
 * terminal shows, and every module already calls log(). Anything else would mean touching them all.
 */
let sink: ((line: string) => void) | null = null;
export const setLogSink = (f: ((line: string) => void) | null) => {
  sink = f;
};

/* ------------------------------- progress ------------------------------- */

export interface ProgressPlan {
  /** screenshots: pages × viewports */
  capture: number;
  /** vision calls the run will actually make */
  ai: number;
  /** closing steps (sweep, report) */
  wrap: number;
}

export interface Progress {
  done: number;
  total: number;
  /** what is happening right now, in the user's language */
  label: string;
  phase: 'capture' | 'ai' | 'wrap';
  /**
   * How the total breaks down. Without it "19/44" on a 7-page run reads as a number nobody can
   * check, and the first thing anyone asks is why 7 pages is 44 of anything.
   */
  plan: ProgressPlan;
}

let progressSink: ((p: Progress) => void) | null = null;
export const setProgressSink = (f: ((p: Progress) => void) | null) => {
  progressSink = f;
};

let state: Progress = { done: 0, total: 0, label: '', phase: 'capture', plan: { capture: 0, ai: 0, wrap: 0 } };

/**
 * Declare the size of the job before it starts.
 *
 * The unit is one API-or-screenshot step, not one page: a page takes three screenshots and up to
 * three model calls, so counting pages makes the bar sit still for thirty seconds at a time on a
 * job that is actually moving.
 */
export function progressTotal(plan: ProgressPlan) {
  state = { done: 0, total: plan.capture + plan.ai + plan.wrap, label: 'starting…', phase: 'capture', plan };
  progressSink?.({ ...state });
}

export function progressTick(label: string, phase: Progress['phase'] = state.phase) {
  state = { ...state, done: Math.min(state.done + 1, state.total), label, phase };
  progressSink?.({ ...state });
}

/** Move the label without claiming a step finished. */
export function progressSay(label: string, phase: Progress['phase'] = state.phase) {
  state = { ...state, label, phase };
  progressSink?.({ ...state });
}

export const log = (...a: unknown[]) => {
  const line = a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ');
  console.error('[qa-visual]', line);
  try {
    sink?.(line);
  } catch {}
};
