#!/bin/sh
# Chạy worker liên tục: worker chết vì bất kỳ lý do gì (Chrome đóng, mạng rớt,
# server reload) thì tự bật lại. Chỉ dừng hẳn khi bị kill hoặc chết liên tiếp.
#
#   sh chay_lien_tuc.sh worker_substitutes.mjs local-server-1
#   sh chay_lien_tuc.sh worker_jnbk.mjs jnbk-1 http://127.0.0.1:3001 --tabs 2 --delay 1500
#
# Tham số từ thứ 4 trở đi truyền thẳng cho worker (--tabs, --delay, --batch...).
#
# ⚠ TỔNG SỐ TAB TRÊN MỘT MÁY: giữ ≤ 4. Cloudflare đếm theo IP chứ không theo
#   tiến trình, nên hai worker khác nguồn vẫn cộng dồn vào cùng một hạn mức.
#   Đã gặp: 7 tab (4 PartSouq + 3 JNBK) là bị chặn ngay.

FILE="${1:-worker_substitutes.mjs}"
WID="${2:-local-server-1}"
SERVER="${3:-http://127.0.0.1:3001}"
shift 3 2>/dev/null || shift $#

# ── Khóa theo worker-id: chạy lần mới thì TỰ GIẾT lần cũ ──────────────
# Vì sao cần: script này bật lại worker sau mỗi lần chết. Nếu chạy lần hai mà
# không dọn lần một, cả hai cùng đẻ worker. Đã gặp thật — 19 vòng lặp tích tụ,
# mỗi lần "tắt hết worker" là chúng lập tức bật lại, sinh hàng chục tab
# PartSouq -> Cloudflare chặn -> Chrome cạn tài nguyên. Mất nhiều giờ truy tìm
# vì triệu chứng trông giống lỗi Chrome/Playwright.
THU_MUC_KHOA="${TMPDIR:-/tmp}"
KHOA="$THU_MUC_KHOA/cao_${WID}.pid"

if [ -f "$KHOA" ]; then
  cu=$(cat "$KHOA" 2>/dev/null)
  if [ -n "$cu" ] && kill -0 "$cu" 2>/dev/null; then
    echo "=== Đã có vòng lặp '$WID' (PID $cu) đang chạy — dừng nó trước ==="
    # Giết cả cây: vòng lặp + worker node nó đang giữ
    pkill -P "$cu" 2>/dev/null
    kill -9 "$cu" 2>/dev/null
    sleep 3
  fi
fi
echo $$ > "$KHOA"

don_dep() {
  echo ""
  echo "=== Dừng vòng lặp '$WID' ==="
  pkill -P $$ 2>/dev/null      # giết worker node đang chạy dưới quyền mình
  rm -f "$KHOA"
  exit 0
}
trap don_dep INT TERM HUP

# Đếm số lần chết liên tiếp. Worker sống > 120s coi như đã chạy được -> reset.
# Chết nhanh liên tiếp nghĩa là đang có vấn đề (captcha hàng loạt, Chrome sập)
# -> nghỉ lâu dần thay vì bật lại ngay. Bật lại ngay chỉ làm Chrome đẻ thêm tab
# challenge, càng nhanh cạn tài nguyên.
lan_chet=0
while true; do
  echo "=== [$(date '+%H:%M:%S')] khởi động $FILE ($WID) $* ==="
  bat_dau=$(date +%s)
  node "$FILE" --server "$SERVER" --worker-id "$WID" "$@"
  ma=$?
  song=$(( $(date +%s) - bat_dau ))

  if [ "$song" -gt 120 ]; then
    lan_chet=0
    nghi=10
  else
    lan_chet=$((lan_chet + 1))
    nghi=$((lan_chet * 30))
    [ "$nghi" -gt 300 ] && nghi=300
  fi

  if [ "$lan_chet" -ge 5 ]; then
    echo "=== [$(date '+%H:%M:%S')] CHẾT $lan_chet LẦN LIÊN TIẾP (mỗi lần < 2 phút) ==="
    echo "    Nhiều khả năng dính captcha hàng loạt hoặc Chrome hỏng."
    echo "    DỪNG HẲN để khỏi đẻ thêm tab. Xem cửa sổ Chrome rồi chạy lại."
    rm -f "$KHOA"
    exit 1
  fi

  echo "=== [$(date '+%H:%M:%S')] worker thoát (mã $ma) sau ${song}s, bật lại sau ${nghi}s ==="
  sleep "$nghi"
done
