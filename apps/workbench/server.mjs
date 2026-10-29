#!/usr/bin/env node
// 应用工作台 · App Workbench
// 统一管理本地开发的应用：名称/用途/本地地址/在线地址/GitHub/启动方法/线上更新方法/开发来源
// 技术栈：Node 原生 http，零第三方依赖
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// node:http/https 在 ESM 里用 createRequire 拿
const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data/apps.json');
const PORT = Number(process.env.WORKBENCH_PORT || 8788);
const HOME = os.homedir();
const GH_ACCOUNT = process.env.GH_ACCOUNT || 'your-account';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const BUILT_BY = ['openclaw', 'codex', 'workbuddy', 'claude', 'human'];
const CATEGORIES = ['内容生产', '数据看板', '业务系统', '素材管理', '开发工具', '自动化', '其他'];

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readData() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    raw.apps = Array.isArray(raw.apps) ? raw.apps : [];
    return raw;
  } catch (e) {
    return { version: 1, updatedAt: new Date().toISOString(), apps: [] };
  }
}

function writeData(data) {
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd: opts.cwd || __dirname,
      env: { ...process.env, ...(opts.env || {}) },
      shell: false,
    });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e.message || e) }));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/* --------------------- 健康检查 --------------------- */
function probe(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!url) return resolve({ status: 'none', detail: '未配置地址' });
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const started = Date.now();
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? require('node:https') : require('node:http');
      const req = lib.request(url, { method: 'GET', timeout: timeoutMs, headers: { 'user-agent': 'app-workbench' } }, (res) => {
        res.resume();
        finish({ status: 'up', code: res.statusCode, ms: Date.now() - started });
      });
      req.on('timeout', () => { req.destroy(); finish({ status: 'down', detail: '超时' }); });
      req.on('error', (e) => finish({ status: 'down', detail: e.code || e.message }));
      req.end();
    } catch (e) {
      finish({ status: 'down', detail: '地址无效' });
    }
  });
}

async function checkApp(app) {
  const [local, online] = await Promise.all([
    probe(app.localUrl),
    probe(app.onlineUrl),
  ]);
  return { id: app.id, local, online };
}

/* --------------------- 自动发现 --------------------- */
async function discover() {
  const found = [];
  // 1. 本机监听端口
  const ports = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
  const portList = [];
  for (const line of ports.stdout.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 9) continue;
    const cmd = f[0];
    const pid = Number(f[1]);
    const node = f[8] || '';
    const m = node.match(/^(.*):(\d+)$/);
    if (!m) continue;
    const [, host, port] = m;
    if (['node', 'Python', 'python3', 'bun'].includes(cmd) && host.startsWith('127.0.0.1')) {
      portList.push({ cmd, pid, port: Number(port) });
    }
  }
  // 2. launchd 常驻
  const plists = fs.existsSync(path.join(HOME, 'Library/LaunchAgents'))
    ? fs.readdirSync(path.join(HOME, 'Library/LaunchAgents')).filter((f) => f.endsWith('.plist'))
    : [];
  const agentLabels = [];
  for (const p of plists) {
    const label = p.replace(/\.plist$/, '');
    if (/openclaw|local|appdesk|clawpilot/.test(label)) agentLabels.push(label);
  }
  // 3. GitHub 仓库
  const gh = await run('gh', ['repo', 'list', GH_ACCOUNT, '--limit', '50', '--json', 'name,url,pushedAt,description']);
  let repos = [];
  try { repos = JSON.parse(gh.stdout || '[]'); } catch { repos = []; }

  return {
    ports: portList,
    launchd: agentLabels,
    repos: repos.map((r) => ({ name: r.name, url: r.url, pushedAt: r.pushedAt, description: r.description || '' })),
    scannedAt: new Date().toISOString(),
  };
}

/* --------------------- 命令执行 --------------------- */
const running = new Map();

function startCommand(appId, kind) {
  const data = readData();
  const app = data.apps.find((a) => a.id === appId);
  if (!app) throw new Error('应用不存在');
  const cmd = kind === 'start' ? app.localStart : app.onlineUpdate;
  if (!cmd) throw new Error(kind === 'start' ? '未配置本地启动方法' : '未配置线上更新方法');
  const cwd = kind === 'start' ? (app.localPath && fs.existsSync(app.localPath) ? app.localPath : __dirname) : __dirname;
  const runId = `${appId}-${kind}-${Date.now()}`;
  const record = { runId, appId, kind, cmd, cwd, startedAt: new Date().toISOString(), status: 'running', stdout: '', stderr: '' };
  running.set(runId, record);
  const p = spawn('/bin/bash', ['-lc', cmd], { cwd, env: process.env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; record.stdout = out; });
  p.stderr.on('data', (d) => { err += d; record.stderr = err; });
  p.on('close', (code) => {
    record.status = 'done';
    record.code = code;
    record.finishedAt = new Date().toISOString();
  });
  p.on('error', (e) => {
    record.status = 'error';
    record.stderr = String(e.message || e);
    record.finishedAt = new Date().toISOString();
  });
  return record;
}

/* --------------------- HTTP --------------------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 8 * 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

function sanitizeApp(input, existing = {}) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const id = str(input.id) || existing.id || slug(str(input.name) || 'app');
  return {
    id,
    name: str(input.name) || existing.name || id,
    purpose: str(input.purpose) ?? existing.purpose ?? '',
    category: CATEGORIES.includes(input.category) ? input.category : (existing.category || '其他'),
    builtBy: BUILT_BY.includes(input.builtBy) ? input.builtBy : (existing.builtBy || 'openclaw'),
    repo: str(input.repo) ?? existing.repo ?? '',
    localPath: str(input.localPath) ?? existing.localPath ?? '',
    localUrl: str(input.localUrl) ?? existing.localUrl ?? '',
    onlineUrl: str(input.onlineUrl) ?? existing.onlineUrl ?? '',
    deployTarget: str(input.deployTarget) ?? existing.deployTarget ?? '',
    localStart: str(input.localStart) ?? existing.localStart ?? '',
    onlineUpdate: str(input.onlineUpdate) ?? existing.onlineUpdate ?? '',
    launchd: str(input.launchd) ?? existing.launchd ?? '',
    tags: Array.isArray(input.tags) ? input.tags.map(str).filter(Boolean).slice(0, 8) : (existing.tags || []),
    notes: str(input.notes) ?? existing.notes ?? '',
  };
}

function slug(s) {
  return (s.toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)) || 'app';
}

function renderMarkdown(apps) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const lines = [
    '# 应用工作台 · 清单',
    '',
    `> 导出时间：${now}　共 ${apps.length} 个应用`,
    '',
  ];
  for (const a of apps) {
    lines.push(`## ${a.name}`, '');
    if (a.purpose) lines.push(`**用途**：${a.purpose}`, '');
    const rows = [
      ['分类', a.category],
      ['开发来源', a.builtBy],
      ['本地地址', a.localUrl || '—'],
      ['在线地址', a.onlineUrl || '—'],
      ['GitHub', a.repo || '—'],
      ['本地路径', a.localPath || '—'],
      ['部署目标', a.deployTarget || '—'],
      ['常驻服务', a.launchd || '—'],
    ];
    lines.push('| 项 | 值 |', '|---|---|');
    for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`);
    lines.push('');
    if (a.localStart) lines.push('**本地启动**：', '```bash', a.localStart, '```', '');
    if (a.onlineUpdate) lines.push('**线上更新**：', '```bash', a.onlineUpdate, '```', '');
    if (a.tags?.length) lines.push(`**标签**：${a.tags.join('、')}`, '');
    if (a.notes) lines.push(`**备注**：${a.notes}`, '');
    lines.push('---', '');
  }
  return lines.join('\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/api/apps') {
      const data = readData();
      return json(res, 200, { ...data, meta: { builtBy: BUILT_BY, categories: CATEGORIES } });
    }

    if (req.method === 'POST' && p === '/api/apps') {
      const body = JSON.parse(await readBody(req) || '{}');
      const data = readData();
      const app = sanitizeApp(body);
      const idx = data.apps.findIndex((a) => a.id === app.id);
      if (idx >= 0) data.apps[idx] = app; else data.apps.push(app);
      writeData(data);
      return json(res, 200, { ok: true, app });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/apps/')) {
      const id = decodeURIComponent(p.split('/').pop());
      const data = readData();
      const before = data.apps.length;
      data.apps = data.apps.filter((a) => a.id !== id);
      writeData(data);
      return json(res, 200, { ok: true, removed: before - data.apps.length });
    }

    if (req.method === 'POST' && p === '/api/check') {
      const data = readData();
      const results = await Promise.all(data.apps.map(checkApp));
      return json(res, 200, { results, checkedAt: new Date().toISOString() });
    }

    if (req.method === 'GET' && p === '/api/discover') {
      return json(res, 200, await discover());
    }

    // launchd 服务管理：重启 / 查看状态
    if (req.method === 'POST' && p === '/api/launchd') {
      const body = JSON.parse(await readBody(req) || '{}');
      const { label, action } = body;
      if (!label || !/^[a-zA-Z0-9._-]+$/.test(label)) return json(res, 400, { error: '非法的 launchd label' });
      if (!['restart', 'status'].includes(action)) return json(res, 400, { error: '不支持的操作' });
      if (action === 'restart') {
        const r = await run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`]);
        if (r.code !== 0) return json(res, 500, { error: (r.stderr || r.stdout).trim() });
        return json(res, 200, { ok: true, label, action });
      }
      const r = await run('launchctl', ['list', label]);
      return json(res, 200, { label, running: r.code === 0, raw: r.stdout.trim() });
    }

    // 导出 Markdown 清单（可贴进 Obsidian）
    if (req.method === 'GET' && p === '/api/export.md') {
      const data = readData();
      const md = renderMarkdown(data.apps);
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(md);
    }

    if (req.method === 'POST' && p === '/api/run') {
      const body = JSON.parse(await readBody(req) || '{}');
      const record = startCommand(body.appId, body.kind);
      return json(res, 200, { ok: true, runId: record.runId });
    }

    if (req.method === 'GET' && p.startsWith('/api/run/')) {
      const runId = p.split('/').pop();
      const rec = running.get(runId);
      if (!rec) return json(res, 404, { error: '找不到该执行记录' });
      return json(res, 200, rec);
    }

    if (req.method === 'GET' && p === '/api/health') {
      return json(res, 200, { ok: true, port: PORT, apps: readData().apps.length });
    }

    // 静态资源
    let file = p === '/' ? '/web/index.html' : p;
    const abs = path.join(__dirname, file);
    if (!abs.startsWith(__dirname) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`应用工作台已启动: http://127.0.0.1:${PORT}`);
});
