#!/bin/bash
# Double-click để mở QA Visual. Giữ cửa sổ Terminal này mở trong lúc dùng.
cd "$(dirname "$0")"
npm run build

node dist/server.js &
SERVER=$!
trap "kill $SERVER 2>/dev/null" EXIT
sleep 1.5
open "http://127.0.0.1:5173"
echo ""
echo "QA Visual đang chạy. Đóng cửa sổ này (hoặc Ctrl+C) là tắt."
echo ""

wait $SERVER
CODE=$?

# Never let a dead server leave a window that still looks fine — that is what shows up in the
# browser as "Failed to fetch" with no explanation anywhere.
echo ""
echo "──────────────────────────────────────────────────────────────"
if [ $CODE -eq 0 ]; then
  echo "  Server đã dừng."
else
  echo "  ⚠ SERVER ĐÃ TẮT (mã lỗi $CODE)."
  echo "  Dòng lỗi cuối cùng ở phía trên là nguyên nhân."
  echo "  Trên browser bạn sẽ thấy \"Failed to fetch\" — đó chỉ là hệ quả."
fi
echo "  Double-click \"QA Visual.command\" để mở lại."
echo "──────────────────────────────────────────────────────────────"
echo ""
read -n 1 -s -r -p "Bấm một phím bất kỳ để đóng cửa sổ..."
