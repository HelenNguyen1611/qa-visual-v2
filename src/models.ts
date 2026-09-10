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
    console.log('Không thấy model ":free" nào nhận ảnh vào lúc này. Danh sách của OpenRouter thay đổi liên tục — kiểm tra lại ở openrouter.ai/models?q=free.');
    return;
  }
  console.log(`${vision.length} model ":free" có nhận ảnh (dùng được cho tool này):\n`);
  const w = Math.max(...vision.map((m: any) => m.id.length));
  for (const m of vision.sort((a: any, b: any) => a.id.localeCompare(b.id))) {
    const ctx = m.context_length ? `${Math.round(m.context_length / 1000)}k ctx` : '';
    console.log(`  ${m.id.padEnd(w)}  ${ctx}`);
  }
  console.log(`\nĐặt vào .env:  QA_AI_MODEL=<id ở trên>`);
  console.log('Lưu ý: hạn mức free là 20 request/phút và 50 request/ngày; số dư âm thì OpenRouter chặn cả model :free.');
}

main().catch((e) => {
  console.error('[qa-visual] ' + (e?.message ?? e));
  process.exit(1);
});
