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
  complete(msg: VisionMessage, timeoutMs: number): Promise<string>;
}

function withTimeout(ms: number) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

/** OpenRouter and OpenAI share the chat/completions shape. */
class OpenAICompatible implements VisionProvider {
  calls = 0;
  constructor(readonly name: string, readonly model: string, private apiKey: string, private baseUrl: string) {}
  async complete(msg: VisionMessage, timeoutMs: number): Promise<string> {
    this.calls++;
    const { signal, clear } = withTimeout(timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` };
      if (this.name === 'openrouter') {
        headers['HTTP-Referer'] = 'https://github.com/woogroup/qa-visual';
        headers['X-Title'] = 'qa-visual';
      }
      const body = {
        model: this.model,
        temperature: 0.1,
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
  readonly name = 'anthropic';
  constructor(readonly model: string, private apiKey: string, private baseUrl: string) {}
  async complete(msg: VisionMessage, timeoutMs: number): Promise<string> {
    this.calls++;
    const { signal, clear } = withTimeout(timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        signal,
        body: JSON.stringify({
          model: this.model,
          max_tokens: msg.maxTokens ?? 1800,
          temperature: 0.1,
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
