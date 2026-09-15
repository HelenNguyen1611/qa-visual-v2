import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BASIS, findingBasis, type FindingBasis } from './finding-copy.js';

/**
 * How much of a report a human already rejected, by basis.
 *
 * accepted.json is the label set. A design-tier row whose false-positive rate stays high after
 * a change is the change that did not work. A page-tier row that climbs is a change that broke
 * a check that used to be believed.
 */
export interface PrecisionRow {
  basis: FindingBasis;
  open: number;
  signedOff: number;
  total: number;
  /** signed-off / total — 0 when the tier is empty */
  falsePositiveRate: number;
}

export function precisionFromReport(
  findings: Array<{ accepted?: boolean; measured?: boolean; locatedHow?: string }>,
): PrecisionRow[] {
  const bases: FindingBasis[] = ['page', 'design', 'ai'];
  return bases.map((basis) => {
    const rows = findings.filter((f) => findingBasis(f) === basis);
    const signedOff = rows.filter((f) => f.accepted).length;
    const open = rows.length - signedOff;
    return {
      basis,
      open,
      signedOff,
      total: rows.length,
      falsePositiveRate: rows.length ? signedOff / rows.length : 0,
    };
  });
}

export function formatPrecision(rows: PrecisionRow[]): string {
  const line = (r: PrecisionRow) =>
    `${BASIS[r.basis].short.padEnd(6)} ${String(r.open).padStart(3)} open  ${String(r.signedOff).padStart(3)} signed off  ${
      r.total ? `${Math.round(r.falsePositiveRate * 100)}% rejected by a reviewer` : '—'
    }`;
  return ['basis    open  signed-off  reviewer-reject', ...rows.map(line)].join('\n');
}

export function latestReportStamp(reportsDir = resolve(process.cwd(), 'reports')): string | null {
  if (!existsSync(reportsDir)) return null;
  const stamps = readdirSync(reportsDir)
    .filter((d) => /^\d{4}-/.test(d) && existsSync(join(reportsDir, d, 'report.json')))
    .sort();
  return stamps[stamps.length - 1] ?? null;
}

export function loadReportFindings(stamp: string, reportsDir = resolve(process.cwd(), 'reports')): Array<{
  accepted?: boolean;
  measured?: boolean;
  locatedHow?: string;
  title?: string;
}> {
  const r = JSON.parse(readFileSync(join(reportsDir, stamp, 'report.json'), 'utf8'));
  return Array.isArray(r.findings) ? r.findings : [];
}
