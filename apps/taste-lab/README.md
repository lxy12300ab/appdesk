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
2. **看图打分** — 把截图 + 指标 JSON + `rubric.md`（两个 skill 评分标准的精简版）+ 行业对标基准直接发给视觉模型，**不经过 agent 进程**，单次约 30–120 秒。默认模型 `minimax/MiniMax-M3.1-Flash-Preview`。
3. **输出** — 严格 JSON：verdict / summary / strengths / issues[P0-P2] / tokens / next_actions，前端渲染成分数条 + 问题卡片 + 截图墙。

## 目录

```
server.mjs      Node 原生 http，无第三方依赖
rubric.md       评审准则（评分公式、阈值、9 个视觉维度、问题分级）
web/            前端（index.html + style.css，无构建）
scripts/login.py  交互式登录脚本（保存后台应用的登录态）
data/config.json  本地配置（默认模型、自定义模型）
data/auth/<host>.json  各站点登录态（Playwright storage_state）
skills/taste-lab/  供 agent 调用的 skill 封装
runs/<jobId>/   每次审查的截图、指标、job.json
```

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `TASTE_LAB_PORT` | 8787 | 监听端口 |
| `TASTE_LAB_MODEL` | minimax/MiniMax-M3.1-Flash-Preview | 视觉模型，格式 `provider/model` |

模型配置从 `~/.openclaw/openclaw.json` 的 `models.providers` 读取，也可在网页的「模型配置」页切换或添加自定义模型（存在 `data/config.json`）。

### 双协议自动回退

同一 provider 常同时支持两种协议，调用端点按优先级依次尝试，任一成功即返回：

| Provider | 端点 | 协议 |
|---|---|---|
| minimax | `https://api.minimaxi.com/v1/chat/completions` | OpenAI 兼容（支持带图） |
| minimax | `https://api.minimaxi.com/anthropic/v1/messages` | Anthropic 协议（支持带图） |
| deepseek | `https://api.deepseek.com/chat/completions` | OpenAI 兼容 |

openclaw.json 里 minimax 配的是 `/anthropic` 端点，但 OpenAI 兼容端点在 `/v1`，代码会自动补上这个候选。

### 中文字体规则

中文网页正文不应使用宋体/仿宋/楷体等衬线中文字体（印刷品遗留）。采集脚本会统计衬线中文字体的字符占比：

- 占比 ≥50% → 字体分额外 −10
- 占比 ≥20% → 字体分额外 −5

并在评审提示与报告里点名，要求改用黑体族（思源黑体 / 苹方 / 微软雅黑）。

### 后台应用的登录态

管理后台、内部控制台这类应用直接发网址只会停在登录页。流程：

1. 在「网站审查」页填网址 → 点「登录并保存会话」
2. 弹出可见浏览器窗口，人工登录一次
3. 脚本检测到登录成功后自动保存 `data/auth/<host>.json`
4. 之后审查该站自动带上登录态（`--storage-state`）

采集阶段还会检测 `loginWall`（可见密码框 / 登录词 + 短正文），命中时前端顶部会出橙色横幅提示"这次采到的是登录页"，避免把登录表单当成设计缺陷。

## 整改指令包

结果页有「复制整改指令（给 AI 改代码）」按钮，产出的是一段可直接粘给 Claude Code / Cursor / OpenClaw 的中文 Markdown：

- 审查结论
- 客观指标清单（必须全达标）
- 设计 token CSS 块（直接覆盖）
- 逐条整改任务（按 P0→P2 排列，含"现状 / 改法 / 验收"）
- 硬性约束（不引新框架、颜色 ≤12、字号 ≤7、中文不用宋体等）

也可以点「下载 .md」保存。

## API

- `POST /api/review/site` `{url, industry?, mobile?, model?}` → `{id}`
- `POST /api/review/image` `{dataUrl, filename?, type?, model?}` → `{id}`
- `GET /api/job/<id>` → job 状态与结果
- `GET /api/job/<id>/fixpack` → 整改指令包（Markdown）
- `GET /api/models` → 可选模型列表
- `GET /api/industries` → 行业列表（中文 label + 英文 value）
- `GET` / `POST /api/config` → 读取 / 保存默认模型
- `POST /api/config/custom-model` → 添加自定义模型
- `DELETE /api/config/custom-model/<id>` → 删除自定义模型
- `POST /api/config/test-model` → 测试模型连通性
- `GET /api/auth-state?url=` → 是否已有登录态
- `POST /api/auth/login` `{url}` → 拉起可见浏览器登录
- `GET /runs/<jobId>/<file>` → 截图
- `GET /api/health`

## 已知限制

- 遇到 403 / 验证码的站点不绕过反爬，改用图片模式。
- 分数是代理指标，不是审美真理；模型视觉分占比 55%（图片 40%）。
- 登录态是 Playwright storage_state，站点若强制短周期会话需重新登录。
- 行业基准库 `benchmarks.csv` 只有 147 条，样本少的行业均值波动大。
- 只在 `127.0.0.1` 监听，不对外暴露。
