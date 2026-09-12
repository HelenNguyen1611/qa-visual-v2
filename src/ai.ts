import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import type { VisionProvider } from './provider.js';
import { extractJson } from './provider.js';
import type { MediaRegion } from './browser.js';
import type { AiFinding } from './report.js';

/**
 * The question AI is good at: "here is the reference, here is the build — what differs?"
 * (Not "look at this page and find bugs" — that has no reference and fails, as v1 showed.)
 */

const RULES_EN = `You are a visual QA reviewer. Reply in English, raw JSON only, no prose outside JSON.
IMPORTANT:
- Different photos and copy on the two sides is normal (design uses placeholder art, the site uses real content). Do NOT report different images, different sentences, or a different number of articles.
- Listed VIDEO/IFRAME/CANVAS regions look WHITE or flat in the site screenshot because a screenshot cannot capture video. Do NOT report "missing image" or "empty area" there.
- The design frame often shows a MID-ANIMATION state (text fading in on scroll, reduced opacity, the second half of a paragraph in light grey), while the site screenshot is the FINISHED state — fully visible and evenly bold. Do NOT report "site missing fade/gradient text" — that is a capture-timing difference, not a bug. Only report colour when it is WRONG (e.g. brand red became orange), not when only opacity differs.
- Only report: layout and element position, element order, spacing that is clearly off or ABSURD, type size and weight hierarchy (H1 larger than H2…), font family, brand colour, missing or unemphasised CTAs, an element in the design but not on the site (or the reverse), stretched or wrongly cropped images, clipped or overlapping text.
- You MUST inspect the FIRST SCREEN (the top, about one viewport tall). That is what visitors see first. If it has an unusually large empty band, text pushed absurdly far apart, or content shoved too far down compared with the design, you MUST report it — even when there is no same-width design to compare pixel-for-pixel. Compare RATIOS: how much of the first screen the design fills vs the site.
- Prefer few, high-confidence findings.
- WRITE FOR A DESIGNER. title: one short sentence naming the element and what is wrong (e.g. “Our mission” sits at the bottom of the banner). Do not write jargon: inset, gutter, container, wrapper, overlay, DOM, viewport, measured.
- detail: exactly two lines, nothing else:
  Design: <where it is in the design>
  Live: <where it is on the site>
  Do not explain how you know. Do not mention measurement, screenshots, or the model.
- LOCATION: for each finding, put VERBATIM on-screen text of the related elements in "anchors", copied as read on the site image (e.g. ["+1300 966 937", "hello@wooagency.com.au"]). The tool uses those strings to find the real box. Quote 1–3 short distinctive strings, preferably unique on the page. If the element has no text (image, colour block), take the NEAREST text above or below it. "y" is only a rough hint when a string appears more than once — it does not need to be exact.
Format: {"findings":[{"title":"short","severity":"major|minor|note","detail":"Design: …\\nLive: …","anchors":["verbatim text"],"y":number}]}
If nothing significant differs: {"findings":[]}

LANGUAGE — REQUIRED: "title" and "detail" MUST be in ENGLISH. Do not use Vietnamese, Spanish, Chinese, or any other language. "anchors" stay VERBATIM from the screenshot — do not translate them.`;

const MAX_SLICE = 2400;

/** Cut a tall PNG into ≤2400px slices; a 7000px page sent whole gets downscaled to nothing. */
function slices(file: string): { imgs: Array<{ b64: string; mime: 'image/png' }>; ranges: Array<{ from: number; to: number }>; width: number; height: number } {
  const png = PNG.sync.read(readFileSync(file));
  if (png.height <= MAX_SLICE) {
    return { imgs: [{ b64: readFileSync(file).toString('base64'), mime: 'image/png' }], ranges: [{ from: 0, to: png.height }], width: png.width, height: png.height };
  }
  const imgs: Array<{ b64: string; mime: 'image/png' }> = [];
  const ranges: Array<{ from: number; to: number }> = [];
  for (let y = 0; y < png.height && imgs.length < 4; y += MAX_SLICE) {
    const h = Math.min(MAX_SLICE, png.height - y);
    const part = new PNG({ width: png.width, height: h });
    png.data.copy(part.data, 0, y * png.width * 4, (y + h) * png.width * 4);
    imgs.push({ b64: PNG.sync.write(part).toString('base64'), mime: 'image/png' });
    ranges.push({ from: y, to: y + h });
  }
  return { imgs, ranges, width: png.width, height: png.height };
}

/** Spell out which vertical slice of the page each image covers, so the model can answer in absolute page coordinates. */
function rangeTable(label: string, r: Array<{ from: number; to: number }>) {
  return r.map((x, i) => `  ${label} ${i + 1}: y = ${x.from} … ${x.to}`).join('\n');
}

function mediaList(media: MediaRegion[]) {
  const m = media.filter((r) => r.kind === 'video' || r.kind === 'iframe' || r.kind === 'canvas');
  return m.length ? m.map((r) => `- ${r.kind.toUpperCase()} at x=${r.x} y=${r.y} w=${r.w} h=${r.h}`).join('\n') : '- none';
}

/**
 * Did the model answer in English, as instructed?
 *
 * Small models routinely ignore a language rule buried in a long prompt — one run came back in
 * Spanish. The findings were probably still correct, so throwing them away would be worse than
 * keeping them; what matters is that the report says the model disobeyed, instead of leaving the
 * person to work out why their report is suddenly in another language.
 *
 * The test is the Vietnamese-only letters (ăâđêôơư and the tone marks). Any real sentence in
 * Vietnamese has several; English and Spanish have none. Short strings are not judged — a title
 * can legitimately be all ASCII ("Logo CTA sai") — so only long text counts as evidence.
 */
/*
 * Only letters Vietnamese has and Spanish / French / Portuguese / Italian do NOT.
 *
 * The obvious set (à á â è é ê ì í ò ó ô ù ú) is useless here: Spanish "El menú de navegación"
 * matches it, so the first version of this check called that sentence Vietnamese. What no other
 * Latin-script language uses is ă ơ ư đ, the dot-below vowels, and the hook-above vowels.
 */
const VI_LETTERS =
  /[ăơưĂƠƯđĐạặậẹệịọộợụựỵẠẶẬẸỆỊỌỘỢỤỰỴảẳẩẻểỉỏổởủửỷẢẲẨẺỂỈỎỔỞỦỬỶẫẵễỗỡữẽĩỹẪẴỄỖỠỮẼĨỹ]/;

export function looksNonEnglish(f: { title: string; detail: string }): boolean {
  const text = `${f.title} ${f.detail}`.trim();
  return text.length >= 40 && VI_LETTERS.test(text);
}

function parse(raw: string): AiFinding[] {
  const j = extractJson(raw);
  const list: any[] = Array.isArray(j) ? j : Array.isArray(j?.findings) ? j.findings : [];
  return list
    .filter((f) => f && typeof f.title === 'string')
    .map((f) => ({
      title: String(f.title).slice(0, 140),
      severity: (['major', 'minor', 'note'].includes(f.severity) ? f.severity : 'minor') as AiFinding['severity'],
      detail: String(f.detail ?? '').slice(0, 500),
      y: Number.isFinite(Number(f.y)) ? Number(f.y) : undefined,
      anchors: Array.isArray(f.anchors) ? f.anchors.filter((a: any) => typeof a === 'string' && a.trim().length > 1).slice(0, 3) : undefined,
    }))
    .slice(0, 15);
}

export async function compareWithDesign(
  provider: VisionProvider,
  siteFile: string,
  designFile: string,
  mode: 'fidelity' | 'adaptation',
  siteWidth: number,
  designWidth: number,
  viewportHeight: number,
  media: MediaRegion[],
  skipBands: Array<{ from: number; to: number; where: string }> = [],
): Promise<AiFinding[]> {
  const site = slices(siteFile);
  const design = slices(designFile);
  const task =
    mode === 'fidelity'
      ? `The FIRST ${design.imgs.length} image(s) are the DESIGN at ${designWidth}px. The NEXT ${site.imgs.length} image(s) are the LIVE SITE at ${siteWidth}px. Same width — compare directly: does the site match the design?`
      : `The FIRST ${design.imgs.length} image(s) are the DESKTOP DESIGN at ${designWidth}px. The NEXT ${site.imgs.length} image(s) are the LIVE SITE at ${siteWidth}px. There is no dedicated design for this width — the developer adapted from desktop.
Judge the adaptation in two ways:
(a) COMPLETE AND CORRECT: are all design elements still there, is the order sensible, are type / font / colour hierarchy kept, is the CTA still prominent, is anything broken or overlapping?
(b) SENSIBLE SPACING: do not demand matching pixels, but you MUST judge ratios. The site first screen is ${viewportHeight}px tall — look at y = 0 … ${viewportHeight} for too much empty space, text pushed far apart, or content shoved below the fold compared with how the design packs the top. If an empty band covers more than about a third of the first screen with no content or media, you MUST report it as absurd spacing.`;
  const user = `${task}

Vertical range of each image (return ABSOLUTE y on the site page):
${rangeTable('DESIGN', design.ranges)}
${rangeTable('SITE', site.ranges)}
Site page: ${site.width}px wide, ${site.height}px tall. First screen = y 0 … ${viewportHeight}.

Media regions on the site (white in the shot — do NOT report as missing content):
${mediaList(media)}
${skipBands.length ? `\nAlready reviewed on another page (shared header/footer) — SKIP, do not report inside:\n${skipBands.map((b) => `- y = ${b.from} … ${b.to} (${b.where === 'top' ? 'header' : 'footer'})`).join('\n')}` : ''}

Return JSON. "title" and "detail" in ENGLISH (anchors stay verbatim, do not translate).`;
  const raw = await provider.complete({ system: RULES_EN, user, images: [...design.imgs, ...site.imgs], maxTokens: 1800 }, 90000);
  return parse(raw);
}

/** Desktop vs mobile of the same site — no design needed. Catches things lost or changed in the responsive build. */
export async function compareSelf(
  provider: VisionProvider,
  desktopFile: string,
  mobileFile: string,
  mobileViewportHeight: number,
  mobileMedia: MediaRegion[],
): Promise<AiFinding[]> {
  const d = slices(desktopFile);
  const m = slices(mobileFile);
  const user = `The FIRST ${d.imgs.length} image(s) are the SITE at DESKTOP 1440px. The NEXT ${m.imgs.length} image(s) are the SAME PAGE at MOBILE 390px. Mobile must be a derivative of desktop.
List: elements present on desktop but missing on mobile; order that no longer makes sense; inconsistent font/colour/weight; CTA that lost emphasis; clipped or overlapping text; stretched images; and ABSURD SPACING — especially on the mobile first screen (y 0 … ${mobileViewportHeight}px): large empty bands, text pushed far apart, content shoved too far down.
Do NOT report different copy or different photos.

Vertical range of each image (return ABSOLUTE y on the MOBILE page):
${rangeTable('DESKTOP', d.ranges)}
${rangeTable('MOBILE', m.ranges)}
Mobile page: ${m.width}px wide, ${m.height}px tall.

Media regions on mobile (white in the shot — do NOT report):
${mediaList(mobileMedia)}

Return JSON. "title" and "detail" in ENGLISH (anchors stay verbatim, do not translate).`;
  const raw = await provider.complete({ system: RULES_EN, user, images: [...d.imgs, ...m.imgs], maxTokens: 1500 }, 90000);
  return parse(raw);
}
