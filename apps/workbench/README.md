# 应用工作台 · App Workbench

个人应用登记与管理台：把散落在本机各处、用不同 AI 开发的应用统一登记在一处——名称、用途、本地地址、在线地址、GitHub、本地启动方法、线上更新方法、由哪个 AI 开发，一屏看清哪个在跑、哪个该更新。

**访问：http://127.0.0.1:8788**

## 为什么做这个

用 OpenClaw / Codex / WorkBuddy 开发的应用越做越多，端口、仓库、部署路径、启动命令散落在 launchd plist、README、deploy.sh 和聊天记录里。真正的痛点不是「找不到应用」，而是：

- **不知道现在哪个在跑** —— 端口被别的进程占了才发现
- **不知道线上跑的是哪个版本** —— 本地改了，线上没更新
- **不知道这个应用是谁做的、怎么起的** —— 半年后完全想不起来

所以工作台不是一本静态清单，而是**带探活的活索引**。

## 功能

| 能力 | 说明 |
|---|---|
| 应用登记 | 名称/用途/分类/开发来源/本地地址/在线地址/GitHub/本地路径/部署目标/启动方法/线上更新方法/launchd/标签/备注 |
| 健康探活 | 并发 GET 每个本地与在线地址，卡片上直接亮绿点（up）/红点（down）/灰点（未配置），带响应码与耗时 |
| 一键执行 | 「本地启动」「线上更新」按钮，执行前弹确认框，输出实时回显在控制台面板 |
| 常驻管理 | 对 launchd 应用直接「重启常驻服务」「查状态」 |
| 自动发现 | 扫本机监听端口（node/Python/bun）、launchd 常驻列表、GitHub 仓库列表，作为补登记的线索 |
| 筛选 | 按分类、按开发来源（openclaw / codex / workbuddy / claude / human）、全文搜索 |
| 导出 | 一键导出 Markdown 清单，可直接贴进 Obsidian 或当交接文档 |

## 结构

```
server.mjs        Node 原生 http，零第三方依赖
data/apps.json    全部登记数据（可直接手改，改完刷新页面）
web/index.html   单页前端，无构建
web/style.css
start.sh          健康检查 → 不在就 load plist → 开浏览器
```

## 运维

服务由 **launchd 常驻**：`com.local.appdesk-workbench`（`~/Library/LaunchAgents/com.local.appdesk-workbench.plist`），不挂在网关进程下，不会被会话回收带走。

```bash
launchctl list | grep workbench
launchctl kickstart -k gui/$(id -u)/com.local.appdesk-workbench
tail -f /tmp/workbench.err.log
```

端口可用 `WORKBENCH_PORT` 覆盖。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/apps` | 全部应用 + 元数据（分类、来源枚举） |
| POST | `/api/apps` | 新建或按 id 覆盖保存 |
| DELETE | `/api/apps/<id>` | 删除 |
| POST | `/api/check` | 探活全部本地/在线地址 |
| GET | `/api/discover` | 端口 + launchd + GitHub 仓库扫描 |
| POST | `/api/launchd` | `{label, action: restart\|status}` |
| POST | `/api/run` | `{appId, kind: start\|update}` 执行登记的命令 |
| GET | `/api/run/<runId>` | 执行状态与输出 |
| GET | `/api/export.md` | Markdown 清单 |

## 数据格式

`data/apps.json`：

```json
{
  "version": 1,
  "updatedAt": "...",
  "apps": [{
    "id": "my-app",
    "name": "我的应用",
    "purpose": "自媒体图文全流程",
    "category": "内容生产",
    "builtBy": "workbuddy",
    "repo": "https://github.com/your-account/your-repo",
    "localPath": "/path/to/project",
    "localUrl": "http://127.0.0.1:3000",
    "onlineUrl": "",
    "deployTarget": "宝塔 /www/wwwroot/xxx",
    "localStart": "cd … && python3 scripts/desk.py 8843",
    "onlineUpdate": "cd /www/wwwroot/xxx && bash deploy.sh",
    "launchd": "com.local.your-app",
    "tags": ["公众号"],
    "notes": ""
  }]
}
```

`builtBy` 限定：`openclaw` / `codex` / `workbuddy` / `claude` / `human`。
`category` 限定：`内容生产` / `数据看板` / `业务系统` / `素材管理` / `开发工具` / `自动化` / `其他`。

## 安全边界

- 只监听 `127.0.0.1`，不暴露到局域网。
- 「执行」按钮跑的是**你自己登记在 data/apps.json 里的命令**，不是外部输入；执行前有二次确认。
- launchd 接口只接受 `^[a-zA-Z0-9._-]+$` 的 label，避免参数注入。

## 已知限制

- 探活只做 HTTP GET，SSH 隧道后的服务需要配好端口转发才能测到。
- 「线上更新」执行的是登记的命令（如 `bash deploy.sh`），本身幂等性取决于各项目的脚本。
- GitHub 仓库列表读 `GH_ACCOUNT` 环境变量指定的账号（默认 `your-account`，需 `gh` CLI 已登录）。
