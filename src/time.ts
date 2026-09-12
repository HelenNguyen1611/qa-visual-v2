import { loadDotEnv } from './config.js';

/** IANA zone for Hà Nội. There is no `Asia/Hanoi` in the tz database. */
export const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';

const ALIAS: Record<string, string> = {
  hanoi: DEFAULT_TZ,
  'ha noi': DEFAULT_TZ,
  hn: DEFAULT_TZ,
  vn: DEFAULT_TZ,
  vietnam: DEFAULT_TZ,
  ict: DEFAULT_TZ,
  'asia/hanoi': DEFAULT_TZ,
};

export function resolveTz(raw?: string): string {
  const key = (raw ?? '').trim();
  if (!key) return DEFAULT_TZ;
  const aliased = ALIAS[key.toLowerCase()] ?? key;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: aliased }).format();
    return aliased;
  } catch {
    return DEFAULT_TZ;
  }
}

export function qaTimeZone(): string {
  loadDotEnv();
  return resolveTz(process.env.QA_TZ);
}

function partsInZone(d: Date, tz: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return out;
}

function zoneOffset(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
  const name = fmt.formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const m = name.match(/([+-]\d{2}:\d{2})/);
  if (m) return m[1];
  const m2 = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (m2) return `${m2[1]}${m2[2].padStart(2, '0')}:${m2[3] ?? '00'}`;
  return '+07:00';
}

export interface QaNow {
  /** folder name: 2026-09-12T19-00-26 */
  stamp: string;
  /** ISO with offset: 2026-09-12T19:00:26+07:00 */
  when: string;
}

export function nowQa(d = new Date(), tz = qaTimeZone()): QaNow {
  const p = partsInZone(d, tz);
  const wall = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  return {
    stamp: wall.replace(/:/g, '-'),
    when: `${wall}${zoneOffset(d, tz)}`,
  };
}

/** Clock time in QA_TZ — UTC `Z` from old reports becomes Hà Nội. */
export function formatQaWhen(input: string, tz = qaTimeZone()): string {
  const d = parseWhen(input);
  if (!d) return input.replace('T', ' ').slice(0, 16);
  const p = partsInZone(d, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function parseWhen(input: string): Date | null {
  const s = input.trim();
  if (!s) return null;
  if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const folder = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (folder) {
    const d = new Date(`${folder[1]}T${folder[2]}:${folder[3]}:${folder[4]}${zoneOffset(new Date(), qaTimeZone())}`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
