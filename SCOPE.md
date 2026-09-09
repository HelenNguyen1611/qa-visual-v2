# qa-visual v2 — phạm vi

Một lệnh:  `qa-visual <url> [--figma <link> | --design <folder>] [--approve]`
Ba viewport cố định: 390 / 768 / 1440.
Bốn bước: chụp → so với design → so với lần đã duyệt → quét chỗ vỡ.
Một file kết quả: `report.html`.

Không crawler, không server, không spec, không plugin.
Cấu hình duy nhất ngoài lệnh: `mask.json` (vùng động cần bỏ qua) và `.env` (API key).

Cái gì ngoài bốn bước trên là việc của phiên bản sau.
