#!/bin/bash
# 一键安装 appdesk 里的本地应用（launchd 常驻）
# 用法：bash install.sh [workbench|taste-lab|all]
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-all}"

install_one() {
  local app="$1" label="$2"
  local src="$ROOT/launchd/${label}.plist"
  local dest="$HOME/Library/LaunchAgents/${label}.plist"
  [ -f "$src" ] || { echo "缺少 plist 模板：$src"; return 1; }

  # 替换占位符
  sed -e "s#__REPO_ROOT__#${ROOT}#g" \
      -e "s#__HOME__#${HOME}#g" \
      "$src" > "$dest"

  launchctl unload "$dest" 2>/dev/null || true
  launchctl load "$dest"
  echo "已安装并启动：${label}"
  echo "  程序：${ROOT}/apps/${app}"
}

case "$TARGET" in
  workbench) install_one workbench com.local.appdesk-workbench ;;
  taste-lab) install_one taste-lab com.local.appdesk-taste-lab ;;
  all)
    install_one workbench com.local.appdesk-workbench
    install_one taste-lab com.local.appdesk-taste-lab
    ;;
  *) echo "用法：bash install.sh [workbench|taste-lab|all]"; exit 1 ;;
esac

echo
echo "打开浏览器访问："
echo "  应用工作台    http://127.0.0.1:8788"
echo "  Taste Lab    http://127.0.0.1:8787"
