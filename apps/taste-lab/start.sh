#!/bin/bash
# Taste Lab 启动/自检
# 服务由 launchd 常驻（com.local.appdesk-taste-lab），本脚本只负责：确保在跑 + 打开浏览器
set -e
cd "$(dirname "$0")"
PORT="${TASTE_LAB_PORT:-8787}"
PLIST="$HOME/Library/LaunchAgents/com.local.appdesk-taste-lab.plist"

if ! curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST" || true
    sleep 3
  else
    nohup node server.mjs > /tmp/taste-lab.log 2>&1 &
    disown || true
    sleep 2
  fi
fi

if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "Taste Lab 已就绪: http://127.0.0.1:${PORT}"
else
  echo "启动失败，看 /tmp/taste-lab.err.log"
  exit 1
fi

open "http://127.0.0.1:${PORT}" 2>/dev/null || true
