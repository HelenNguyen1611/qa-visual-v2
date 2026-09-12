import type { VisionProvider } from '../provider.js';
import { extractJson } from '../provider.js';
import type { Candidate, JudgeVerdict, ParseStatus } from './candidate.js';

const SYSTEM = `QA. Chỉ đánh giá candidate đã đo. Cấm bịa số/locator. Không ảnh.
JSON: {"verdicts":[{"id":"","verdict":"valid|rejected|uncertain","reason":"một câu Việt"}]}
valid = lỗi UI thật. rejected = nhiễu/chủ ý (gap 0, carousel). Không thêm id.`;

export interface JudgeResult {
  verdict: JudgeVerdict;
  reason: string;
  parseStatus: ParseStatus;
  /** id the model wrote, if any */
  modelId?: string;
}

export interface JudgeBatchAudit {
  rawReply: string;
  truncated: boolean;
  parseFailure: boolean;
  extraIds: string[];
  results: JudgeResult[];
}

/** Top-ranked per viewport. One text call per viewport instead of one vision call per candidate. */
export const MAX_JUDGE_PER_PAGE = 12;

function asVerdict(v: unknown): JudgeVerdict | undefined {
  return v === 'valid' || v === 'rejected' || v === 'uncertain' ? v : undefined;
}

export function evidenceText(c: Candidate): string {
  const e = c.evidence;
  return [
    `id: ${c.id}`,
    `kind: ${c.kind}`,
    `locator: ${c.locator}`,
    `value: ${e.value} · median ${e.groupMedian} · Δ ${e.delta}`,
    `how: ${e.howGrouped}`,
    `summary: ${c.summary}`,
  ].join('\n');
}

function rowsFrom(parsed: unknown): Array<{ id?: string; verdict?: string; reason?: string }> {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  const o = parsed as { verdicts?: unknown; id?: string };
  if (Array.isArray(o.verdicts)) return o.verdicts as Array<{ id?: string; verdict?: string; reason?: string }>;
  if (o.id) return [o as { id?: string; verdict?: string; reason?: string }];
  return [];
}

/** Pull complete verdict objects out of a cut wrapper. Does not invent ids or remap by index. */
export function salvageVerdictRows(raw: string): Array<{ id: string; verdict: string; reason: string }> {
  const out: Array<{ id: string; verdict: string; reason: string }> = [];
  const re =
    /"id"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"verdict"\s*:\s*"(valid|rejected|uncertain)"\s*,\s*"reason"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    out.push({
      id: JSON.parse(`"${m[1]}"`),
      verdict: m[2],
      reason: JSON.parse(`"${m[3]}"`),
    });
  }
  return out;
}

/** Unbalanced braces / cut-off tail — not a policy signal. */
export function looksTruncated(raw: string): boolean {
  const t = raw.trim();
  if (!t) return true;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (const ch of t) {
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
  }
  if (inStr || depth > 0) return true;
  return /[,:]\s*$/.test(t) || /"(valid|rejected|uncertain|reason|id)"\s*$/.test(t);
}

function normId(id: string): string {
  return id.trim();
}

/**
 * Map a model reply onto the input list. Does not invent a verdict by index.
 * Missing / extra ids are labeled, not remapped.
 */
export function parseBatchAudit(raw: string, ids: string[]): JudgeBatchAudit {
  const wanted = ids.map(normId);
  const parsed = extractJson(raw);
  const truncated = looksTruncated(raw);
  const empty = !raw.trim();
  const salvaged = salvageVerdictRows(raw);
  let rows = rowsFrom(parsed);
  if (!rows.length) rows = salvaged;
  else if (truncated) {
    const have = new Set(rows.map((r) => normId(String(r.id ?? ''))));
    for (const s of salvaged) {
      if (!have.has(normId(s.id))) rows.push(s);
    }
  }
  const parseFailure = parsed == null && !empty && !truncated && !salvaged.length;

  const byId = new Map<string, { verdict?: string; reason?: string; modelId: string }>();
  const extraIds: string[] = [];
  const wantedSet = new Set(wanted);

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const modelId = normId(String(row.id ?? ''));
    if (!modelId) continue;
    if (!wantedSet.has(modelId)) {
      extraIds.push(modelId);
      continue;
    }
    byId.set(modelId, { verdict: row.verdict, reason: row.reason, modelId });
  }

  const results: JudgeResult[] = wanted.map((id) => {
    if (!byId.size && parsed == null && !salvaged.length) {
      return {
        verdict: 'uncertain',
        reason: parseFailure ? 'không parse được JSON từ model' : empty ? 'model trả rỗng' : 'JSON bị cắt',
        parseStatus: parseFailure ? 'parse-failure' : 'truncated',
      };
    }
    const hit = byId.get(id);
    if (!hit) {
      if (truncated) {
        return { verdict: 'uncertain', reason: 'JSON bị cắt, thiếu id này', parseStatus: 'truncated' };
      }
      if (extraIds.length) {
        return {
          verdict: 'uncertain',
          reason: `model trả id khác, không khớp ${id}`,
          parseStatus: 'id-mismatch',
        };
      }
      return { verdict: 'uncertain', reason: 'model không trả id này', parseStatus: 'id-missing' };
    }
    const v = asVerdict(hit.verdict);
    const reason = String(hit.reason ?? '').slice(0, 240);
    if (!v) {
      return {
        verdict: 'uncertain',
        reason: String(hit.reason ?? hit.verdict ?? 'verdict không phải valid|rejected|uncertain').slice(0, 240),
        parseStatus: truncated ? 'truncated' : 'uncertain-model',
        modelId: hit.modelId,
      };
    }
    if (truncated) {
      return { verdict: v, reason, parseStatus: 'truncated', modelId: hit.modelId };
    }
    if (v === 'uncertain') {
      return { verdict: 'uncertain', reason, parseStatus: 'uncertain-model', modelId: hit.modelId };
    }
    return { verdict: v, reason, parseStatus: 'ok', modelId: hit.modelId };
  });

  return { rawReply: raw, truncated, parseFailure, extraIds, results };
}

/** @deprecated thin wrapper — prefer parseBatchAudit for parseStatus. */
export function parseBatch(raw: string, ids: string[]): JudgeResult[] {
  return parseBatchAudit(raw, ids).results;
}

/**
 * One text-only call for a small batch. No screenshots — numbers are already measured.
 * Prompt/criteria unchanged. maxTokens sized so the JSON list is unlikely to be cut.
 */
export async function judgeBatch(provider: VisionProvider, candidates: Candidate[]): Promise<JudgeResult[]> {
  const audit = await judgeBatchAudit(provider, candidates);
  return audit.results;
}

export async function judgeBatchAudit(provider: VisionProvider, candidates: Candidate[]): Promise<JudgeBatchAudit> {
  if (!candidates.length) {
    return { rawReply: '', truncated: false, parseFailure: false, extraIds: [], results: [] };
  }
  const raw = await provider.complete(
    {
      system: SYSTEM,
      user:
        `Đánh giá ${candidates.length} candidate. Không invent geometry. Không thêm id.\n\n` +
        candidates.map((c, i) => `--- ${i + 1} ---\n${evidenceText(c)}`).join('\n\n'),
      images: [],
      maxTokens: 220 * candidates.length + 160,
    },
    30000,
  );
  return parseBatchAudit(raw, candidates.map((c) => c.id));
}

/** @deprecated one-at-a-time vision judge — kept for a single leftover caller; prefers judgeBatch. */
export async function judgeCandidate(provider: VisionProvider, c: Candidate): Promise<JudgeResult> {
  const [r] = await judgeBatch(provider, [c]);
  return r;
}
