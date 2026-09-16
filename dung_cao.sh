#!/bin/sh
# dung_cao.sh — Dừng SẠCH mọi thứ liên quan đến cào trên máy này.
#
#   sh dung_cao.sh            # dừng worker + vòng lặp
#   sh dung_cao.sh --ca-chrome  # dừng luôn Chrome cào
#
# VÌ SAO CẦN: giết worker mà quên giết vòng lặp chay_lien_tuc.sh thì vòng lặp
# lập tức bật worker mới. Đã mất nhiều giờ vì chuyện này — 19 vòng lặp tích tụ,
# mỗi lần "tắt hết worker" chúng lại đẻ ra lứa mới, sinh hàng chục tab
# PartSouq khiến Cloudflare chặn và Chrome cạn tài nguyên. Triệu chứng trông
# y hệt lỗi Chrome/Playwright nên rất dễ chẩn đoán nhầm.
#
# THỨ TỰ BẮT BUỘC: vòng lặp TRƯỚC, worker SAU. Ngược lại là vô ích.

echo "1. Dừng vòng lặp chay_lien_tuc.sh..."
n=0
for p in $(ps -ef 2>/dev/null | grep 'chay_lien_tuc' | grep -v grep | awk '{print $2}'); do
  kill -9 "$p" 2>/dev/null && n=$((n+1))
done
echo "   -> $n vòng lặp"
sleep 2

echo "2. Dừng worker node..."
n=0
for p in $(ps -ef 2>/dev/null | grep -E 'worker_(substitutes|jnbk|xe)\.mjs' | grep -v grep | awk '{print $2}'); do
  kill -9 "$p" 2>/dev/null && n=$((n+1))
done
echo "   -> $n worker"
sleep 2

# Vòng lặp có thể đang trong sleep, chết muộn rồi kịp đẻ thêm worker -> quét lại
for p in $(ps -ef 2>/dev/null | grep -E 'chay_lien_tuc|worker_(substitutes|jnbk|xe)\.mjs' | grep -v grep | awk '{print $2}'); do
  kill -9 "$p" 2>/dev/null
done

rm -f "${TMPDIR:-/tmp}"/cao_*.pid 2>/dev/null

if [ "$1" = "--ca-chrome" ]; then
  echo "3. Đóng Chrome cào (profile chrome-cao*)..."
  powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*chrome-cao*' -or \$_.CommandLine -like '*remote-debugging-port*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null
  sleep 3
fi

con=$(ps -ef 2>/dev/null | grep -E 'chay_lien_tuc|worker_(substitutes|jnbk|xe)\.mjs' | grep -v grep | wc -l)
echo ""
echo "Còn lại: $con tiến trình cào"
[ "$con" -eq 0 ] && echo "Đã sạch." || echo "⚠ Vẫn còn — chạy lại script này."
