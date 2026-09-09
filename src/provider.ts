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
export function resetAiCircuit() {
  consecutiveFailures = 0;
  stopped = null;
  maxInflight = Math.max(1, Number(process.env.QA_AI_CONCURRENCY ?? 1));
}

/** The provider says its concurrency budget is exhausted — one at a time is the only answer. */
function isInFlightWall(msg: string) {
  return /in_flight_budget|in-flight requests|in flight requests/i.test(msg);
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
      this.lastError ??= String(e?.message ?? e).slice(0, 300);
      if (++consecutiveFailures >= GIVE_UP_AFTER && !stopped) {
        stopped = `đã dừng gọi AI sau ${GIVE_UP_AFTER} lỗi liên tiếp — không tiêu thêm quota vào các lời gọi chắc chắn thất bại. Lỗi: ${this.lastError}`;
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
        stopped = `đã dừng gọi AI sau ${GIVE_UP_AFTER} lỗi liên tiếp — không tiêu thêm quota vào các lời gọi chắc chắn thất bại. Lỗi: ${this.lastError}`;
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
