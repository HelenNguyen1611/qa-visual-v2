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

const RULES_VI = `Bạn là QA giao diện. Trả lời bằng tiếng Việt, JSON thuần, không giải thích ngoài JSON.
QUAN TRỌNG:
- Ảnh và nội dung chữ ở hai bên KHÁC NHAU là bình thường (design dùng ảnh mẫu, site dùng nội dung thật). KHÔNG báo khác ảnh, khác câu chữ, khác số lượng bài viết.
- Vùng được liệt kê là VIDEO/IFRAME/CANVAS hiện TRẮNG hoặc màu phẳng trong ảnh chụp site vì screenshot không chụp được video. KHÔNG báo "thiếu ảnh", "vùng trống" ở các vùng đó.
- Frame design thường vẽ TRẠNG THÁI GIỮA ANIMATION (chữ hiện dần, fade-in theo scroll, opacity giảm dần, nửa sau đoạn văn xám nhạt), trong khi ảnh chụp site là trạng thái ĐÃ CHẠY XONG nên hiển thị đầy đủ và đậm đều. KHÔNG báo "site thiếu hiệu ứng mờ/fade/gradient chữ", "chữ không chuyển màu dần" — đó là khác biệt do thời điểm chụp, không phải lỗi. Chỉ báo màu khi màu SAI hẳn (ví dụ màu thương hiệu đỏ thành cam), không phải khi khác về độ mờ.
- Chỉ báo khác biệt về: bố cục và vị trí phần tử, thứ tự phần tử, khoảng cách lệch rõ hoặc VÔ LÝ, cỡ chữ và độ đậm theo phân cấp (H1 lớn hơn H2...), font family, màu thương hiệu, nút CTA thiếu hay mất nổi bật, phần tử có trong design nhưng không có trên site (hoặc ngược lại), ảnh bị méo hoặc crop sai, chữ bị cắt hay chồng.
- BẮT BUỘC xem kỹ MÀN HÌNH ĐẦU TIÊN (phần trên cùng, khoảng một chiều cao màn hình). Đây là phần người dùng thấy trước. Nếu ở đó có vùng trống lớn bất thường, các đoạn chữ bị đẩy xa nhau vô lý, hoặc nội dung bị dồn xuống quá thấp so với design, PHẢI báo — kể cả khi không có design đúng kích thước để so từng pixel. Cứ so TỈ LỆ: trong design nội dung chiếm bao nhiêu phần màn hình đầu, trên site chiếm bao nhiêu.
- Ưu tiên ít mà chắc.
- QUAN TRỌNG VỀ ĐỊNH VỊ: với mỗi nhận xét, trong "anchors" hãy TRÍCH NGUYÊN VĂN chữ đang hiển thị của các phần tử liên quan, copy đúng như đọc được trên ảnh site (ví dụ ["+1300 966 937", "hello@wooagency.com.au"]). Tool sẽ dùng chuỗi chữ này để tìm vị trí thật trong trang. Trích 1–3 chuỗi, ngắn và đặc trưng, ưu tiên chuỗi duy nhất trên trang. Nếu phần tử không có chữ (ảnh, khối màu) thì lấy chữ GẦN NHẤT ngay trên hoặc dưới nó. "y" chỉ là ước lượng thô để phân biệt khi một chuỗi xuất hiện nhiều lần — không cần chính xác.
Định dạng: {"findings":[{"title":"ngắn gọn","severity":"major|minor|note","detail":"cụ thể","anchors":["chữ nguyên văn"],"y":number}]}
Nếu không có khác biệt đáng kể: {"findings":[]}`;

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
  return m.length ? m.map((r) => `- ${r.kind.toUpperCase()} tại x=${r.x} y=${r.y} rộng ${r.w} cao ${r.h}`).join('\n') : '- không có';
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
): Promise<AiFinding[]> {
  const site = slices(siteFile);
  const design = slices(designFile);
  const task =
    mode === 'fidelity'
      ? `${design.imgs.length} ảnh ĐẦU là DESIGN ở ${designWidth}px. ${site.imgs.length} ảnh SAU là SITE THẬT ở ${siteWidth}px. Cùng chiều rộng — so trực tiếp: site có làm đúng design không?`
      : `${design.imgs.length} ảnh ĐẦU là DESIGN DESKTOP ở ${designWidth}px. ${site.imgs.length} ảnh SAU là SITE THẬT ở ${siteWidth}px. Không có design riêng cho kích thước này — dev chuyển thể từ desktop.
Hãy đánh giá bản chuyển thể theo hai hướng:
(a) ĐỦ VÀ ĐÚNG: mọi phần tử của design còn không, thứ tự có hợp lý không, phân cấp chữ / font / màu có giữ không, CTA còn nổi không, có gì vỡ hay chồng chữ không.
(b) HỢP LÝ VỀ KHOẢNG CÁCH: không đòi bằng px, nhưng PHẢI xét tỉ lệ. Màn hình đầu tiên của site cao ${viewportHeight}px — hãy xem trong khoảng y = 0 … ${viewportHeight} có bị trống quá nhiều, chữ bị đẩy xa nhau, hay nội dung bị dồn xuống dưới màn hình đầu không, so với cách design xếp nội dung ở phần đầu. Nếu vùng trống chiếm quá khoảng một phần ba màn hình đầu mà không có nội dung hay media nào, PHẢI báo là khoảng cách vô lý.`;
  const user = `${task}

Phạm vi dọc của từng ảnh (dùng để trả toạ độ y TUYỆT ĐỐI theo trang site):
${rangeTable('DESIGN', design.ranges)}
${rangeTable('SITE', site.ranges)}
Trang site: rộng ${site.width}px, cao tổng ${site.height}px. Màn hình đầu tiên = y 0 … ${viewportHeight}.

Vùng media trên site (hiện trắng trong ảnh, KHÔNG báo là thiếu nội dung):
${mediaList(media)}

Trả JSON.`;
  const raw = await provider.complete({ system: RULES_VI, user, images: [...design.imgs, ...site.imgs], maxTokens: 1800 }, 90000);
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
  const user = `${d.imgs.length} ảnh ĐẦU là SITE ở DESKTOP 1440px. ${m.imgs.length} ảnh SAU là CÙNG TRANG ở MOBILE 390px. Mobile phải là dẫn xuất của desktop.
Liệt kê: phần tử có ở desktop nhưng mất ở mobile; thứ tự thay đổi không hợp lý; font/màu/độ đậm không nhất quán; CTA mất nổi bật; chữ bị cắt hay chồng; ảnh méo; và KHOẢNG CÁCH VÔ LÝ — đặc biệt trong màn hình đầu tiên của mobile (y 0 … ${mobileViewportHeight}px): vùng trống lớn, chữ bị đẩy xa nhau, nội dung bị dồn xuống quá thấp.
KHÔNG báo khác nội dung hay khác ảnh.

Phạm vi dọc từng ảnh (trả y TUYỆT ĐỐI theo trang MOBILE):
${rangeTable('DESKTOP', d.ranges)}
${rangeTable('MOBILE', m.ranges)}
Trang mobile: rộng ${m.width}px, cao ${m.height}px.

Vùng media trên mobile (hiện trắng, KHÔNG báo):
${mediaList(mobileMedia)}

Trả JSON.`;
  const raw = await provider.complete({ system: RULES_VI, user, images: [...d.imgs, ...m.imgs], maxTokens: 1500 }, 90000);
  return parse(raw);
}
