import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { log } from './config.js';
import { sameGroupedDefect, type GroupedFinding } from './group.js';
import { nowQa } from './time.js';

/**
 * Findings a human has looked at and signed off as intended.
 *
 * Not every deviation is a defect. A hero keeps 570px of empty space because images chase the
 * cursor through it; a divider under the last service was removed on purpose. The tool cannot
 * derive either fact — no measurement distinguishes "left blank deliberately" from "failed to
 * render" — and a report that keeps raising them is a report people stop reading.
 *
 * So the judgement is recorded where judgement belongs: in a file, next to the reason, by name.
 * The finding still appears in the report, greyed out with its reason attached, rather than
 * disappearing — a suppression you cannot see is one nobody re-examines when the page changes.
 */
export interface AcceptedEntry {
  /** short label for talking about it; matching does NOT depend on this */
  id: string;
  title: string;
  anchors?: string[];
  detail?: string;
  /** URLs it was accepted on; empty means every page */
  pages?: string[];
  /** why this is intended — required, because an unexplained suppression is just a hidden bug */
  why: string;
  at: string;
}

export function acceptedJsonPath(cwd = process.cwd()) {
  return resolve(cwd, 'accepted.json');
}

export function readAccepted(cwd = process.cwd()): AcceptedEntry[] {
  const p = acceptedJsonPath(cwd);
  if (!existsSync(p)) return [];
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    const arr = Array.isArray(d) ? d : d.accepted;
    return Array.isArray(arr) ? arr.filter((x: any) => typeof x?.title === 'string' && typeof x?.why === 'string') : [];
  } catch (e: any) {
    log(`accepted.json không đọc được: ${e?.message ?? e}`);
    return [];
  }
}

export function writeAccepted(entries: AcceptedEntry[], cwd = process.cwd()) {
  const body = {
    _: 'Những lỗi đã được người xem xác nhận là cố ý. Vẫn hiện trong báo cáo nhưng làm mờ, không tính vào số lỗi. Thêm bằng: qa-visual accept <số lỗi> "lý do".',
    accepted: entries,
  };
  writeFileSync(acceptedJsonPath(cwd), JSON.stringify(body, null, 2));
}

/** Short, readable, and stable for a given title+anchor set — a label, never the match key. */
export function shortId(g: Pick<GroupedFinding, 'title' | 'anchors'>): string {
  const seed = g.title + '|' + (g.anchors ?? []).slice(0, 2).join('~');
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(7, '0').slice(0, 7);
}

/**
 * Sign a finding off (or take the sign-off back) in both places that matter: the finding itself,
 * so this report's HTML can grey it out, and accepted.json, so the next run of the same defect
 * does not come back as a fresh bug.
 */
export function markFindingAccepted(finding: GroupedFinding, why: string | null): void {
  const entries = readAccepted();
  const id = shortId(finding);
  const trimmed = why?.trim() ?? '';
  if (!trimmed) {
    writeAccepted(entries.filter((e) => e.id !== id));
    finding.accepted = false;
    finding.acceptedWhy = undefined;
    return;
  }
  finding.accepted = true;
  finding.acceptedWhy = trimmed;
  const entry: AcceptedEntry = {
    id,
    title: finding.title,
    anchors: finding.anchors,
    detail: finding.detail,
    pages: finding.pages,
    why: trimmed,
    at: nowQa().when.slice(0, 10),
  };
  const i = entries.findIndex((e) => e.id === id);
  if (i >= 0) entries[i] = { ...entries[i], ...entry };
  else entries.push(entry);
  writeAccepted(entries);
}

export function findingByNum(report: { findings?: GroupedFinding[] }, num: number): GroupedFinding | undefined {
  return (report.findings ?? []).find((x) => x.num === num);
}

/**
 * Mark the findings a human has already signed off.
 *
 * Page scoping is deliberate: an entry accepted on the homepage hero must not silence the same
 * wording appearing on a page nobody has looked at yet. An entry with no pages accepts everywhere,
 * which is what you want for a header or footer.
 */
export function applyAccepted(findings: GroupedFinding[], entries: AcceptedEntry[]): number {
  let n = 0;
  for (const g of findings) {
    const hit = entries.find(
      (e) =>
        sameGroupedDefect(g, { title: e.title, detail: e.detail ?? '', anchors: e.anchors }) &&
        (!e.pages?.length || g.pages.some((p) => e.pages!.includes(p))),
    );
    if (!hit) continue;
    g.accepted = true;
    g.acceptedWhy = hit.why;
    n++;
  }
  return n;
}
