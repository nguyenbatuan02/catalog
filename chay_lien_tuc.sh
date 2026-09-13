#!/bin/sh
# Chạy worker liên tục: worker chết vì bất kỳ lý do gì (Chrome đóng, mạng rớt,
# server reload) thì tự bật lại sau 10s. Chỉ dừng hẳn khi bị kill.
#
#   sh chay_lien_tuc.sh worker_substitutes.mjs local-server-1
#   sh chay_lien_tuc.sh worker_xe.mjs xe-local-1

FILE="${1:-worker_substitutes.mjs}"
WID="${2:-local-server-1}"
SERVER="${3:-http://localhost:3001}"

while true; do
  echo "=== [$(date '+%H:%M:%S')] khởi động $FILE ($WID) ==="
  node "$FILE" --server "$SERVER" --worker-id "$WID" --batch 20
  echo "=== [$(date '+%H:%M:%S')] worker thoát (mã $?), bật lại sau 10s ==="
  sleep 10
done
