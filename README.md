# qa-visual v2

Một lệnh. Chụp site ở 3 kích thước, so với design Figma, so với bản đã duyệt, tìm chỗ layout vỡ. Một file HTML.

```bash
qa-visual https://site.com --figma "https://www.figma.com/design/XXXX/Name?node-id=1-2"
```

## Cài đặt (một lần)

```bash
cd qa-visual-v2
npm install          # tự tải Chromium
npm run build
cp .env.example .env # điền FIGMA_TOKEN và API key AI
```

`FIGMA_TOKEN`: Figma → Settings → Security → Personal access tokens → tạo token chỉ cần quyền đọc file.

## Dùng

```bash
# Lần đầu: chụp và tự lưu làm bản duyệt
node dist/cli.js https://woo.example.com --figma "<link>"

# Các lần sau: so với bản duyệt + design
node dist/cli.js https://woo.example.com --figma "<link>"

# Khi thay đổi là chủ ý → chốt lần này làm bản duyệt mới
node dist/cli.js https://woo.example.com --figma "<link>" --approve

# Không có Figma: thư mục ảnh PNG, tên file tuỳ ý — ghép theo chiều rộng pixel
node dist/cli.js https://site.com --design ./design/

# Không dùng AI (vẫn có so bản duyệt, sweep, ảnh hỏng)
node dist/cli.js https://site.com --ai none
```

Kết quả: `.qa-visual/runs/<thời gian>/report.html`. Đường dẫn được in ra dòng cuối.

## Nó làm gì

**Chụp** ở 390 / 768 / 1440. Trước khi chụp: đóng băng animation, cuộn hết trang cho ảnh lazy kịp tải, chờ font, ẩn cookie banner. Đồng thời lập **bản đồ media**: vùng nào là video/iframe/canvas (screenshot không chụp được, hiện trắng), ảnh nào không load, ảnh nào bị méo, ảnh nền CSS nào 404.

**So với design.** Link Figma → tool đọc các frame, ghép với viewport theo chiều rộng frame. Có frame đúng cỡ → **đối chiếu trực tiếp**. Không có (thường chỉ có desktop) → dùng frame lớn nhất, chuyển sang **chế độ chuyển thể**: hỏi AI "bản mobile này có phải chuyển thể hợp lý của design desktop không" — đủ phần tử, đúng thứ tự, giữ phân cấp chữ và màu, CTA còn nổi. AI được dặn rõ: ảnh và chữ khác nhau là bình thường, vùng video hiện trắng không phải lỗi. Thêm một lượt **so desktop với mobile của chính site** để bắt thứ bị mất khi làm responsive.

**So với bản duyệt.** Diff pixel với lần chạy đã `--approve`. Ngưỡng **150 pixel tuyệt đối** — không dùng tỉ lệ, vì tỉ lệ theo diện tích sẽ cho trang mobile cao 3000px lọt lỗi lệch 12px. Vùng video/iframe/canvas được **tự động che** ở cả hai ảnh nên không bao giờ sinh diff. Report chỉ ra dải y có thay đổi.

**Sweep.** Quét từ 1600px xuống 320px, binary-search ra đúng chiều rộng layout bắt đầu tràn ngang. Phủ khoảng giữa các breakpoint — nơi không có design để so.

## Cấu hình duy nhất

`mask.json` — selector của vùng động cần bỏ qua khi so bản duyệt (carousel, marquee, số liệu chạy). Video/iframe/canvas **đã tự phát hiện**, không cần liệt kê.

## Chi phí và thời gian

Chỉ bốn bước không AI: ~10 giây. Thêm AI: cộng 20–60 giây tuỳ model. Với `google/gemini-3.7-flash` qua OpenRouter, một lần chạy đủ 3 viewport khoảng **1 xu Mỹ**.

## Không nằm trong phạm vi bản này

Crawl nhiều trang (chạy lệnh nhiều lần với từng URL), so token/spec theo design system, server lưu baseline nhiều người duyệt, audit Lighthouse. Xem `SCOPE.md`. Bản v1 với Evidence Model đầy đủ nằm trong `qa-visual-archive/` nếu cần quay lại.
