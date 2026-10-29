---
name: taste-lab
description: 用本地「Taste Lab」应用对网站或图片做审美审查，产出评分、P0/P1/P2 问题清单和可落地的 token 建议。触发词：审美审查、审美评审、网站评审、UI 审查、页面评分、对标网站、界面打分、这个网站好看吗、图片审美打分、帮我看下这个网页的设计、review this website design。
---

# Taste Lab 审美审查台

本 skill 把 `design-taste`（品位层）与 `Impeccable`（框架层）两个 skill 合成为一个可运行的本地应用，用来给真实网站/图片打分并输出整改清单。

## 前置

服务必须在跑（默认端口 8787）：

```bash
curl -sf http://127.0.0.1:8787/api/health >/dev/null || /path/to/appdesk/apps/taste-lab/start.sh
```

健康检查：`curl -s http://127.0.0.1:8787/api/health`。服务由 launchd 常驻（`com.local.appdesk-taste-lab`），start.sh 会在挂掉时重新 load。

## 审查一个网站

```bash
cd /path/to/appdesk/apps/taste-lab
ID=$(curl -s -X POST http://127.0.0.1:8787/api/review/site \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","industry":"Software/Cloud","mobile":true}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
# 轮询直到 status != running（约 40–90 秒）
curl -s http://127.0.0.1:8787/api/job/$ID
```

`industry` 可选，**传英文 key**（不是网页上显示的中文）。取值见 `skills/design-taste/scripts/benchmarks.csv`：
Software/Cloud、Internet、Semiconductors、Hardware/Devices、Industrial、Auto/Battery、Auto、Energy、Mining、Conglomerate、Finance、Pharma、Healthcare、Retail、Consumer Goods、Luxury、Aerospace、Media。

网页下拉里显示的是中文（软件 / SaaS / 云服务、互联网平台、半导体…），但 API 只认英文 key。
中英对照表：`curl -s http://127.0.0.1:8787/api/industries`。

选行业后，模型会拿到该行业的平均分与标杆站点作为评审参照。

## 后台应用（需要登录）

管理后台、内部控制台这类应用直接发网址只会停在登录页，采到的指标与截图都不代表真实界面。

```bash
# 1) 拉起可见浏览器，人工登录一次（脚本检测到登录成功自动保存会话）
curl -s -X POST http://127.0.0.1:8787/api/auth/login \
  -H 'content-type: application/json' -d '{"url":"http://127.0.0.1:3000/admin"}'

# 2) 之后正常发起审查即可，会自动带上 data/auth/<host>.json
```

查询是否已有登录态：`curl -s "http://127.0.0.1:8787/api/auth-state?url=http://127.0.0.1:3000/admin"`

如果采集结果里 `loginWall: true`，说明采到的是登录页——要么先走上面的登录流程，要么让用户截图走图片模式。

## 整改指令包（给 AI 编程工具）

```bash
curl -s http://127.0.0.1:8787/api/job/$ID/fixpack
```

产出一段可直接粘给 Claude Code / Cursor / OpenClaw 的中文 Markdown：审查结论、客观指标清单、设计 token CSS 块、逐条整改任务（现状/改法/验收）、硬性约束、下一步动作。给用户提整改建议时优先给这份，而不是自己复述。

## 模型选择

```bash
curl -s http://127.0.0.1:8787/api/models          # 可选模型 + 能力标记
curl -s -X POST http://127.0.0.1:8787/api/config -H 'content-type: application/json' \
  -d '{"model":"minimax/MiniMax-M3.1-Flash-Preview"}'   # 设为默认
```

默认 `minimax/MiniMax-M3.1-Flash-Preview`（可看图）。MiniMax 的 OpenAI 兼容端点与 Anthropic 端点都支持带图，服务端会按优先级自动尝试、任一成功即返回。

## 审查一张图片

```bash
python3 - <<'PY'
import base64, json, urllib.request
p = "/absolute/path/to/image.png"
body = json.dumps({"dataUrl": "data:image/png;base64," + base64.b64encode(open(p,'rb').read()).decode(),
                   "filename": "image.png", "type": "ui"}).encode()
print(urllib.request.urlopen(urllib.request.Request(
    "http://127.0.0.1:8787/api/review/image", data=body,
    headers={"content-type":"application/json"})).read().decode())
PY
```

`type` 可选：photo、product、poster、social、ui、illustration、figure、ai。

## 结果结构

job 返回 `result.visual`：verdict（一句结论）、summary（总评）、strengths、issues[{priority,area,problem,fix}]、tokens（可直接抄进 CSS）、next_actions。
`result.metrics` 是脚本采集的客观指标，`result.images` 是采集到的截图文件名。

截图可通过 `http://127.0.0.1:8787/runs/<jobId>/<文件名>` 访问。

## 汇报原则

- 先给结论（总分 + verdict），再给问题清单，每条问题必须带具体数值。
- issues 按 P0/P1/P2 排，不要把 P2 混着说。
- tokens 段落原样转成 CSS 变量建议。
- 分数不是唯一目标：脚本 metric 分低往往是因为页面本身 token 收敛，模型视觉分才反映"好不好看"，两者要分开讲。
- 中文网页用宋体/仿宋/楷体是过时做法（脚本会扣字体分并点名），建议一律换成黑体族。

## 排错

| 现象 | 处理 |
|---|---|
| `EADDRINUSE` | 已有实例在跑，直接用；或 `launchctl kickstart -k gui/$(id -u)/com.local.appdesk-taste-lab` 重启 |
| job 一直 running | 看 `runs/<jobId>/`，若只有截图没有 job.json，采集阶段卡住，检查 playwright |
| `模型返回的不是 JSON` | 模型输出被截断，服务端会自动重试一次；持续失败就换 `TASTE_LAB_MODEL=deepseek/deepseek-v4-pro` |
| 页面 403 / 验证码 | review_site.py 不会绕过反爬，改用用户截图走图片模式 |
| 采到的是登录页（`loginWall: true`） | 先 `/api/auth/login` 登录保存会话，或让用户截图走图片模式 |
| 模型报 404 / 协议错误 | 服务端会自动换协议重试；持续失败用 `/api/config/test-model` 单独测，或换模型 |
| `INDUSTRY_ZH is not defined` 之类 | 服务端代码有语法/引用错误，`node --check server.mjs` 定位后重载 launchd |
