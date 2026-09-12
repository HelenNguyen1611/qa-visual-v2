#!/usr/bin/env node
import { loadConfig } from './config.js';

/**
 * List the OpenRouter models that can actually run this tool for free.
 *
 * Two filters, and both matter: the model must accept images (a text-only model cannot compare a
 * screenshot to a design), and its id must end in ":free" — that suffix is what the 50-requests-a-day
 * free allowance applies to. A paid model on a zero balance fails on every request, which is the
 * mistake this command exists to prevent.
 */
async function main() {
  const cfg = loadConfig(['https://example.com', '--ai', 'openrouter']);
  const res = await fetch(process.env.QA_MODELS_URL ?? 'https://openrouter.ai/api/v1/models', {
    headers: cfg.ai.apiKey ? { authorization: `Bearer ${cfg.ai.apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const { data } = (await res.json()) as any;

  const vision = (data ?? []).filter(
    (m: any) => m.id?.endsWith(':free') && (m.architecture?.input_modalities ?? []).includes('image'),
  );
  if (!vision.length) {
    console.log('No ":free" model currently accepts images. OpenRouter’s list changes often — check openrouter.ai/models?q=free.');
    return;
  }
  console.log(`${vision.length} ":free" models that accept images (usable with this tool):\n`);
  const w = Math.max(...vision.map((m: any) => m.id.length));
  for (const m of vision.sort((a: any, b: any) => a.id.localeCompare(b.id))) {
    const ctx = m.context_length ? `${Math.round(m.context_length / 1000)}k ctx` : '';
    console.log(`  ${m.id.padEnd(w)}  ${ctx}`);
  }
  console.log(`\nSet in .env:  QA_AI_MODEL=<id from above>`);
  console.log('Note: the free quota is 20 requests/minute and 50/day; a negative balance blocks :free models too.');
}

main().catch((e) => {
  console.error('[qa-visual] ' + (e?.message ?? e));
  process.exit(1);
});
