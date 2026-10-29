#!/usr/bin/env node
// Taste Lab — 本地「网站/图片审美审查」应用
// 后端：Node 原生 http，无第三方依赖
// 流程：脚本采集指标 (design-taste) -> 视觉模型打分 (Impeccable 框架 + design-taste 审查) -> JSON 结果
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// design-taste 脚本所在目录：优先环境变量，其次 OpenClaw 工作区，最后仓库内
function resolveDtSkill() {
  const candidates = [
    process.env.DESIGN_TASTE_SKILL,
    path.join(os.homedir(), '.openclaw/workspace/skills/design-taste'),
    path.resolve(__dirname, '../..', 'skills/design-taste'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'scripts/review_site.py'))) return c;
  }
  return candidates[1];
}
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(os.homedir(), '.openclaw/workspace');
const DT_SKILL = resolveDtSkill();
const RUNS_DIR = path.join(__dirname, 'runs');
const PORT = Number(process.env.TASTE_LAB_PORT || 8787);
const VISION_MODEL = process.env.TASTE_LAB_MODEL || 'deepseek/deepseek-flash';
const RUBRIC_PATH = path.join(__dirname, 'rubric.md');

fs.mkdirSync(RUNS_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd || __dirname, env: process.env });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** 从混有日志的输出里抽出最外层 JSON 对象 */
function extractJson(text) {
  const start = text.indexOf('\n{\n');
  const candidates = [start, text.indexOf('{')];
  for (const idx of candidates) {
    if (idx < 0) continue;
    const chunk = text.slice(idx);
    try {
      return JSON.parse(chunk);
    } catch {
      /* try to find matching closing brace */
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      if (end > 0) {
        try { return JSON.parse(chunk.slice(0, end)); } catch { /* next */ }
      }
    }
  }
  return null;
}

/* ----------------------------- jobs ----------------------------- */
const jobs = new Map();

function setJob(id, patch) {
  const job = { id, status: 'running', createdAt: Date.now(), ...(jobs.get(id) || {}), ...patch };
  jobs.set(id, job);
  try {
    fs.writeFileSync(path.join(RUNS_DIR, id, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
  } catch { /* ignore */ }
  return job;
}

function loadJob(id) {
  const job = jobs.get(id);
  if (job) return job;
  try {
    const f = path.join(RUNS_DIR, id, 'job.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      jobs.set(id, j);
      return j;
    }
  } catch { /* ignore */ }
  return null;
}

function buildJudgePrompt({ mode, metrics, extraContext }) {
  return `你是一名资深品牌视觉/前端设计总监，正在为一个「审美审查台」工具产出结构化评审结果。

以下是完整的评审准则，请严格按它打分：

---
${fs.readFileSync(RUBRIC_PATH, 'utf8')}
---

以下是脚本采集到的客观指标 JSON：
${JSON.stringify(metrics, null, 2)}

图片已随本消息一并提供，请逐张看图后结合指标给出评审。
${extraContext ? '\n## 附加信息\n' + extraContext : ''}

## 输出格式（严格只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块）
{
  "visual_score": 7.5,
  "metric_score": 93.6,
  "total_score": 90.2,
  "grade": "A",
  "verdict": "一句话结论（中文，40字内）",
  "summary": "2–4 句中文总评",
  "strengths": ["优点1", "优点2"],
  "issues": [
    {"priority": "P0", "area": "版式层级", "problem": "问题描述（中文，具体到可执行）", "fix": "修改建议（给出具体数值/改法）"}
  ],
  "tokens": {"font_family": "推荐字体", "font_size_hero": "64px", "body_size": "16px", "primary_color": "#XXXXXX", "accent_color": "#XXXXXX", "radius": "8px"},
  "next_actions": ["下一步动作1", "下一步动作2"]
}
P0/P1/P2 最多各 2 条，每条 problem 必须指向具体可见问题，fix 必须给出可落地参数。`;
}

/** 直连 OpenAI 兼容的视觉模型 */
async function callVisionModel({ prompt, images, model }) {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw/openclaw.json'), 'utf8'));
  const providers = cfg.models?.providers || {};
  const providerKey = Object.keys(providers).find((k) => model.startsWith(k + '/') || model.startsWith(k + ':'));
  const provider = providers[providerKey];
  if (!provider) throw new Error(`找不到模型 ${model} 的 provider 配置`);
  const modelId = model.replace(new RegExp(`^${providerKey}[/:]`), '');
  const url = provider.baseUrl.replace(/\/$/, '') + '/chat/completions';

  const content = [{ type: 'text', text: prompt }];
  for (const img of images) {
    const buf = fs.readFileSync(img);
    const mime = img.endsWith('.jpg') || img.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } });
  }

  const body = {
    model: modelId,
    messages: [{ role: 'user', content }],
    max_tokens: 12000,
    temperature: 0.2,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`模型请求失败 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('模型返回为空');
  return text;
}

/** 从模型输出里抠出第一个完整 JSON 对象 */
function extractJsonObject(text) {
  const cleaned = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) return cleaned.slice(start, i + 1); }
  }
  return null;
}

async function judge({ mode, metrics, images, extraContext }) {
  const prompt = buildJudgePrompt({ mode, metrics, extraContext });
  const text = await callVisionModel({ prompt, images, model: VISION_MODEL });
  let parsed = null;
  const chunk = extractJsonObject(text);
  if (chunk) {
    try { parsed = JSON.parse(chunk); } catch { parsed = null; }
  }
  if (parsed) return parsed;

  // 失败（含输出被截断）→ 让模型重新输出一次，限制长度
  const retryPrompt = prompt +
    '\n\n【重要】上一次输出失败，可能是太长被截断。请重新输出，summary 不超过 3 句，issues 最多 4 条，next_actions 最多 2 条，务必保证 JSON 完整闭合。';
  const text2 = await callVisionModel({ prompt: retryPrompt, images, model: VISION_MODEL });
  const chunk2 = extractJsonObject(text2);
  if (!chunk2) throw new Error('模型两次都没返回合法 JSON：' + text2.slice(0, 200));
  try {
    return JSON.parse(chunk2);
  } catch (e) {
    const fixed = await callVisionModel({
      model: VISION_MODEL,
      prompt: `下面是上一次评审输出的 JSON，解析失败（${e.message}）。请修复它，只输出合法 JSON 对象，不要任何解释、代码块标记或额外内容。\n\n${chunk2}`,
      images: [],
    });
    const fixedChunk = extractJsonObject(fixed);
    if (!fixedChunk) throw new Error('JSON 修复失败：' + fixed.slice(0, 200));
    return JSON.parse(fixedChunk);
  }
}

async function reviewSite(job) {
  const { url, industry, mobile } = job.input;
  const runDir = path.join(RUNS_DIR, job.id);
  fs.mkdirSync(runDir, { recursive: true });
  const args = [path.join(DT_SKILL, 'scripts/review_site.py'), url, '--out', runDir, '--lang', 'zh'];
  if (industry) args.push('--industry', industry);
  if (mobile) args.push('--mobile');
  const r = await run('python3', args, { cwd: DT_SKILL });
  const metricsPath = path.join(runDir, 'metrics.json');
  if (!fs.existsSync(metricsPath)) {
    throw new Error(`采集失败：${(r.stderr || r.stdout).slice(-600)}`);
  }
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const images = ['fold.png', 'full.png', 'mobile.png', 'hero.png']
    .map((f) => path.join(runDir, f))
    .filter((f) => fs.existsSync(f));
  const visual = await judge({ mode: 'site', metrics, images });
  const total = Number(
    (0.45 * Number(visual.metric_score ?? metrics.metric_score ?? 0) +
      0.55 * Number(visual.visual_score ?? 0) * 10).toFixed(1)
  );
  return { metrics, visual: { ...visual, total_score: visual.total_score ?? total }, images: images.map((p) => path.basename(p)) };
}

async function reviewImage(job) {
  const { imagePath, type } = job.input;
  const runDir = path.join(RUNS_DIR, job.id);
  fs.mkdirSync(runDir, { recursive: true });
  const args = [path.join(DT_SKILL, 'scripts/review_image.py'), imagePath, '--out', runDir, '--lang', 'zh'];
  if (type) args.push('--type', type);
  const r = await run('python3', args, { cwd: DT_SKILL });
  const metricsPath = path.join(runDir, 'metrics.json');
  if (!fs.existsSync(metricsPath)) {
    throw new Error(`图片分析失败：${(r.stderr || r.stdout).slice(-600)}`);
  }
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const images = ['palette.png', 'thirds-overlay.png']
    .map((f) => path.join(runDir, f))
    .filter((f) => fs.existsSync(f));
  const visual = await judge({ mode: 'image', metrics, images: [imagePath, ...images] });
  const total = Number(
    (0.6 * Number(visual.metric_score ?? metrics.metric_score ?? 0) +
      0.4 * Number(visual.visual_score ?? 0) * 10).toFixed(1)
  );
  return { metrics, visual: { ...visual, total_score: visual.total_score ?? total }, images: images.map((p) => path.basename(p)) };
}

function startJob(id, mode, input) {
  setJob(id, { status: 'running', mode, input });
  const fn = mode === 'site' ? reviewSite : reviewImage;
  fn(jobs.get(id))
    .then((result) => setJob(id, { status: 'done', result, finishedAt: Date.now() }))
    .catch((err) => setJob(id, { status: 'error', error: String(err.message || err), finishedAt: Date.now() }));
}

/* ----------------------------- http ----------------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (req.method === 'POST' && p === '/api/review/site') {
      const body = JSON.parse(await readBody(req));
      if (!body.url) return json(res, 400, { error: '缺少 url' });
      const id = 'site-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      fs.mkdirSync(path.join(RUNS_DIR, id), { recursive: true });
      startJob(id, 'site', { url: body.url, industry: body.industry || '', mobile: !!body.mobile });
      return json(res, 200, { id });
    }

    if (req.method === 'POST' && p === '/api/review/image') {
      const body = JSON.parse(await readBody(req));
      if (!body.dataUrl) return json(res, 400, { error: '缺少 dataUrl' });
      const id = 'img-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const runDir = path.join(RUNS_DIR, id);
      fs.mkdirSync(runDir, { recursive: true });
      const ext = (body.filename || 'x.png').split('.').pop().toLowerCase();
      const safeExt = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : 'png';
      const buf = Buffer.from(body.dataUrl.split(',')[1] || '', 'base64');
      const imgPath = path.join(runDir, `input.${safeExt}`);
      fs.writeFileSync(imgPath, buf);
      startJob(id, 'image', { imagePath: imgPath, type: body.type || '' });
      return json(res, 200, { id });
    }

    if (req.method === 'GET' && p.startsWith('/api/job/')) {
      const id = p.split('/').pop();
      const job = loadJob(id);
      if (!job) return json(res, 404, { error: 'job 不存在' });
      return json(res, 200, job);
    }

    if (req.method === 'GET' && p.startsWith('/runs/')) {
      const rel = decodeURIComponent(p.slice('/runs/'.length));
      const file = path.join(RUNS_DIR, rel);
      if (!file.startsWith(RUNS_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === 'GET' && p === '/api/health') {
      return json(res, 200, { ok: true, model: VISION_MODEL, workspace: WORKSPACE });
    }

    // static
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 60 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Taste Lab 已启动: http://127.0.0.1:${PORT}`);
  console.log(`视觉模型: ${VISION_MODEL}`);
});
