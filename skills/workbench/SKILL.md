---
name: workbench
description: 登记和管理我本地开发的应用（名称、用途、本地地址、在线地址、GitHub、启动方法、线上更新方法、由哪个 AI 开发），并查询探活状态。触发词：登记应用、我的应用有哪些、工作台、应用清单、哪个应用在跑、这个应用怎么启动、线上怎么更新、应用状态。
---

# 应用工作台

本地应用登记与管理台，服务在 `http://127.0.0.1:8788`（launchd 常驻，标签 `com.local.appdesk-workbench`）。

## 前置

```bash
curl -sf http://127.0.0.1:8788/api/health >/dev/null || /path/to/appdesk/apps/workbench/start.sh
```

## 常用操作

### 列出所有应用
```bash
curl -s http://127.0.0.1:8788/api/apps | python3 -m json.tool
```

### 登记 / 更新一个应用
```bash
curl -s -X POST http://127.0.0.1:8788/api/apps -H 'content-type: application/json' -d '{
  "id":"my-app","name":"我的应用","purpose":"干什么用的",
  "category":"业务系统","builtBy":"openclaw",
  "repo":"https://github.com/…","localPath":"/Users/…",
  "localUrl":"http://127.0.0.1:3000","onlineUrl":"https://…",
  "deployTarget":"/www/wwwroot/your-app",
  "localStart":"cd /path && npm run dev",
  "onlineUpdate":"cd /www/wwwroot/your-app && bash deploy.sh",
  "launchd":"com.example.myapp","tags":["标签"],"notes":"备注"
}'
```
按 `id` 覆盖保存。不带 `id` 时由名称生成。

`builtBy` 限定 `openclaw` / `codex` / `workbuddy` / `claude` / `human`；
`category` 限定 `内容生产` / `数据看板` / `业务系统` / `素材管理` / `开发工具` / `自动化` / `其他`。

### 查状态（探活）
```bash
curl -s -X POST http://127.0.0.1:8788/api/check
```
返回每个应用的本地/在线 `up`/`down` + 状态码 + 耗时。

### 扫描本机资产（补登记线索）
```bash
curl -s http://127.0.0.1:8788/api/discover
```
返回：本机 node/Python/bun 监听端口、launchd 常驻列表、GitHub 仓库列表（账号由 GH_ACCOUNT 决定）。

### 执行启动 / 线上更新
```bash
curl -s -X POST http://127.0.0.1:8788/api/run -H 'content-type: application/json' \
  -d '{"appId":"my-app","kind":"start"}'    # kind: start | update
curl -s http://127.0.0.1:8788/api/run/<runId>   # 轮询输出
```

### 导出 Markdown 清单
```bash
curl -s http://127.0.0.1:8788/api/export.md
```

### 重启某应用的常驻服务
```bash
curl -s -X POST http://127.0.0.1:8788/api/launchd -H 'content-type: application/json' \
  -d '{"label":"com.local.your-app","action":"restart"}'   # action: restart | status
```

## 汇报原则

- 用户问「我的应用有哪些」：给名字 + 用途 + 本地地址 + 状态，按分类分组，不贴 JSON。
- 用户问「怎么启动」：直接给 `localStart` 命令原文，一行字说明即可。
- 用户问「线上怎么更新」：给 `onlineUpdate` 原文，并提醒先确认本地改动已提交推送。
- 探活结果要区分「down」和「未配置地址」——后者是信息缺失，不是故障。

## 排错

| 现象 | 处理 |
|---|---|
| 8788 连不上 | `launchctl list \| grep workbench`；不在就 `launchctl kickstart -k gui/$(id -u)/com.local.appdesk-workbench` |
| 数据改了页面没变 | 数据在 `apps/workbench/data/apps.json`，改完刷新页面；也可直接改文件 |
| 探活全部 down | 应用本身没起，不是工作台的错 |
| 想加新分类 | 同时改 `data/apps.json` 与前端 `CATEGORIES` 常量（server.mjs） |
