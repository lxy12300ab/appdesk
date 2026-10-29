# Taste Lab · 审美审查台

把 `design-taste`（品位层）和 `Impeccable`（框架层）两个 skill 合成一个可运行的本地应用：贴一个网址或传一张图，拿到评分、P0/P1/P2 问题清单和可落地的 token 建议。

## 启动

```bash
./apps/taste-lab/start.sh
# → http://127.0.0.1:8787
```

服务由 **launchd 常驻**（`~/Library/LaunchAgents/com.local.appdesk-taste-lab.plist`，标签 `com.local.appdesk-taste-lab`），不挂在网关进程下，不会被会话回收带走。`start.sh` 只是一个自检 + 开浏览器的入口。

运维：
```bash
launchctl list | grep taste-lab          # 看状态
launchctl unload ~/Library/LaunchAgents/com.local.appdesk-taste-lab.plist
launchctl load   ~/Library/LaunchAgents/com.local.appdesk-taste-lab.plist
tail -f /tmp/taste-lab.err.log
```

2026-10-28 实测：手动 kill 进程后 12 秒内 launchd 自动拉起，服务恢复 200。

## 工作原理

1. **采集** — 复用 `skills/design-taste/scripts/review_site.py`（Playwright 无头 Chromium）抓 1440×900 首屏、整页、390×844 移动端，量出颜色数、字体家族、字号档、圆角、阴影、渐变、层级比、WCAG 对比度。图片模式用 `review_image.py` 出调色板与构图辅助线。
2. **看图打分** — 把截图 + 指标 JSON + `rubric.md`（两个 skill 评分标准的精简版）直接发给视觉模型 `deepseek/deepseek-flash`，走 OpenAI 兼容接口，**不经过 agent 进程**，单次约 30–90 秒。
3. **输出** — 严格 JSON：verdict / summary / strengths / issues[P0-P2] / tokens / next_actions，前端渲染成分数条 + 问题卡片 + 截图墙。

## 目录

```
server.mjs      Node 原生 http，无第三方依赖
rubric.md       评审准则（评分公式、阈值、9 个视觉维度、问题分级）
web/            前端（index.html + style.css，无构建）
skills/taste-lab/  供 agent 调用的 skill 封装
runs/<jobId>/   每次审查的截图、指标、job.json
```

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `TASTE_LAB_PORT` | 8787 | 监听端口 |
| `TASTE_LAB_MODEL` | deepseek/deepseek-flash | 视觉模型，格式 `provider/model` |

模型配置从 `~/.openclaw/openclaw.json` 的 `models.providers` 读取。

## API

- `POST /api/review/site` `{url, industry?, mobile?}` → `{id}`
- `POST /api/review/image` `{dataUrl, filename?, type?}` → `{id}`
- `GET /api/job/<id>` → job 状态与结果
- `GET /runs/<jobId>/<file>` → 截图
- `GET /api/health`

## 已知限制

- 遇到 403 / 验证码的站点不绕过反爬，改用图片模式。
- 分数是代理指标，不是审美真理；模型视觉分占比 55%（图片 40%）。
- 只在 `127.0.0.1` 监听，不对外暴露。
