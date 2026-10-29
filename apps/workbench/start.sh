#!/bin/bash
# 应用工作台 · 启动/自检
# 服务由 launchd 常驻（com.local.appdesk-workbench），本脚本只做：健康检查 → 不在就 load → 开浏览器
set -e
cd "$(dirname "$0")"
PORT="${WORKBENCH_PORT:-8788}"
PLIST="$HOME/Library/LaunchAgents/com.local.appdesk-workbench.plist"

if ! curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST" || true
    sleep 3
  else
    nohup node server.mjs > /tmp/workbench.log 2>&1 &
    disown || true
    sleep 2
  fi
fi

if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "应用工作台已就绪: http://127.0.0.1:${PORT}"
else
  echo "启动失败，看 /tmp/workbench.err.log"; exit 1
fi
open "http://127.0.0.1:${PORT}" 2>/dev/null || true
