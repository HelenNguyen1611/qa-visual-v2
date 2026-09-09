import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type AiProvider = 'openrouter' | 'openai' | 'anthropic' | 'none';

/** The three widths every check runs at. Fixed on purpose — fewer knobs, comparable runs. */
export const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;
export type ViewportName = (typeof VIEWPORTS)[number]['name'];

export interface Config {
  url: string;
  /** Figma file/frame link, if the design lives in Figma */
  figma?: string;
  /** Folder of design PNGs (desktop.png / tablet.png / mobile.png), if not using Figma */
  designDir?: string;
  /** Promote this run to the approved baseline after comparing */
  approve: boolean;
  /** Where runs and the approved baseline live */
  stateDir: string;
  ai: { provider: AiProvider; model: string; apiKey: string; baseUrl: string };
  figmaToken: string;
  mask: { mask: string[]; hide: string[] };
  verbose: boolean;
}

function loadDotEnv(dir: string) {
  const p = resolve(dir, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function arg(flags: string[], argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (flags.includes(argv[i])) return argv[i + 1];
    for (const f of flags) if (argv[i].startsWith(f + '=')) return argv[i].slice(f.length + 1);
  }
  return undefined;
}

export const USAGE = `qa-visual <url> [options]

  --figma <link>     Figma file or frame link. Frames are matched to viewports by width.
  --design <folder>  Folder with desktop.png / tablet.png / mobile.png (alternative to --figma)
  --approve          Make this run the approved baseline for future comparisons
  --ai <provider>    openrouter | openai | anthropic | none   (default: from .env, else none)
  --model <id>       Vision model (default: from .env)
  --verbose

Output: reports/<timestamp>/report.html
`;

export function loadConfig(argv: string[], cwd = process.cwd()): Config {
  loadDotEnv(cwd);
  const url = argv.find((a) => /^https?:\/\//i.test(a) && !a.includes('figma.com'));
  if (!url) throw new Error('Missing site URL.\n\n' + USAGE);

  const figma = arg(['--figma'], argv) ?? argv.find((a) => /figma\.com\//.test(a));
  const provider = (arg(['--ai'], argv) ?? process.env.QA_AI_PROVIDER ?? 'none') as AiProvider;

  let apiKey = '';
  let baseUrl = '';
  let defaultModel = '';
  if (provider === 'openrouter') {
    apiKey = process.env.OPENROUTER_API_KEY ?? '';
    baseUrl = 'https://openrouter.ai/api/v1';
    defaultModel = 'google/gemini-3.7-flash';
  } else if (provider === 'openai') {
    apiKey = process.env.OPENAI_API_KEY ?? '';
    baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    defaultModel = 'gpt-4o';
  } else if (provider === 'anthropic') {
    apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    baseUrl = 'https://api.anthropic.com/v1';
    defaultModel = 'claude-sonnet-4-5';
  } else if (provider !== 'none') {
    throw new Error(`Unknown --ai provider: ${provider}`);
  }

  const maskPath = resolve(cwd, 'mask.json');
  const mask = existsSync(maskPath) ? JSON.parse(readFileSync(maskPath, 'utf8')) : { mask: [], hide: [] };

  return {
    url,
    figma,
    designDir: arg(['--design'], argv),
    approve: argv.includes('--approve'),
    stateDir: resolve(cwd, 'reports'),
    ai: { provider, model: arg(['--model'], argv) ?? process.env.QA_AI_MODEL ?? defaultModel, apiKey, baseUrl },
    figmaToken: process.env.FIGMA_TOKEN ?? '',
    mask: { mask: mask.mask ?? [], hide: mask.hide ?? [] },
    verbose: argv.includes('--verbose'),
  };
}

export const log = (...a: unknown[]) => console.error('[qa-visual]', ...a);
