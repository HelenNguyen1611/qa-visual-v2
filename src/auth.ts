import type { Browser, BrowserContextOptions } from 'playwright';
import { log } from './config.js';
export { stripCredentials } from './config.js';

/**
 * Getting past the gate on a staging site.
 *
 * Two completely different things are called "user/pass on the URL", and they need different
 * handling — guessing wrong wastes a whole run:
 *
 *   1. HTTP Basic auth (the browser's own grey popup, usually .htpasswd on a staging host).
 *      The credentials go in a header on every request. Playwright does this for us.
 *   2. A login FORM — WordPress wp-login.php, or a "coming soon" plugin with a password box.
 *      Here the credentials buy a cookie, and the cookie is what every later request needs.
 *
 * The tool probes once and finds out which, rather than asking the person to know the difference.
 * A 401 with WWW-Authenticate is Basic and nothing else is.
 */

export interface AuthConfig {
  user?: string;
  pass?: string;
  /** set to log in through a form instead of Basic auth; auto-guessed for WordPress if omitted */
  loginUrl?: string;
  userSel?: string;
  passSel?: string;
  submitSel?: string;
}

/** What every context in the run has to be created with, once the gate is open. */
export interface AuthState {
  httpCredentials?: { username: string; password: string };
  storageState?: BrowserContextOptions['storageState'];
  /** for the report: how the run got in, never the credentials themselves */
  how?: string;
}

/**
 * Does this URL sit behind an HTTP Basic challenge?
 *
 * Measured, not assumed: Chromium does NOT hand back the 401 response for an unanswered Basic
 * challenge — it fails the navigation with net::ERR_INVALID_AUTH_CREDENTIALS. Checking only for
 * `status === 401` therefore reports "no gate" on every gated site, which is how a protected site
 * came out looking like a one-page site. Both signals are accepted: the error, and the 401 for the
 * cases where a response does come through.
 */
const AUTH_ERROR = /ERR_INVALID_AUTH_CREDENTIALS/i;

async function needsBasic(browser: Browser, url: string, creds?: { username: string; password: string }): Promise<boolean> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...(creds ? { httpCredentials: creds } : {}) });
  const page = await ctx.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'commit', timeout: 20000 });
    if (!res) return false;
    if (res.status() !== 401) return false;
    const h = await res.allHeaders().catch(() => ({}) as Record<string, string>);
    // A 401 without the header is still a 401 — treat it as a gate rather than guessing further.
    return !h['www-authenticate'] || /basic/i.test(h['www-authenticate']);
  } catch (e: any) {
    return AUTH_ERROR.test(String(e?.message ?? e));
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Selectors that cover WordPress and most hand-rolled login forms, in order of confidence. */
const USER_SELECTORS = ['#user_login', 'input[name="log"]', 'input[name="username"]', 'input[name="email"]', 'input[type="email"]', 'input[name="user"]'];
const PASS_SELECTORS = ['#user_pass', 'input[name="pwd"]', 'input[name="password"]', 'input[type="password"]'];
const SUBMIT_SELECTORS = ['#wp-submit', 'button[type="submit"]', 'input[type="submit"]', 'button'];

async function firstVisible(page: any, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    const n = await page.locator(sel).count().catch(() => 0);
    if (n) {
      const visible = await page.locator(sel).first().isVisible().catch(() => false);
      if (visible) return sel;
    }
  }
  return null;
}

/**
 * Log in through a form once and keep the cookies for the whole run.
 *
 * The cookies have to be captured as storageState because every page is captured in a FRESH
 * browser context — that isolation is what keeps one page's leftovers out of another page's
 * screenshot, and it also means a login done in one context is invisible to the next unless the
 * state is carried across explicitly.
 */
async function formLogin(browser: Browser, cfg: AuthConfig, siteUrl: string): Promise<AuthState> {
  const loginUrl = cfg.loginUrl || new URL('/wp-login.php', siteUrl).toString();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const userSel = cfg.userSel || (await firstVisible(page, USER_SELECTORS));
    const passSel = cfg.passSel || (await firstVisible(page, PASS_SELECTORS));
    if (!passSel) throw new Error(`no password field at ${loginUrl} — set QA_LOGIN_URL / QA_LOGIN_PASS_SEL in .env`);

    // A "coming soon" gate often has only a password box, so the user field is optional.
    if (userSel && cfg.user) await page.fill(userSel, cfg.user);
    await page.fill(passSel, cfg.pass ?? '');

    const submitSel = cfg.submitSel || (await firstVisible(page, SUBMIT_SELECTORS));
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}),
      submitSel ? page.click(submitSel) : page.keyboard.press('Enter'),
    ]);
    await page.waitForTimeout(1200);

    const state = await ctx.storageState();
    const cookies = state.cookies?.length ?? 0;
    if (!cookies) throw new Error(`login at ${loginUrl} set no cookies — check the user/password`);

    // Still on a login form? Then the credentials were rejected, whatever the HTTP status said.
    const stillLogin = await page.locator(PASS_SELECTORS.join(',')).count().catch(() => 0);
    if (stillLogin) log(`⚠ still seeing a password field at ${page.url()} after submit — credentials may be wrong; continuing anyway`);

    log(`form login at ${loginUrl} — keeping ${cookies} cookies for the run`);
    return { storageState: state, how: `form login at ${loginUrl}` };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Did we land on a page that is itself a login form? Then Basic auth was not the gate. */
async function looksLikeLoginPage(browser: Browser, url: string, auth: AuthState): Promise<boolean> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...authOptions(auth) });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const pw = await page.locator(PASS_SELECTORS.join(',')).count().catch(() => 0);
    return pw > 0;
  } catch {
    return false;
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * Work out how to get in, before the run starts.
 *
 * Order matters, and it is chosen around how these gates actually fail:
 *
 *   - An explicit QA_LOGIN_URL means the person already knows it is a form. Believe them.
 *   - Otherwise TRY Basic first. It is one header, it is what staging hosts behind CloudFront,
 *     an ALB or .htpasswd use, and it costs a single page load to test. Detecting it purely from a
 *     401 + WWW-Authenticate is not enough: some AWS edge functions answer 403, or challenge the
 *     document but not sub-resources, and then a run silently screenshots the login screen and
 *     "compares" that against the design.
 *   - Verify by loading the site WITH the credentials and looking for a password box. Still one?
 *     Then it was a form all along, so log in properly and keep the cookie.
 *
 * A public site costs one page load and nothing else.
 */
export async function prepareAuth(browser: Browser, siteUrl: string, cfg: AuthConfig | undefined): Promise<AuthState> {
  const hasCreds = Boolean(cfg?.user || cfg?.pass);

  if (!hasCreds) {
    // Say precisely what is missing, rather than failing later with a screenshot of a login box.
    if (await needsBasic(browser, siteUrl)) {
      throw new Error(
        `this site needs HTTP Basic auth (the browser user/password popup) but no credentials were given.\n` +
          `Option 1: paste a URL with user/password — https://user:password@${new URL(siteUrl).host}/\n` +
          `Option 2: set in .env — QA_HTTP_USER=... and QA_HTTP_PASS=...`,
      );
    }
    return {};
  }

  if (cfg!.loginUrl) return formLogin(browser, cfg!, siteUrl);

  const basic: AuthState = {
    httpCredentials: { username: cfg!.user ?? '', password: cfg!.pass ?? '' },
    how: 'HTTP Basic auth',
  };

  // Do the credentials actually open it? The same error means "rejected" once we are sending them.
  if (await needsBasic(browser, siteUrl, basic.httpCredentials)) {
    throw new Error(
      `user/password rejected by the site (HTTP Basic auth at ${new URL(siteUrl).host}).\n` +
        `Check for leading/trailing spaces when pasting. If the password contains @ : / ? # do not put it in the URL — ` +
        `use the User / Password fields, or set QA_HTTP_USER / QA_HTTP_PASS in .env.`,
    );
  }

  if (await looksLikeLoginPage(browser, siteUrl, basic)) {
    log('still seeing a password field after Basic auth — switching to form login');
    return formLogin(browser, cfg!, siteUrl);
  }

  log('using HTTP Basic auth — sending user/password on every request (including images, CSS, fonts)');
  return basic;
}

/** Context options every part of the run must be created with. */
export function authOptions(auth: AuthState | undefined): BrowserContextOptions {
  if (!auth) return {};
  const o: BrowserContextOptions = {};
  if (auth.httpCredentials) o.httpCredentials = auth.httpCredentials;
  if (auth.storageState) o.storageState = auth.storageState;
  return o;
}
