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
engine/         采集引擎（vendor 自 design-taste，本项目独立演进）
  capture.py      采集 + 指标 + 评分 v2（颜色聚类 / 真实 WCAG / 页面类型分流 / 多断点 / 交互态 / 分块截图）
  crawl.py        同源页面爬虫（整站扫描用）
  review_site.py  v1 原始副本，留作对照与回退
rubric.md       评审准则（评分公式、阈值、9 个视觉维度、问题分级）
web/            前端（index.html + style.css，无构建）
web/logo-*.svg  觉木 logo（mark / 字标，深浅两套）
scripts/login.py  交互式登录脚本（保存后台应用的登录态）
data/config.json  本地配置（默认模型、自定义模型）
data/auth/<host>.json  各站点登录态（Playwright storage_state）
skills/taste-lab/  供 agent 调用的 skill 封装
runs/<jobId>/   每次审查的截图、指标、job.json、elements.json
```

## 界面与 API（2026-10-29 改版）

前端改成应用外壳：左侧栏（觉木 logo + 四个功能 + 当前视觉模型）、顶栏状态、中央工作区。四个页签：网站审查 / 图片审查 / 审查记录 / 模型配置。

- **审查记录**（新）：`GET /api/history` 扫 `runs/` 目录，返回 `{id, mode, status, createdAt, score, grade, verdict, title, url, thumb}`；点开任意历史结果直接渲染，**不重跑模型、不烧 token**。
- **删除记录**（新）：`DELETE /api/job/<id>`，移除对应 `runs/<id>` 目录。
- 交互补强：⌘/Ctrl+回车提交、网址自动补协议并记住上次输入、拖拽/粘贴传图、问题清单按 P0/P1/P2 筛选、截图点击放大、失败给出 toast 而不是静默。
- 品牌：强调色统一取自觉木 logo 的金 `#DDB98D`（浅色模式压深为 `#A6803C`）；logo 资源在 `web/logo-mark.svg`、`web/logo-word-{dark,light}.svg`。

⚠️ 默认模型：`~/.openclaw/openclaw.json` 里的 MiniMax key 2026-10-29 实测返回 **429 限流**，默认已切到 `deepseek/deepseek-flash`（支持图片）。MiniMax 恢复后在「模型配置」切回即可。

```

## 2026-10-29 能力升级：指标层 + 定位层

v1 的问题不是功能少，是**尺子不准**：颜色按字符串去重（`rgb(239,240,241)` 和 `rgb(240,239,247)`
算两种颜色，仪表盘动不动"36 种颜色"→ 色彩分 0，模型跟着复读）；正文取"出现次数最多的字号"
（后台页取到 10px 标签 → `bodySize=null` → 可访问性分静默兜底 **50 分**）；对比度按 12:1 当
达标线（WCAG AA 是 4.5:1、AAA 才 7:1）；一套落地页尺子量所有页面。

改完后（`engine/capture.py`）：

| 项 | v1 | v2 |
|---|---|---|
| 颜色数 | `Set(color).size`，36 | CIELAB ΔE 聚类，11 → 10 个色簇 |
| 正文识别 | 出现次数最多的字号 | 按字符数加权取众数，并记录识别依据 |
| 对比度 | 常为 `null`，阈值 12:1 | 逐元素真实 WCAG，P50 + 低于 AA 占比 |
| 缺数据 | 兜底 50 分 | `measured:false`，权重重分给已测维度 |
| 阈值 | 一套（落地页） | 按 `pageType` 分化：landing/app/doc/commerce/login |
| 采集 | 1440 + 390 两张 | 390/768/1440/1920 + hover/focus/展开导航 + 横向溢出检测 |

**问题定位（C 层）**：采集时额外产出 `elements.json`（文本元素目录：selector + bbox + 字号 + 对比度）。
模型对每条问题输出 `anchor`（截图上的原文），服务端在目录里匹配回 bbox，
结果页的「图上定位」按钮直接在截图上框出这块区域——不用人自己在长图里找。

**分块评审（2026-10-29 追加）**：整页一张图只能给"全局观感"，所以采集时按区域再切一遍
（侧栏 / 顶栏 / 主栏·超长自动按视口切片 / 表单，见 `regions.json` + `regions/*.png`），
评审时一次调用同时喂整页图 + 区域高清图，要求对每个区域单独过五项检查（留白 / 层级 / 对齐 /
组件状态 / 文案贴合），每条问题带 `region` 字段。条数上限从 6 条放宽到 9 条。
实测同一页面问题数 4 → 7，多出来的是移动端 390px 裁字、侧栏底部系统信息挤压、
统计卡说明文字折行导致基线错位这类"整页图看不清"的问题。

**改阈值的地方**：`engine/capture.py` 的 `TYPE_RULES`（每个页面类型的颜色预算、标题/正文下限、
理想层级比）和 `score_metrics()`（各维度权重、扣分斜率）。改完不用动 server.mjs。

## 站点基线：后台多页面的正解

后台类站点有几十上百个页面，逐页"审美评审"没有意义，而且每页从零审美会给出互相打架的结论。
2026-10-29 加了站点级设计系统基线：

1. 首页审完点「把这次审查设为站点基线」→ 落盘 `data/sites/<host>.json`
   （色板 / 字号档 / 圆角族 / 字体族 / 正文基准 / 页面类型）
2. 之后审同域任何页面，服务端先做**确定性比对**（颜色走 CIELAB ΔE ≤ 6 算同色，
   字号/圆角/字体族精确比对），算出偏离项，再连同基线一起注入评审提示
3. 模型不用重新发明规则，只判断「哪些偏离是真问题、哪些是合理扩展」
   （例：`border-radius: 50%` 用于圆点、琥珀色用于告警——都算合理扩展，不该报）

偏离分 = 偏离项数 × 8（上限 100）。实测：同一后台，首页基线 7 色 / 5 档字号，
另一页报出「13px 用了 121 处」「新增 #E8A33D」「圆角 50%」，模型据此把 13px 认成体系问题。

API：`GET /api/baseline?url=`、`POST /api/baseline {jobId|url}`、`DELETE /api/baseline?url=`

## 整站扫描：按「页面模板」人工选页 + 性能 + SEO（2026-10-29 · 第 4 个页签）

「网站审查」只审一个页面的一屏审美，回答不了官网改版最要命的三件事：**别的页面是不是也烂、速度是不是真慢、搜索引擎收不收得到**。
第 4 个页签 `整站扫描` 补这一层，与审美评审完全解耦（不调视觉模型、不烧 token）。

### 为什么是人工选页，不是让爬虫自己挑（2026-10-29 修正）

**分数是跟着「页面模板」走的，不是跟着页面数量走的。** 自动爬 6 页，很可能是 5 个详情页 + 首页，
列表页和单页一个都没测到——数量够了，覆盖没够。实测 `dream-sh.com`：

| 自动爬取（3 页） | 人工指定（4 个模板各一页） |
|---|---|
| 平均性能 **66** | 首页 **90** / 列表 **60** / 详情 66 / 单页 **60** |

「平均 66」把首页其实是好的、内页模板全烂这件事**完全抹平了**。按模板看，结论立刻变成
「先修列表和单页这两个模板，一次改两个模板能吃到 30 分」——这才是能排期的结论。

所以现在的设计：

- **人工填清单**：一行 = 一个 URL + 一个类型标签（首页 / 列表 / 详情 / 单页 / 表单流程 / 其他），最多 12 行，存在 localStorage。
- **爬虫降级成建议**：点「发现候选」只跑 `crawl.py` 拿同源链接（不跑 Lighthouse，几秒），
  按路径猜类型后给成一排 chip，**点一下才加进清单**，类型可改。猜错不要紧，它只是省几下手。
- **给一页就只测一页**：人工清单优先，绝不在背后偷偷补爬别的页面（旧的 `targets.length<=1` 退回爬虫的行为已废弃）。
  只有完全没给清单、只给域名时才自动发现，结果卡片会标「自动发现」而不是「人工指定」。
- **按模板聚合**：`byRole` 给出每个类型的均值，并直接点出「最好 X 分 / 最差 Y 分 / 差 N 分，先修差的那个模板」。

类型猜测规则（`guessRole`）顺序很重要：先判**详情**（`xxx-case` 里含 case 但那是详情不是列表），
再判**容器型列表**（`/cases` `/news` `/articles` `/list_40`），最后才是单页（about/contact/service/faq）。
实测 `dream-sh.com` 24 个候选：`/Headqua-rtersoffice-case` → 详情、`/cases` → 列表、`/articles` → 列表、`/faq` → 单页。

### 后台 / 管理系统（2026-10-29 补）

公开官网那套直接套到后台会**静默出错**，这是实测出来的，不是推测：

| 现象 | 后果 |
|---|---|
| `crawl.py` 匿名抓链接，被 302 到 `/login`，登录页没有站内链接 | 页面清单永远只有 1 页 |
| Lighthouse 带的是干净浏览器，每个 URL 都落到登录页 | 测的是登录页，却按这个 URL 记账 |
| 登录页通常又小又干净 | 可能报出**性能 100 / 可访问 100 / 最佳实践 100** 的假满分 |
| Next.js 类 SPA 重定向时 `net::ERR_ABORTED` | 四张分全 `null`，界面显示「—」，看着像「没发现问题」 |

实测证据（`https://jm.dream-sh.com/`，觉木 CRM）：`finalUrl` 全部变成 `https://jm.dream-sh.com/login`，
`runtimeError: FAILED_DOCUMENT_REQUEST`，`runWarnings` 明写「your test URL was redirected to /login」。
旧版本会把这种结果记成「红项 0 条」。

现在的处理：

1. **落地检查（每次扫描都做）**：跑完比对 `finalDisplayedUrl`。
   落到 login/signin/auth/sso/passport 这类路径、或 `runtimeError`、或四张分全空 → 标 `blocked`，
   **不计入平均**，结果页顶部出红色告警条，逐条列出「被弹回登录页（/login）」。
   全部被挡时不显示分数卡片和表格——没有任何可看的东西，就别摆出「平均分」。
2. **登录态复用**：Lighthouse 不认 Playwright 的 `storage_state`，唯一能带进去的是
   `--extra-headers`（每个请求都附带）。所以存的是**请求头**，不是 cookie jar：
   - `Cookie` 串（DevTools → Network → Request Headers 整段复制）
   - `Authorization`（token 存 localStorage 的后台用 `Bearer ...`）
   存在 `data/auth/<host>.headers.json`，爬链接和逐页扫描都会带上。
   也可以先点「浏览器登录一次」（复用 `scripts/login.py` 的可见浏览器），再点「从登录态提取」——
   会从 storage_state 里拼 Cookie 串，localStorage 里有像 token 的键就猜成 Bearer。
   猜错不会给假分数，落地检查会把它标出来。
3. **后台专用页面类型**：工作台 / 列表 / 表单流程 / 详情 / 设置（`guessRole` 按路径识别
   `dashboard|workbench|overview`、`settings|users|roles`、`new|create|edit`）。
   用到这几类时判定 `isBackend=true`，SEO 卡片显示「后台不适用」——后台本来就不该被索引，
   拿 SEO 分去排期是浪费。

**已排除的错路**（省得以后重试）：`--chrome-flags=--user-data-dir=<profile>` 没用。
用 Playwright 持久化 context 登录、把 cookie 落进 profile，再让 Lighthouse 用同一个目录，
实测仍然落到 `/login`——chrome-launcher 会自己再塞一个 profile，cookie 读不到。

**仍然做不到的**（后台的真正痛点，别指望 Lighthouse）：
- **页面切换/交互延迟**：Lighthouse 测的是「冷加载一个 URL」，测不出「点菜单等 3 秒」。
  后台的卡顿大多发生在客户端路由切换和表格重渲染，要另写 Playwright 脚本量「点击 → 内容出现」的耗时。
- **状态变体**：空数据、1000 行长表格、校验报错、权限不足，这些才是后台最容易崩的地方，
  而它们都要登录 + 造数据才能到达。
- 现有的「站点基线」（`data/sites/<host>.json`）能覆盖一部分一致性检查，但那走的是审美评审链路。

### 实现要点

```
crawl.py（只在「发现候选」或无清单时用）
  → 逐页 lighthouse CLI（串行，避免抢 CPU 把分跑崩）
  → 归一化成表格 + byRole 聚合
```

- **爬虫** `engine/crawl.py`：同源链接打分 = 导航内 +100、有文字 +10、路径越深扣分、DOM 顺序微调；
  `SKIP_RE` 排除 logout / cart / register / 媒体文件。
- **只测四类**：performance / accessibility / seo / best-practices，**不做视觉评审**。
- **两张表**：① 按页面类型聚合（类型 · 页数 · 四张分）② 逐页明细（类型 · 页面 · 四张分 · LCP · CLS · TTFB · 体积 · 红项）。
- **红项过滤**：FCP/LCP/TBT/CLS/SpeedIndex/TTI/体积这些已经在列里的指标不再重复进红项，
  红项只留**可动手的**（对比度、标题层级、canonical、bf-cache、废弃 API、未压缩图片…），
  按「硬错误优先 → 可优化项按严重度」排序，最多 12 条。
- **中文化**：Lighthouse 的英文长句对业务方没意义，`LH_ZH` 收了 60+ 常见审计项的中文短语
  （含 LH12 的 `-insight` 后缀变体；没收录的新审计项原样保留英文，不硬编），
  `zhValue()` 顺手翻 `1 warning found` → `1 处警告`、`Potential savings of N ms` → `可节省 N ms`。
  英文原句留在 `titleEn` 里做 hover 提示，方便对着 Lighthouse 报告改。

为什么不用 unlighthouse：0.19.1 在本机装崩
（`Cannot find module '@unlighthouse/core/node_modules/lighthouse/report/generator/report-generator.js'`），
直接调 lighthouse CLI + 自家爬虫更稳，也少一层壳。

API：
- `POST /api/audit/site {urls:[{url,role}], url}` → `{id}`（id 前缀 `audit-`）；`urls` 为空时才退回 `{url,maxPages}` 自动爬
- `POST /api/audit/discover {url, maxPages}` → `{candidates:[{url, role, label}]}`，只爬链接不跑 Lighthouse

⚠️ **看趋势别看单次绝对值**：Lighthouse 默认移动端 4G 模拟，同一页连跑两次性能分能差 ±8 分
（实测 `dream-sh.com` 首页三轮：69 / 66 / 66，LCP 5.9s / 4.4s / 5.8s；同一轮不同跑法首页甚至能到 90）。

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
- `POST /api/audit/site` `{url, maxPages}` → 起一个整站扫描任务，返回 `{id}`（前缀 `audit-`）
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
- **官网会被误判成后台**：`dream-sh.com` 因为站点导航是 `<aside>` 被 `detect_page_type()` 判成 `app`，
  于是套了后台的阈值（`bodyMin 13px` / `heroMin 22px`）。缺 `corp` 类型是已知缺口，下一步补。
- 官网真正该看的四件事——信息架构、转化路径、信任要素、内容深度——目前**没有采集也没评分**，
  Lighthouse 那一层只覆盖了性能 / 可访问性 / SEO / 最佳实践。
