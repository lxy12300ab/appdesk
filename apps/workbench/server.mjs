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
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'apps.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');
const HEALTH_FILE = path.join(DATA_DIR, 'health.json');   // 最近一次探活快照
const HEALTH_LOG = path.join(DATA_DIR, 'health.jsonl');   // 采样流水，用来算在线率
const HEALTH_KEEP_DAYS = 7;
const BACKUP_KEEP = 20;
const PORT = Number(process.env.WORKBENCH_PORT || 8788);
const HOME = os.homedir();
const GH_ACCOUNT = process.env.GH_ACCOUNT || 'lxy12300ab';

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

/* --------------------- 数据层：原子写 + 自动备份 + 改动历史 --------------------- */

function readData() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    raw.apps = Array.isArray(raw.apps) ? raw.apps : [];
    return raw;
  } catch (e) {
    // 读失败时留个明显的痕迹，不要静默当成空数据 —— 那会让 7 个应用凭空消失
    if (fs.existsSync(DATA_FILE)) {
      console.error(`[data] 读取失败，保持原文件不动：${e.message}`);
    }
    return { version: 1, updatedAt: new Date().toISOString(), apps: [] };
  }
}

// 原子写：先写同目录临时文件再 rename。中途崩溃不会留下半个 JSON。
function writeFileAtomic(file, body) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function writeDataAtomic(data) {
  data.updatedAt = new Date().toISOString();
  writeFileAtomic(DATA_FILE, JSON.stringify(data, null, 2));
  return data;
}

// 写前备份：把「即将被覆盖的那一版」留一份，最多 BACKUP_KEEP 份
function backupCurrent() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `apps-${stamp}.json`);
    fs.copyFileSync(DATA_FILE, dest);
    pruneBackups();
    return dest;
  } catch (e) {
    console.error(`[backup] 备份失败（写入继续）：${e.message}`);
    return null;
  }
}

function pruneBackups() {
  try {
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('apps-') && f.endsWith('.json'))
      .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(BACKUP_KEEP)) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
    }
  } catch {}
}

// 保存 = 先备份旧的，再原子写新的
function saveData(data) {
  backupCurrent();
  return writeDataAtomic(data);
}

function appendHistory(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch (e) {
    console.error(`[history] 写入失败：${e.message}`);
  }
}

function readHistory(limit = 50) {
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

// 写锁：读-改-写必须串行。否则两个请求都读到旧数据，后写的把先写的覆盖掉。
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const result = writeChain.then(fn, fn);
  writeChain = result.then(() => undefined, () => undefined);
  return result;
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
// 只发一个 GET 看状态码是不够的：端口被别的进程占了、或者被一个无关服务占了，
// 照样返回 200，卡片照样亮绿 —— 点进去才发现不是这个应用。
// 所以这里做三件事：探 HTTP、反查端口归属、核对 launchd 托管状态。

function portOf(url) {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch { return null; }
}

function isLocalUrl(url) {
  try {
    return ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(new URL(url).hostname);
  } catch { return false; }
}

function probe(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!url) return resolve({ status: 'none', kind: 'none', detail: '未配置地址' });
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const started = Date.now();
    let u;
    try { u = new URL(url); } catch { return finish({ status: 'down', kind: 'bad-url', detail: '地址格式无效' }); }
    const lib = u.protocol === 'https:' ? require('node:https') : require('node:http');
    let req;
    try {
      req = lib.request(url, { method: 'GET', timeout: timeoutMs, headers: { 'user-agent': 'app-workbench/2' } }, (res) => {
        res.resume();
        const ms = Date.now() - started;
        const code = res.statusCode;
        if (code >= 500) return finish({ status: 'down', kind: 'http-5xx', code, ms, detail: `服务返回 ${code}` });
        // 4xx 说明服务活着，只是要登录或路径不对 —— 不能当「挂了」
        if (code >= 400) return finish({ status: 'up', kind: 'http-4xx', code, ms, warn: true, detail: `返回 ${code}，服务在响应（可能要登录）` });
        finish({ status: 'up', kind: 'ok', code, ms });
      });
    } catch (e) {
      return finish({ status: 'down', kind: 'error', detail: String(e.message || e) });
    }
    req.on('timeout', () => { req.destroy(); finish({ status: 'down', kind: 'timeout', detail: `${Math.round(timeoutMs / 1000)} 秒无响应` }); });
    req.on('error', (e) => {
      const map = {
        ECONNREFUSED: ['refused', '端口没有进程在监听'],
        ECONNRESET: ['reset', '连接被重置'],
        ENOTFOUND: ['dns', '域名解析失败'],
        EAI_AGAIN: ['dns', '域名解析失败'],
        EHOSTUNREACH: ['unreachable', '主机不可达'],
        ENETUNREACH: ['unreachable', '网络不可达'],
        CERT_HAS_EXPIRED: ['tls', '证书已过期'],
        DEPTH_ZERO_SELF_SIGNED_CERT: ['tls', '自签名证书'],
      };
      const [kind, detail] = map[e.code] || ['error', e.code || String(e.message || e)];
      finish({ status: 'down', kind, detail });
    });
    req.end();
  });
}

// 服务刚好在重启、或者正忙的时候，一次 ECONNRESET / 超时并不能说明它挂了。
// 这类瞬时错误重试一次再下结论，否则卡片会闪来闪去。
async function probeWithRetry(url) {
  const first = await probe(url);
  if (first.status !== 'down' || !['reset', 'timeout'].includes(first.kind)) return first;
  await new Promise((r) => setTimeout(r, 700));
  const second = await probe(url);
  return { ...second, retried: true, firstKind: first.kind };
}

// 这个端口到底是谁在听？拿到 pid / 进程名 / 工作目录，才能确认跑的是不是「它」。
// 注意：沙箱里 ps 会被拒，lsof 可以，所以只依赖 lsof。
async function listenerOf(port) {
  const r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
  if (r.code !== 0 || !r.stdout.trim()) return null;
  const pid = Number((r.stdout.match(/^p(\d+)$/m) || [])[1]);
  if (!pid) return null;
  const cmd = ((r.stdout.match(/^c(.+)$/m) || [])[1] || '').trim();
  const cwdR = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const cwd = ((cwdR.stdout.match(/^n(.+)$/m) || [])[1] || '').trim();
  return { pid, cmd, cwd };
}

// 登记的路径经常是符号链接（~/.openclaw/workspace/apps/x → ~/code/apps/x），
// 必须解析成真实路径再比，否则天天误报「不是它」。
// 注意 `/` 这个坑：去掉尾部斜杠后会变成空串，任何路径都 startsWith('/')，
// 于是「进程 cwd 是 /」会被误判成「目录一致」。根目录一律当无信息处理。
function sameDir(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    let s = String(p);
    try { s = fs.realpathSync(s); } catch { s = path.resolve(s); }
    s = s.replace(/\/+$/, '');
    return s === '' ? '/' : s;
  };
  const ra = norm(a), rb = norm(b);
  if (ra === '/' || rb === '/') return false;
  return ra === rb || ra.startsWith(rb + '/') || rb.startsWith(ra + '/');
}

// launchd 托管状态。`launchctl list <label>` 在沙箱下永远返回空，
// 所以改用 `launchctl print gui/<uid>/<label>` —— 它能给出 state / pid / runs。
async function printLabel(label) {
  const r = await run('launchctl', ['print', `gui/${process.getuid()}/${label}`]);
  if (r.code !== 0) return { label, loaded: false, running: false, pid: null, detail: 'launchd 未加载' };
  const state = ((r.stdout.match(/^\s*state = (.+)$/m) || [])[1] || '').trim();
  const pid = Number((r.stdout.match(/^\s*pid = (\d+)$/m) || [])[1]) || null;
  const runs = Number((r.stdout.match(/^\s*runs = (\d+)$/m) || [])[1]) || 0;
  const lastExit = ((r.stdout.match(/^\s*last exit code = (.+)$/m) || [])[1] || '').trim();
  return {
    label, loaded: true,
    running: /running/.test(state) && !!pid,
    state, pid, runs, lastExit,
    detail: pid ? `launchd 托管中，pid ${pid}` : '已加载但当前没有进程',
  };
}

// LaunchAgents 里的 label → 启动脚本 索引，缓存 60 秒（每次探活都扫目录太浪费）
let agentCache = { at: 0, list: [] };
function agentIndex() {
  if (Date.now() - agentCache.at < 60_000) return agentCache.list;
  const dir = path.join(HOME, 'Library/LaunchAgents');
  const list = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.plist')) continue;
      let body = '';
      try { body = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      const script = (body.match(/<string>(\/[^<]+\.(?:mjs|js|py|sh|cjs))<\/string>/) || [])[1] || '';
      if (script) list.push({ label: f.replace(/\.plist$/, ''), script });
    }
  } catch {}
  agentCache = { at: Date.now(), list };
  return list;
}

// 登记的 label 可能已经过期（换代时改了名但没同步数据）。
// 这种情况按 plist 里的启动脚本路径反查，找到真正在用的那个 label，
// 否则「重启常驻」会去 kickstart 一个不存在的服务，静默失败。
async function launchdState(app) {
  const label = app?.launchd;
  if (!label) return null;
  const st = await printLabel(label);
  if (st.loaded) return { ...st, used: label };
  if (app.localPath) {
    for (const a of agentIndex()) {
      if (a.label === label || !sameDir(a.script, app.localPath)) continue;
      const alt = await printLabel(a.label);
      if (alt.loaded) {
        return { ...alt, used: a.label, staleLabel: label, detail: `登记的 ${label} 没加载，实际在用 ${a.label}` };
      }
    }
  }
  return { ...st, used: label };
}

// 归属判定：把「端口上是谁」和「登记的是谁」对上。
// 只在确认是别人的时候才敢说，拿不准就标 unknown，不瞎报警。
function ownershipOf(app, port, owner, lcd) {
  if (!port) return { port: null, verified: null, match: 'unknown', detail: '没有本地地址，无从核对' };
  if (!owner) return { port, verified: false, match: 'none', detail: `端口 ${port} 上没有进程在监听` };
  const byPid = !!(lcd?.pid && lcd.pid === owner.pid);
  const hasPath = !!(app.localPath || '').trim();
  const byPath = hasPath && sameDir(app.localPath, owner.cwd);
  const base = { port, pid: owner.pid, cmd: owner.cmd, cwd: owner.cwd };
  // 没登记本地路径就没有比对基准，宁可说「不知道」也不要瞎猜
  if (!byPid && !hasPath) {
    return { ...base, verified: null, match: 'unknown', detail: `端口上跑着 ${owner.cmd}（pid ${owner.pid}），未登记本地路径，无法核对归属` };
  }
  const match = byPid ? 'pid' : byPath ? 'path' : 'unknown';
  return {
    ...base,
    verified: byPid || byPath,
    match,
    detail: byPid
      ? `pid ${owner.pid} 与 launchd 托管的进程一致`
      : byPath
        ? `进程工作目录与登记的本地路径一致`
        : `端口上是 ${owner.cmd}（pid ${owner.pid}），目录 ${owner.cwd || '未知'} 与登记路径不一致`,
  };
}

/* --------------------- 本地仓库同步状态 --------------------- */
// 判断依据分三层，缺一层就会漏报：
//   1. 工作区有没有未提交的改动  → git status
//   2. 提交有没有推到远端        → 与 upstream 比 ahead/behind
//   3. 本地 remote 是不是登记的仓库 → 登记 repo 与 origin 比对
// 这里只读本地信息，不发网络请求（fetch/ls-remote 要一两秒，不能塞进每两分钟的定时任务）。
// 真要确认「GitHub 上到底是不是最新」，走 POST /api/git/verify 单独核实。

const GIT_CACHE_MS = 30_000;
const repoCache = new Map(); // root -> { at, promise }

function git(root, args, opts = {}) {
  return run('git', ['-C', root, '-c', 'core.quotepath=false', ...args], {
    env: { GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) },
  });
}

// 把 https / ssh / 带 .git 后缀的写法统一成 owner/name，才能比
function repoTail(u) {
  if (!u) return '';
  return String(u).trim()
    .replace(/^git@[^:]+:/, '')
    .replace(/^[a-z]+:\/\/[^/]+\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

async function repoInfo(root) {
  const hit = repoCache.get(root);
  if (hit && Date.now() - hit.at < GIT_CACHE_MS) return hit.promise;
  const promise = (async () => {
    const [status, up, head, log, gitDir, remote] = await Promise.all([
      git(root, ['status', '--porcelain=v1']),
      git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
      git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(root, ['log', '-1', '--format=%h%x1f%cI%x1f%s']),
      git(root, ['rev-parse', '--absolute-git-dir']),
      git(root, ['remote', 'get-url', 'origin']),
    ]);

    const mods = [];
    const unts = [];
    for (const line of (status.stdout || '').split('\n')) {
      if (!line.trim()) continue;
      const xy = line.slice(0, 2).trim();
      const file = line.slice(3);
      if (xy === '??') unts.push(file); else mods.push(file);
    }

    let upstream = null, ahead = null, behind = null;
    if (up.code === 0 && up.stdout.trim()) {
      upstream = up.stdout.trim();
      const lr = await git(root, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
      const nums = (lr.stdout || '').trim().split(/\s+/).map(Number);
      if (lr.code === 0 && nums.length === 2 && nums.every((n) => !Number.isNaN(n))) {
        [behind, ahead] = nums; // 左边是 upstream 独有的（落后），右边是本地独有的（领先）
      }
    }

    let lastCommit = null;
    if (log.code === 0 && log.stdout.trim()) {
      const [hash, at, subject] = log.stdout.trim().split('\x1f');
      lastCommit = { hash, at, subject: subject || '' };
    }

    // .git/FETCH_HEAD 的修改时间 = 上次从远端取数据的时间。
    // 领先/落后是拿本地缓存算的，太久没 fetch 就会失真，得让用户知道。
    let fetchedAt = null;
    const gd = (gitDir.stdout || '').trim();
    if (gd) {
      try { fetchedAt = new Date(fs.statSync(path.join(gd, 'FETCH_HEAD')).mtimeMs).toISOString(); } catch {}
    }

    return {
      state: 'ok',
      root,
      name: path.basename(root),
      branch: (head.stdout || '').trim() || null,
      upstream,
      ahead,
      behind,
      modified: mods.length,
      untracked: unts.length,
      files: mods.slice(0, 6),
      untrackedSample: unts.slice(0, 4),
      lastCommit,
      fetchedAt,
      remoteUrl: (remote.stdout || '').trim(),
    };
  })();
  repoCache.set(root, { at: Date.now(), promise });
  return promise;
}

async function gitState(app) {
  const dir = app.localPath;
  if (!dir) return { state: 'nopath', detail: '这个应用没有登记本地路径' };
  if (!fs.existsSync(dir)) return { state: 'missing', detail: '登记的本地路径不存在' };
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { state: 'norepo', detail: '这个目录不在 git 仓库里' };

  const info = await repoInfo(top.stdout.trim());
  // 登记了仓库、但本地 origin 是另一个（或者压根没有 origin）—— 那就永远推不到该去的地方
  const repoMismatch = !!(app.repo && info.remoteUrl && repoTail(app.repo) !== repoTail(info.remoteUrl));
  const noRemote = !!app.repo && !info.remoteUrl;

  const dirty = info.modified > 0 || info.untracked > 0;
  // 没登记远端也没设 upstream 的纯本地仓库，不当成「忘记同步」
  const wantsSync = !!info.remoteUrl || !!app.repo;
  const unsynced = dirty
    || (info.upstream ? (info.ahead || 0) > 0 : wantsSync)
    || repoMismatch
    || noRemote;

  return { ...info, repoMismatch, noRemote, dirty, unsynced };
}

async function checkApp(app) {
  const localPort = app.localUrl && isLocalUrl(app.localUrl) ? portOf(app.localUrl) : null;
  const [local, online, owner, lcd, git] = await Promise.all([
    probeWithRetry(app.localUrl),
    probeWithRetry(app.onlineUrl),
    localPort ? listenerOf(localPort) : Promise.resolve(null),
    launchdState(app),
    gitState(app),
  ]);
  const ownership = ownershipOf(app, localPort, owner, lcd);
  // 端口通、但登记的目录跟实际进程对不上 —— 不算挂，但要提醒一句
  if (local.status === 'up' && ownership.match === 'unknown' && owner && app.localPath) {
    local.warn = true;
    local.detail = `端口被 ${owner.cmd}（pid ${owner.pid}）占着，目录与登记不符`;
  }
  return { id: app.id, local, online, ownership, launchd: lcd, git };
}

/* --------------------- 探活结果落盘：快照 + 采样流水 --------------------- */

function pruneHealthLog() {
  try {
    const st = fs.statSync(HEALTH_LOG);
    if (st.size < 2 * 1024 * 1024) return;
    const cutoff = Date.now() - HEALTH_KEEP_DAYS * 24 * 3600 * 1000;
    const kept = fs.readFileSync(HEALTH_LOG, 'utf8').split('\n').filter(Boolean).filter((l) => {
      try { return new Date(JSON.parse(l).at).getTime() >= cutoff; } catch { return false; }
    });
    fs.writeFileSync(HEALTH_LOG, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
  } catch {}
}

function saveHealth(snapshot) {
  // 最新快照单独存一份：页面一打开就能看到上次结果，不用干等一轮探活
  try { writeFileAtomic(HEALTH_FILE, JSON.stringify(snapshot, null, 2)); } catch (e) {
    console.error(`[health] 快照写入失败：${e.message}`);
  }
  // 采样流水：只记状态，够算在线率就行，避免撑大文件
  try {
    const rows = snapshot.results.map((r) => JSON.stringify({
      at: snapshot.checkedAt, id: r.id, l: r.local?.status, o: r.online?.status, v: r.ownership?.verified ?? null,
    }));
    fs.appendFileSync(HEALTH_LOG, rows.join('\n') + '\n', 'utf8');
    pruneHealthLog();
  } catch (e) {
    console.error(`[health] 采样写入失败：${e.message}`);
  }
}

function readHealthSnapshot() {
  try { return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')); } catch { return null; }
}

// 在线率：最近 N 小时里，本地/线上探到 up 的采样占比
function uptimeStats(hours = 24) {
  const since = Date.now() - hours * 3600 * 1000;
  const stat = {};
  try {
    for (const line of fs.readFileSync(HEALTH_LOG, 'utf8').split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const t = new Date(e.at).getTime();
      if (!(t >= since)) continue;
      const s = stat[e.id] || (stat[e.id] = { samples: 0, localUp: 0, onlineUp: 0, firstAt: e.at, lastAt: e.at });
      s.samples++;
      if (e.l === 'up') s.localUp++;
      if (e.o === 'up') s.onlineUp++;
      s.lastAt = e.at;
    }
  } catch {}
  for (const k of Object.keys(stat)) {
    const s = stat[k];
    s.localPct = s.samples ? Math.round((s.localUp / s.samples) * 100) : null;
    s.onlinePct = s.samples ? Math.round((s.onlineUp / s.samples) * 100) : null;
  }
  return stat;
}

// 同一时刻只跑一轮探活：定时轮询和手动点「检查」撞在一起时不重复开进程。
// 但**不能把旧结果直接返给手动请求** —— 刚保存的应用会不在结果里，看起来像没生效。
// 所以撞车时排队跑新一轮，其余请求复用这一轮。
let checking = null;
let queued = null;
function checkAll() {
  if (checking) {
    if (!queued) {
      const rerun = () => { queued = null; return checkAll(); };
      queued = checking.then(rerun, rerun);
    }
    return queued;
  }
  const data = readData();
  const p = (async () => {
    const results = await Promise.all(data.apps.map(checkApp));
    const snapshot = { checkedAt: new Date().toISOString(), results };
    saveHealth(snapshot);
    return snapshot;
  })();
  checking = p;
  p.then(() => { checking = null; }, () => { checking = null; });
  return p;
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
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const id = str(input.id) || existing.id || slug(str(input.name) || 'app');
  // 只覆盖表单里真实提交的字段；没提交的保留旧值。
  // 原实现用 `str(x) ?? existing.x`，但 str() 永远返回字符串、从不返回 null，
  // 所以 ?? 永不生效 —— 任何字段缺失的请求都会把它清空。
  const pick = (k, dflt = '') =>
    has(k) ? str(input[k]) : (typeof existing[k] === 'string' ? existing[k] : dflt);
  return {
    id,
    name: has('name') ? (str(input.name) || existing.name || id) : (existing.name || id),
    purpose: pick('purpose'),
    category: CATEGORIES.includes(input.category) ? input.category : (existing.category || '其他'),
    builtBy: BUILT_BY.includes(input.builtBy) ? input.builtBy : (existing.builtBy || 'openclaw'),
    repo: pick('repo'),
    localPath: pick('localPath'),
    localUrl: pick('localUrl'),
    onlineUrl: pick('onlineUrl'),
    deployTarget: pick('deployTarget'),
    localStart: pick('localStart'),
    onlineUpdate: pick('onlineUpdate'),
    launchd: pick('launchd'),
    tags: Array.isArray(input.tags) ? input.tags.map(str).filter(Boolean).slice(0, 8) : (existing.tags || []),
    notes: pick('notes'),
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
      const body = JSON.parse((await readBody(req)) || '{}');
      const out = await withWriteLock(() => {
        const data = readData();
        const wantedId = typeof body.id === 'string' ? body.id.trim() : '';
        let idx = wantedId ? data.apps.findIndex((a) => a.id === wantedId) : -1;
        const existing = idx >= 0 ? data.apps[idx] : {};
        const app = sanitizeApp(body, existing);
        if (idx < 0) idx = data.apps.findIndex((a) => a.id === app.id);
        const isUpdate = idx >= 0;
        if (isUpdate) data.apps[idx] = app; else data.apps.push(app);
        saveData(data);
        appendHistory({
          action: isUpdate ? 'update' : 'create',
          id: app.id,
          name: app.name,
          before: isUpdate ? existing : null,
          after: app,
        });
        return { app, created: !isUpdate };
      });
      return json(res, 200, { ok: true, ...out });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/apps/')) {
      const id = decodeURIComponent(p.split('/').pop());
      const out = await withWriteLock(() => {
        const data = readData();
        const before = data.apps.length;
        const removed = data.apps.find((a) => a.id === id);
        data.apps = data.apps.filter((a) => a.id !== id);
        if (removed) {
          saveData(data);
          appendHistory({ action: 'delete', id, name: removed.name, before: removed, after: null });
        }
        return { removed: before - data.apps.length };
      });
      return json(res, 200, { ok: true, ...out });
    }

    // 改动历史：谁在什么时候改了哪个应用
    if (req.method === 'GET' && p === '/api/history') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
      return json(res, 200, { items: readHistory(limit) });
    }

    // 对远端核实：探活里的 ahead/behind 是拿本地缓存算的，未必等于 GitHub 的真实状态。
    // 这里真去问一次远端分支的 sha（1~2 秒），只在用户点的时候跑。
    if (req.method === 'POST' && p === '/api/git/verify') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const app = readData().apps.find((a) => a.id === body.id);
      if (!app) return json(res, 404, { error: '应用不存在' });
      const g = await gitState(app);
      if (g.state !== 'ok') return json(res, 400, { error: g.detail || '本地不是 git 仓库' });
      if (!g.remoteUrl) return json(res, 400, { error: '本地仓库没有配置远端 origin' });
      const ref = !g.branch || g.branch === 'HEAD' ? 'HEAD' : `refs/heads/${g.branch}`;
      const r = await git(g.root, ['ls-remote', 'origin', ref]);
      if (r.code !== 0) return json(res, 502, { error: (r.stderr || '拉取远端失败').trim().slice(0, 300) });
      const remoteSha = (r.stdout.trim().split(/\s+/)[0] || '');
      const headR = await git(g.root, ['rev-parse', 'HEAD']);
      const headSha = (headR.stdout || '').trim();
      // 远端那个提交本地要是没有，rev-list 会失败 → ahead=null 表示「必须先把远端拉下来才能比」
      let ahead = null;
      if (remoteSha && headSha) {
        const cnt = await git(g.root, ['rev-list', '--count', `${remoteSha}..HEAD`]);
        if (cnt.code === 0) ahead = Number((cnt.stdout || '').trim()) || 0;
      }
      return json(res, 200, {
        id: app.id,
        branch: g.branch,
        remoteSha,
        headSha,
        same: !!remoteSha && remoteSha === headSha,
        ahead,
        dirty: g.modified + g.untracked,
        checkedAt: new Date().toISOString(),
      });
    }

    if (req.method === 'POST' && p === '/api/check') {
      const snap = await checkAll();
      return json(res, 200, { ...snap, uptime: uptimeStats(24) });
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
      // 登记的 label 可能是旧的，先解析出真正在用的那个再动手
      const app = readData().apps.find((a) => a.launchd === label) || { launchd: label };
      const st = await launchdState(app);
      const target = st?.used || label;
      if (action === 'restart') {
        const r = await run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${target}`]);
        if (r.code !== 0) {
          return json(res, 500, { error: (r.stderr || r.stdout || `kickstart ${target} 失败`).trim(), label, used: target });
        }
        return json(res, 200, { ok: true, label, used: target, staleLabel: st?.staleLabel || null, action });
      }
      return json(res, 200, st);
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
      const snap = readHealthSnapshot();
      return json(res, 200, {
        ok: true,
        port: PORT,
        apps: readData().apps.length,
        checkedAt: snap?.checkedAt || null,
        results: snap?.results || [],
        uptime: uptimeStats(24),
      });
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

// 后台定时探活：没人点「检查」的时候也在采样，在线率才有意义。
// 设 WORKBENCH_CHECK_INTERVAL=0 可以关掉。
const CHECK_INTERVAL_MS = Number(process.env.WORKBENCH_CHECK_INTERVAL ?? 120000);
if (CHECK_INTERVAL_MS > 0) {
  const tick = () => { checkAll().catch((e) => console.error(`[health] 定时探活失败：${e.message}`)); };
  setTimeout(tick, 2500).unref();
  setInterval(tick, CHECK_INTERVAL_MS).unref();
}
