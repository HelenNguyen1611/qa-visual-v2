import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import type { VisionProvider } from './provider.js';
import { extractJson } from './provider.js';
import type { MediaRegion } from './browser.js';
import type { AiFinding } from './report.js';

/**
 * The question AI is good at: "here is the reference, here is the build — what differs?"
 * (Not "look at this page and find bugs" — that has no reference and fails, as v1 showed.)
 */

const RULES_VI = `QA giao diện. JSON thuần. title/detail TIẾNG VIỆT. anchors giữ nguyên văn trên ảnh.
Không báo: khác ảnh/chữ/số bài; vùng video/iframe/canvas trắng; khác fade/opacity do animation.
Chỉ báo: lệch bố cục/thứ tự, khoảng cách vô lý, hierarchy chữ, font, màu thương hiệu sai, CTA yếu/mất, thiếu/thừa element, ảnh méo, chữ cắt/chồng.
Ưu tiên màn hình đầu. Ít mà chắc.
Mỗi finding: 1–3 anchors chữ ngắn, đặc trưng; y ước lượng. {"findings":[{"title":"","severity":"major|minor|note","detail":"","anchors":[""],"y":0}]} hoặc {"findings":[]}`;

const MAX_SLICE = 2400;
const MAX_IMGS = 4;
/** JPEG quality for the model only — report screenshots stay PNG. */
const JPEG_QUALITY = 45;

function toJpeg(png: PNG): { b64: string; mime: 'image/jpeg' } {
  const { data } = jpeg.encode({ data: png.data, width: png.width, height: png.height }, JPEG_QUALITY);
  return { b64: Buffer.from(data).toString('base64'), mime: 'image/jpeg' };
}

/** Same 4 × native-width slices as before; JPEG so the payload is smaller. */
function slices(file: string): { imgs: Array<{ b64: string; mime: 'image/jpeg' }>; ranges: Array<{ from: number; to: number }>; width: number; height: number } {
  const png = PNG.sync.read(readFileSync(file));
  const imgs: Array<{ b64: string; mime: 'image/jpeg' }> = [];
  const ranges: Array<{ from: number; to: number }> = [];
  for (let y = 0; y < png.height && imgs.length < MAX_IMGS; y += MAX_SLICE) {
    const h = Math.min(MAX_SLICE, png.height - y);
    const part = new PNG({ width: png.width, height: h });
    png.data.copy(part.data, 0, y * png.width * 4, (y + h) * png.width * 4);
    imgs.push(toJpeg(part));
    ranges.push({ from: y, to: y + h });
  }
  return { imgs, ranges, width: png.width, height: png.height };
}

/** Spell out which vertical slice of the page each image covers, so the model can answer in absolute page coordinates. */
function rangeTable(label: string, r: Array<{ from: number; to: number }>) {
  return r.map((x, i) => `  ${label} ${i + 1}: y = ${x.from} … ${x.to}`).join('\n');
}

function mediaList(media: MediaRegion[]) {
  const m = media.filter((r) => r.kind === 'video' || r.kind === 'iframe' || r.kind === 'canvas').slice(0, 8);
  return m.length ? m.map((r) => `- ${r.kind} ${r.x},${r.y} ${r.w}x${r.h}`).join('\n') : '- không';
}

/**
 * Did the model answer in Vietnamese, as instructed?
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

export function looksNonVietnamese(f: { title: string; detail: string }): boolean {
  const text = `${f.title} ${f.detail}`.trim();
  return text.length >= 40 && !VI_LETTERS.test(text);
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
      ? `${design.imgs.length} ảnh ĐẦU = DESIGN ${designWidth}px. ${site.imgs.length} ảnh SAU = SITE ${siteWidth}px. So trực tiếp.`
      : `${design.imgs.length} ảnh ĐẦU = DESIGN desktop ${designWidth}px. ${site.imgs.length} ảnh SAU = SITE ${siteWidth}px (không có design riêng). Kiểm tra chuyển thể: đủ element/thứ tự/hierarchy/CTA; khoảng trống vô lý ở y 0…${viewportHeight}.`;
  const user = `${task}
y tuyệt đối: ${rangeTable('DESIGN', design.ranges)} ${rangeTable('SITE', site.ranges)}
Site ${site.width}×${site.height}. Màn hình đầu y 0…${viewportHeight}.
Media trắng (đừng báo thiếu):
${mediaList(media)}
${skipBands.length ? `Đã kiểm (bỏ qua): ${skipBands.map((b) => `${b.where} ${b.from}–${b.to}`).join('; ')}` : ''}
JSON, tiếng Việt.`;
  const raw = await provider.complete({ system: RULES_VI, user, images: [...design.imgs, ...site.imgs], maxTokens: 900 }, 90000);
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
  const user = `${d.imgs.length} ảnh ĐẦU = desktop 1440. ${m.imgs.length} ảnh SAU = mobile 390 cùng trang.
Báo: mất element, thứ tự sai, font/màu/CTA, chữ cắt/chồng, ảnh méo, trống vô lý y 0…${mobileViewportHeight}. Không báo khác nội dung/ảnh.
y mobile: ${rangeTable('DESKTOP', d.ranges)} ${rangeTable('MOBILE', m.ranges)}
Mobile ${m.width}×${m.height}. Media trắng: ${mediaList(mobileMedia)}
JSON, tiếng Việt.`;
  const raw = await provider.complete({ system: RULES_VI, user, images: [...d.imgs, ...m.imgs], maxTokens: 800 }, 90000);
  return parse(raw);
}
