#!/bin/bash
# Double-click này để mở QA Visual. Cửa sổ Terminal cần để mở trong lúc dùng.
cd "$(dirname "$0")"
[ -d dist ] || npm run build
node dist/server.js &
SERVER=$!
sleep 1.5
open "http://127.0.0.1:5173"
echo ""
echo "QA Visual đang chạy. Đóng cửa sổ này (hoặc Ctrl+C) là tắt."
trap "kill $SERVER 2>/dev/null" EXIT
wait $SERVER
