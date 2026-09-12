import type { Config } from './config.js';

export interface VisionMessage {
  system: string;
  user: string;
  /** base64 JPEG images */
  images: Array<{ b64: string; mime: 'image/jpeg' | 'image/png' }>;
  maxTokens?: number;
}

export interface VisionProvider {
  name: string;
  model: string;
  calls: number;
  /** calls that never returned an answer, after retries */
  failures: number;
  /** the first failure's message, for the report to show */
  lastError?: string;
  complete(msg: VisionMessage, timeoutMs: number): Promise<string>;
}

function withTimeout(ms: number) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

/**
 * At most this many vision requests in flight, across the whole run.
 *
 * Not a politeness setting. Three viewports fire together per page and two pages run in parallel,
 * so six large image requests hit the API at once — which is exactly what produced
 * "This request would exceed your available credits given your current in-flight requests" on
 * every page of several runs. Those runs still printed "done" with a partial finding list.
 */
let maxInflight = Math.max(1, Number(process.env.QA_AI_CONCURRENCY ?? 1));
let inflight = 0;
const waiting: Array<() => void> = [];

async function gate<T>(fn: () => Promise<T>): Promise<T> {
  while (inflight >= maxInflight) await new Promise<void>((ok) => waiting.push(ok));
  inflight++;
  try {
    return await fn();
  } finally {
    inflight--;
    waiting.shift()?.();
  }
}

/**
 * Stop calling once the provider is clearly refusing everything.
 *
 * A quota wall does not heal within a run, and every doomed request still counts against a daily
 * request allowance. Retrying 16 calls three times each spent ~44 requests of a 50/day key to
 * produce nothing — so after a few consecutive hard failures the AI phase gives up and says so,
 * which is both cheaper and more honest than a report built from whatever slipped through.
 */
const GIVE_UP_AFTER = 3;
let consecutiveFailures = 0;
let stopped: string | null = null;

export const aiStopped = () => stopped;
export const aiMaxInflight = () => maxInflight;

/** Fast mode: at least 3 in flight. Never lower a higher value already set in the env. */
const FAST_AI = 3;

export function resetAiCircuit(fast = false) {
  consecutiveFailures = 0;
  stopped = null;
  const fromEnv = Math.max(1, Number(process.env.QA_AI_CONCURRENCY ?? 1) || 1);
  maxInflight = fast ? Math.max(fromEnv, FAST_AI) : fromEnv;
}

/** The provider says its concurrency budget is exhausted — one at a time is the only answer. */
function isInFlightWall(msg: string) {
  return /in_flight_budget|in-flight requests|in flight requests/i.test(msg);
}

/**
 * Say what a 402 actually means, in the terms the person has to act on.
 *
 * "would exceed your available credits given your current in-flight requests" reads like a
 * concurrency problem, and it is not: OpenRouter reserves the request's maximum possible cost
 * against the balance before sending it, so on a zero balance the reservation fails with ONE
 * request in flight. Sending fewer at a time cannot fix it, which is why the earlier fix did not.
 * The daily free allowance does not apply either — that is only for model ids ending in ':free'.
 */
function explain402(msg: string, model: string): string {
  if (!isInFlightWall(msg) && !/insufficient credits|negative credit/i.test(msg)) return msg;
  const free = model.endsWith(':free');
  return (
    `OpenRouter is out of credit. ` +
    (free
      ? `Model "${model}" is a :free variant but the balance is zero or negative — OpenRouter blocks free models too when the balance is negative.`
      : `Model "${model}" is PAID, so the free 50 calls/day do not apply (that quota is only for model ids ending in ":free"). ` +
        `OpenRouter reserves the maximum cost of each request against the balance, so a $0 balance blocks even one request — lowering concurrency will not help.`) +
    ` Fix: add credit, or switch to a ":free" model (see "npm run models").`
  );
}

/**
 * Ask the provider what this key can do, before spending a run finding out.
 *
 * Undocumented endpoint, so it is best-effort: anything unexpected is ignored. What is NOT
 * best-effort is the model-name check, which needs no network and catches the actual mistake.
 */
export async function preflight(cfg: Config, logLine: (s: string) => void): Promise<void> {
  const { provider, model, apiKey, baseUrl } = cfg.ai;
  if (provider !== 'openrouter' || !apiKey) return;

  // 1. Can this model even see? Checked first, because a text-only model is a certain failure and
  //    the message the API gives back ("No endpoints found that support image input") arrives only
  //    after a full run of screenshots has already been taken.
  await requireVision(model, apiKey, baseUrl, logLine);

  // 2. Is the model on the free allowance at all?
  if (!model.endsWith(':free')) {
    logLine(`model "${model}" is paid — the free 50 calls/day do not apply. You need credit, or switch to a ":free" model.`);
  }

  // 3. What is left on the key. Undocumented endpoint, so best-effort.
  try {
    const res = await fetch(`${baseUrl}/key`, { headers: { authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return;
    const d: any = await res.json();
    const k = d?.data ?? d;
    if (!k || typeof k !== 'object') return;
    const bits: string[] = [];
    if (typeof k.usage === 'number') bits.push(`used $${k.usage.toFixed(4)}`);
    if (k.limit === null) bits.push('limit: none');
    else if (typeof k.limit === 'number') bits.push(`limit $${k.limit}`);
    if (typeof k.limit_remaining === 'number') bits.push(`remaining $${k.limit_remaining.toFixed(4)}`);
    if (k.is_free_tier === true) bits.push('free-tier account');
    if (bits.length) logLine(`key OpenRouter: ${bits.join(' · ')}`);
  } catch {
    /* undocumented endpoint; never let it break a run */
  }
}

/**
 * Refuse to start when the chosen model cannot accept images.
 *
 * This tool has exactly one job — look at a screenshot next to a design — so a text-only model is
 * not a degraded run, it is zero coverage. Stopping here costs one small request; finding out from
 * the API costs the whole capture phase first, and the reply ("No endpoints found that support
 * image input") does not say which models WOULD work.
 *
 * If the model list cannot be reached, this only warns: a network hiccup must not block a run.
 */
async function requireVision(model: string, apiKey: string, baseUrl: string, logLine: (s: string) => void): Promise<void> {
  let list: any[];
  try {
    const res = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(String(res.status));
    list = (await res.json())?.data ?? [];
    if (!Array.isArray(list) || !list.length) throw new Error('empty');
  } catch {
    logLine('could not check whether the model accepts images (model list unreachable) — continuing.');
    return;
  }

  const takesImage = (m: any) => (m?.architecture?.input_modalities ?? []).includes('image');
  const mine = list.find((m: any) => m.id === model);

  if (!mine) {
    logLine(`⚠ model "${model}" not found in the OpenRouter list — check the id in .env.`);
    return;
  }
  if (takesImage(mine)) return;

  const options = list
    .filter((m: any) => m.id?.endsWith(':free') && takesImage(m))
    .map((m: any) => m.id)
    .sort();
  throw new Error(
    `model "${model}" does NOT accept images — this tool only compares screenshots to a design, so a text-only model cannot check anything.\n` +
      (options.length
        ? `Free models that accept images (${options.length}):\n` + options.map((id: string) => `  ${id}`).join('\n') + `\n\nSet QA_AI_MODEL in .env and re-run. Full list: npm run models`
        : `No ":free" model currently accepts images — add credit and use a paid vision model. See: npm run models`),
  );
}

/** Errors worth trying again: rate limits, transient server faults, in-flight credit holds. */
function retryable(status: number, body: string): boolean {
  if (status === 429 || status === 408 || status >= 500) return true;
  // OpenRouter returns 402 both for "no credits at all" (hopeless) and for "too many in flight
  // right now" (retry works). Only the second says to retry.
  if (status === 402) return /in-flight|in flight|retry/i.test(body);
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Try a call up to three times with growing pauses.
 *
 * A vision call that fails is not a page with no bugs — but that is exactly how it used to read in
 * the report, so a run whose calls were all rejected looked like a clean site.
 */
async function withRetry<T>(name: string, fn: () => Promise<T>): Promise<T> {
  let last: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fn();
      consecutiveFailures = 0;
      return r;
    } catch (e: any) {
      last = e;
      const msg = String(e?.message ?? '');
      const m = /HTTP (\d{3})/.exec(msg);
      const status = m ? Number(m[1]) : e?.name === 'AbortError' ? 408 : 0;

      // An in-flight wall while we were already sending one at a time is a budget wall, not a
      // scheduling accident: more attempts cannot help, they only spend the daily allowance.
      if (isInFlightWall(msg)) {
        if (maxInflight > 1) {
          maxInflight = 1;
          await sleep(3000);
          continue;
        }
        throw e;
      }

      const again = attempt < 3 && retryable(status, msg);
      if (!again) throw e;
      await sleep(attempt * 4000);
    }
  }
  throw last;
}

/** OpenRouter and OpenAI share the chat/completions shape. */
class OpenAICompatible implements VisionProvider {
  calls = 0;
  failures = 0;
  lastError?: string;
  constructor(readonly name: string, readonly model: string, private apiKey: string, private baseUrl: string) {}
  async complete(msg: VisionMessage, timeoutMs: number): Promise<string> {
    if (stopped) throw new Error(stopped);
    this.calls++;
    try {
      return await gate(() => withRetry(this.name, () => this.once(msg, timeoutMs)));
    } catch (e: any) {
      this.failures++;
      this.lastError ??= explain402(String(e?.message ?? e), this.model).slice(0, 400);
      if (++consecutiveFailures >= GIVE_UP_AFTER && !stopped) {
        stopped = `stopped calling AI after ${GIVE_UP_AFTER} consecutive failures — not spending more quota on calls that will fail. ${this.lastError}`;
      }
      throw e;
    }
  }
  private async once(msg: VisionMessage, timeoutMs: number): Promise<string> {
    const { signal, clear } = withTimeout(timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` };
      if (this.name === 'openrouter') {
        headers['HTTP-Referer'] = 'https://github.com/woogroup/qa-visual';
        headers['X-Title'] = 'qa-visual';
      }
      const body = {
        model: this.model,
        // Zero, not 0.1: with any randomness the same screenshot yields a different bug list each
        // run, which is indistinguishable from the site having changed.
        temperature: 0,
        max_tokens: msg.maxTokens ?? 1800,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: msg.system },
          {
            role: 'user',
            content: [{ type: 'text', text: msg.user }, ...msg.images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.b64}`, detail: 'high' } }))],
          },
        ],
      };
      let res = await fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (!res.ok && res.status === 400) {
        // some models reject response_format; retry without it
        delete (body as any).response_format;
        res = await fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
      }
      if (!res.ok) throw new Error(`${this.name} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json: any = await res.json();
      return json.choices?.[0]?.message?.content ?? '';
    } finally {
      clear();
    }
  }
}

class Anthropic implements VisionProvider {
  calls = 0;
  failures = 0;
  lastError?: string;
  readonly name = 'anthropic';
  constructor(readonly model: string, private apiKey: string, private baseUrl: string) {}
  async complete(msg: VisionMessage, timeoutMs: number): Promise<string> {
    if (stopped) throw new Error(stopped);
    this.calls++;
    try {
      return await gate(() => withRetry(this.name, () => this.once(msg, timeoutMs)));
    } catch (e: any) {
      this.failures++;
      this.lastError ??= String(e?.message ?? e).slice(0, 300);
      if (++consecutiveFailures >= GIVE_UP_AFTER && !stopped) {
        stopped = `stopped calling AI after ${GIVE_UP_AFTER} consecutive failures — not spending more quota on calls that will fail. Error: ${this.lastError}`;
      }
      throw e;
    }
  }
  private async once(msg: VisionMessage, timeoutMs: number): Promise<string> {
    const { signal, clear } = withTimeout(timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        signal,
        body: JSON.stringify({
          model: this.model,
          max_tokens: msg.maxTokens ?? 1800,
          temperature: 0,
          system: msg.system,
          messages: [
            {
              role: 'user',
              content: [...msg.images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.b64 } })), { type: 'text', text: msg.user }],
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json: any = await res.json();
      return (json.content ?? []).map((c: any) => c.text ?? '').join('');
    } finally {
      clear();
    }
  }
}

export function createProvider(cfg: Config): VisionProvider | null {
  const { provider, model, apiKey, baseUrl } = cfg.ai;
  if (provider === 'none') return null;
  if (!apiKey) {
    console.error(`[qa-visual] AI provider "${provider}" selected but no API key found — running rules only.`);
    return null;
  }
  if (provider === 'anthropic') return new Anthropic(model, apiKey, baseUrl);
  return new OpenAICompatible(provider, model, apiKey, baseUrl);
}

/** Extract the first JSON object/array from a model reply (handles ```json fences and prose). */
export function extractJson(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  const start = Math.min(...['{', '['].map((c) => (candidate.indexOf(c) === -1 ? Infinity : candidate.indexOf(c))));
  if (!isFinite(start)) return null;
  const sliced = candidate.slice(start);
  // try progressively shorter tails to survive trailing prose
  for (let end = sliced.length; end > 0; end--) {
    const ch = sliced[end - 1];
    if (ch !== '}' && ch !== ']') continue;
    try {
      return JSON.parse(sliced.slice(0, end));
    } catch {}
  }
  return null;
}
