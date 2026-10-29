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
const DATA_DIR = path.join(__dirname, 'data');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const PORT = Number(process.env.TASTE_LAB_PORT || 8787);
const DEFAULT_MODEL = process.env.TASTE_LAB_MODEL || 'minimax/MiniMax-M3.1-Flash-Preview';
const RUBRIC_PATH = path.join(__dirname, 'rubric.md');
const OPENCLAW_JSON = path.join(os.homedir(), '.openclaw/openclaw.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

fs.mkdirSync(RUNS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });

/* --------------------------- 配置（模型选择） --------------------------- */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { model: DEFAULT_MODEL };
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}
function currentModel() {
  const cfg = loadConfig();
  return cfg.model || DEFAULT_MODEL;
}

/* --------------------------- 模型注册表 --------------------------- */
function readOpenClawConfig() {
  try {
    return JSON.parse(fs.readFileSync(OPENCLAW_JSON, 'utf8'));
  } catch {
    return {};
  }
}
/**
 * 实测可看图（vision）的能力覆盖表。
 * openclaw.json 里 minimax 的 input 只写了 ["text"]，但实测 MiniMax M3.1 Flash Preview
 * 的 OpenAI 兼容端点与 Anthropic 端点都能接收图片，所以在这里补正标记。
 */
const VISION_CAPABLE = new Set([
  'minimax/MiniMax-M3.1-Flash-Preview',
  'minimax/MiniMax-M3',
  'minimax/MiniMax-M2.7',
  'deepseek/deepseek-flash',
]);

/** 返回可选模型列表（来自 openclaw.json 的 providers + 本地自定义模型） */
function listModels() {
  const providers = readOpenClawConfig().models?.providers || {};
  const out = [];
  for (const [pk, p] of Object.entries(providers)) {
    const models = Array.isArray(p.models) ? p.models : [];
    for (const m of models) {
      out.push({
        id: `${pk}/${m.id}`,
        provider: pk,
        model: m.id,
        name: m.name || m.id,
        api: m.api || p.api || 'openai-completions',
        baseUrl: p.baseUrl || '',
        image: VISION_CAPABLE.has(`${pk}/${m.id}`) ||
               (Array.isArray(m.input) ? m.input.includes('image') : false),
        contextWindow: m.contextWindow || null,
        custom: false,
      });
    }
  }
  // 本地自定义模型（配置页手动添加的）
  const custom = loadConfig().customModels || [];
  for (const c of custom) {
    out.push({ ...c, custom: true });
  }
  return out;
}

/* --------------------------- 行业（中文显示 → 英文 key） --------------------------- */
// value 用 benchmarks.csv 里的英文行业名，才能对上基准库；label 用中文
const INDUSTRIES = [
  { en: '', zh: '不限（用全库中位数）' },
  { en: 'Software/Cloud', zh: '软件 / SaaS / 云服务' },
  { en: 'Internet', zh: '互联网平台' },
  { en: 'Semiconductors', zh: '半导体' },
  { en: 'Hardware/Devices', zh: '硬件 / 消费电子' },
  { en: 'Industrial', zh: '工业制造' },
  { en: 'Auto/Battery', zh: '汽车 / 电池' },
  { en: 'Auto', zh: '汽车' },
  { en: 'Energy', zh: '能源 / 电力' },
  { en: 'Mining', zh: '矿业' },
  { en: 'Conglomerate', zh: '综合集团' },
  { en: 'Finance', zh: '金融 / 银行 / 保险' },
  { en: 'Pharma', zh: '制药' },
  { en: 'Healthcare', zh: '医疗健康' },
  { en: 'Retail', zh: '零售 / 电商' },
  { en: 'Consumer Goods', zh: '快消 / 日用消费品' },
  { en: 'Luxury', zh: '奢侈品 / 高端零售' },
  { en: 'Aerospace', zh: '航空航天 / 国防' },
  { en: 'Media', zh: '传媒 / 内容' },
];
const INDUSTRY_ZH = new Map(INDUSTRIES.map((i) => [i.en, i.zh]));

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

/* --------------------------- 行业基准 --------------------------- */
function loadBenchmarks() {
  try {
    const csv = fs.readFileSync(path.join(DT_SKILL, 'scripts/benchmarks.csv'), 'utf8');
    const lines = csv.trim().split('\n');
    const head = lines[0].split(',');
    return lines.slice(1).map((l) => {
      const cells = l.match(/("[^"]*"|[^,]+)/g).map((c) => c.trim().replace(/^"|"$/g, ''));
      return Object.fromEntries(head.map((h, i) => [h, cells[i]]));
    });
  } catch {
    return [];
  }
}
function industryBaseline(industry) {
  const rows = loadBenchmarks();
  if (!rows.length) return null;
  const peers = industry ? rows.filter((r) => (r.industry || '').toLowerCase() === industry.toLowerCase()) : rows;
  if (!peers.length) return null;
  const scores = peers.map((r) => Number(r.score)).filter((n) => !Number.isNaN(n));
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const top = [...peers].sort((a, b) => Number(b.score) - Number(a.score)).slice(0, 3)
    .map((r) => `${r.company}（${r.score}分，${r.comment || ''}）`);
  return {
    industry, industryZh: INDUSTRY_ZH.get(industry) || industry,
    count: peers.length, avg: Number(avg.toFixed(1)),
    top,
  };
}

function buildJudgePrompt({ mode, metrics, extraContext, baseline }) {
  return `你是一名资深品牌视觉/前端设计总监，正在为一个「审美审查台」工具产出结构化评审结果。

以下是完整的评审准则，请严格按它打分：

---
${fs.readFileSync(RUBRIC_PATH, 'utf8')}
---

以下是脚本采集到的客观指标 JSON：
${JSON.stringify(metrics, null, 2)}

图片已随本消息一并提供，请逐张看图后结合指标给出评审。
${baseline ? `\n## 行业对标基准（${baseline.industryZh}，${baseline.count} 家样本）\n- 同行业平均总分：${baseline.avg}/100\n- 同行业标杆：${baseline.top.join('；')}\n- 评分时请以同行业标杆的审美水位为参照，低于均值的问题要写进 issues。` : ''}
${metrics.loginWall ? '\n⚠️ 注意：本次采集到的是登录页/后台鉴权页，截图不代表真实业务界面。请在 summary 里说明这一点，issues 里不要把登录表单本身当成设计缺陷，而是给出「需要登录态才能看到真实界面」的提示。' : ''}
${metrics.serifCharShare ? `\n⚠️ 字体提醒：检测到页面使用了衬线中文字体（${(metrics.serifFonts || []).join('、') || '宋体/衬线'}），中文网页里这类字体已过时，正文与标题应改用黑体族（思源黑体 / 苹方 / 微软雅黑）。若截图中确实如此，请作为一条 P1 问题写出。` : ''}
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
P0/P1/P2 最多各 2 条，每条 problem 必须指向具体可见问题，fix 必须给出可落地参数。
「fix」写成可以直接交给 AI 编程工具（Claude Code / Cursor 等）执行的中文指令，包含具体数值与改法，不要只说“优化一下”。
「tokens.font_family」在中文网页里不要给宋体/衬线，默认给黑体族。`;
}

/**
 * 解析模型 → 候选 endpoint 列表。
 *
 * 重要：同一个 provider 往往两种协议都支持（例：MiniMax 既有
 * https://api.minimaxi.com/v1/chat/completions 的 OpenAI 兼容端点，
 * 也有 https://api.minimaxi.com/anthropic/v1/messages 的 Anthropic 端点）。
 * 所以这里根据 provider 生成多个候选，按优先级依次尝试，任一成功即返回。
 */
function resolveEndpoints(model) {
  const custom = (loadConfig().customModels || []).find((c) => c.id === model);
  if (custom) {
    return [{
      api: custom.api || 'openai-completions',
      baseUrl: (custom.baseUrl || '').replace(/\/$/, ''),
      apiKey: custom.apiKey || '',
      modelId: custom.model,
      label: custom.name || custom.id,
    }];
  }

  const providers = readOpenClawConfig().models?.providers || {};
  const providerKey = Object.keys(providers).find((k) => model.startsWith(k + '/') || model.startsWith(k + ':'));
  const provider = providers[providerKey];
  if (!provider) throw new Error(`找不到模型 ${model} 的 provider 配置`);
  const modelId = model.replace(new RegExp(`^${providerKey}[/:]`), '');
  const list = Array.isArray(provider.models) ? provider.models : [];
  const meta = list.find((m) => m.id === modelId) || {};
  const declared = meta.api || provider.api || 'openai-completions';
  const base = (provider.baseUrl || '').replace(/\/$/, '');
  const key = provider.apiKey || '';

  const cands = [];
  // OpenAI 兼容：baseUrl 原样拼 /chat/completions
  const openaiBase = base.replace(/\/v1$/, '');
  cands.push({ api: 'openai-completions', baseUrl: openaiBase, apiKey: key, modelId });
  // Anthropic 协议：baseUrl 原样拼 /v1/messages
  cands.push({ api: 'anthropic-messages', baseUrl: base, apiKey: key, modelId });

  // MiniMax：openclaw.json 里配的是 /anthropic 端点，但 OpenAI 兼容端点在 /v1
  if (/\/anthropic$/.test(base)) {
    const host = base.replace(/\/anthropic$/, '');
    cands.unshift({ api: 'openai-completions', baseUrl: host + '/v1', apiKey: key, modelId });
  }

  // 声明的协议排前面
  cands.sort((a, b) => (a.api === declared ? -1 : b.api === declared ? 1 : 0));
  // 去重
  const seen = new Set();
  return cands.filter((c) => {
    const k = c.api + '|' + c.baseUrl;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 单次调用（指定协议） */
async function callEndpoint({ prompt, images, ep }) {
  if (ep.api === 'anthropic-messages') {
    const content = [];
    for (const img of images) {
      const buf = fs.readFileSync(img);
      const mime = img.endsWith('.jpg') || img.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
      content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } });
    }
    content.push({ type: 'text', text: prompt });
    const body = { model: ep.modelId, max_tokens: 12000, messages: [{ role: 'user', content }] };
    const res = await fetch(ep.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ep.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (!text) throw new Error('返回为空');
    return text;
  }

  const content = [{ type: 'text', text: prompt }];
  for (const img of images) {
    const buf = fs.readFileSync(img);
    const mime = img.endsWith('.jpg') || img.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } });
  }
  const body = {
    model: ep.modelId,
    messages: [{ role: 'user', content }],
    max_tokens: 12000,
    temperature: 0.2,
  };
  const res = await fetch(ep.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('返回为空');
  return text;
}

/** 直连视觉模型：多协议自动回退 */
async function callVisionModel({ prompt, images, model }) {
  const eps = resolveEndpoints(model);
  let lastErr = null;
  for (const ep of eps) {
    try {
      const text = await callEndpoint({ prompt, images, ep });
      lastUsed = ep;
      return text;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`模型请求失败（已尝试 ${eps.map((e) => e.api + '@' + e.baseUrl).join(', ')}）：${lastErr?.message || lastErr}`);
}
let lastUsed = null;

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

async function judge({ mode, metrics, images, extraContext, model, baseline }) {
  const prompt = buildJudgePrompt({ mode, metrics, extraContext, baseline });
  const text = await callVisionModel({ prompt, images, model });
  let parsed = null;
  const chunk = extractJsonObject(text);
  if (chunk) {
    try { parsed = JSON.parse(chunk); } catch { parsed = null; }
  }
  if (parsed) return parsed;

  // 失败（含输出被截断）→ 让模型重新输出一次，限制长度
  const retryPrompt = prompt +
    '\n\n【重要】上一次输出失败，可能是太长被截断。请重新输出，summary 不超过 3 句，issues 最多 4 条，next_actions 最多 2 条，务必保证 JSON 完整闭合。';
  const text2 = await callVisionModel({ prompt: retryPrompt, images, model });
  const chunk2 = extractJsonObject(text2);
  if (!chunk2) throw new Error('模型两次都没返回合法 JSON：' + text2.slice(0, 200));
  try {
    return JSON.parse(chunk2);
  } catch (e) {
    const fixed = await callVisionModel({
      model,
      prompt: `下面是上一次评审输出的 JSON，解析失败（${e.message}）。请修复它，只输出合法 JSON 对象，不要任何解释、代码块标记或额外内容。\n\n${chunk2}`,
      images: [],
    });
    const fixedChunk = extractJsonObject(fixed);
    if (!fixedChunk) throw new Error('JSON 修复失败：' + fixed.slice(0, 200));
    return JSON.parse(fixedChunk);
  }
}

/** 登录态文件路径（按 host 存） */
function authStatePath(url) {
  let host = 'unknown';
  try { host = new URL(url).host.replace(/[^a-z0-9.-]/gi, '_'); } catch { /* ignore */ }
  return path.join(AUTH_DIR, host + '.json');
}
function hasAuthState(url) {
  return fs.existsSync(authStatePath(url));
}

async function reviewSite(job) {
  const { url, industry, mobile } = job.input;
  const model = job.input.model || currentModel();
  const runDir = path.join(RUNS_DIR, job.id);
  fs.mkdirSync(runDir, { recursive: true });
  const args = [path.join(DT_SKILL, 'scripts/review_site.py'), url, '--out', runDir, '--lang', 'zh'];
  if (industry) args.push('--industry', industry);
  if (mobile) args.push('--mobile');
  const statePath = authStatePath(url);
  const useAuth = fs.existsSync(statePath);
  if (useAuth) args.push('--storage-state', statePath);
  const r = await run('python3', args, { cwd: DT_SKILL });
  const metricsPath = path.join(runDir, 'metrics.json');
  if (!fs.existsSync(metricsPath)) {
    throw new Error(`采集失败：${(r.stderr || r.stdout).slice(-600)}`);
  }
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const images = ['fold.png', 'full.png', 'mobile.png', 'hero.png']
    .map((f) => path.join(runDir, f))
    .filter((f) => fs.existsSync(f));
  const visual = await judge({ mode: 'site', metrics, images, model, baseline: industryBaseline(industry) });
  const total = Number(
    (0.45 * Number(visual.metric_score ?? metrics.metric_score ?? 0) +
      0.55 * Number(visual.visual_score ?? 0) * 10).toFixed(1)
  );
  return {
    metrics,
    visual: { ...visual, total_score: visual.total_score ?? total, model },
    images: images.map((p) => path.basename(p)),
    usedAuth: useAuth,
    loginWall: !!metrics.loginWall,
  };
}

async function reviewImage(job) {
  const { imagePath, type } = job.input;
  const model = job.input.model || currentModel();
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
  const visual = await judge({ mode: 'image', metrics, images: [imagePath, ...images], model });
  const total = Number(
    (0.6 * Number(visual.metric_score ?? metrics.metric_score ?? 0) +
      0.4 * Number(visual.visual_score ?? 0) * 10).toFixed(1)
  );
  return {
    metrics,
    visual: { ...visual, total_score: visual.total_score ?? total, model },
    images: images.map((p) => path.basename(p)),
  };
}

function startJob(id, mode, input) {
  setJob(id, { status: 'running', mode, input });
  const fn = mode === 'site' ? reviewSite : reviewImage;
  fn(jobs.get(id))
    .then((result) => setJob(id, { status: 'done', result, finishedAt: Date.now() }))
    .catch((err) => setJob(id, { status: 'error', error: String(err.message || err), finishedAt: Date.now() }));
}

/* ------------------------- 整改指令包（给 AI 编程工具用） ------------------------- */
/** 把评审结果转成一段可以直接粘给 Claude Code / Cursor / OpenClaw 的中文指令 */
function buildFixPack(job) {
  const r = job.result || {};
  const v = r.visual || {};
  const m = r.metrics || {};
  const issues = (v.issues || []).map((i) => {
    const tag = `${i.priority || 'P2'}｜${i.area || '未分类'}`;
    return `### [${tag}]\n- 现状：${i.problem || '（未描述）'}\n- 改法：${i.fix || '（未给出）'}\n- 验收：改完后重新截图对比，该问题不应再出现。`;
  }).join('\n\n');

  const tokens = Object.entries(v.tokens || {})
    .filter(([, x]) => x !== undefined && x !== null && x !== '')
    .map(([k, x]) => `  --${k.replace(/_/g, '-')}: ${x};`)
    .join('\n');

  const metrics = [
    `字体族: ${(m.fonts || []).join(', ') || '-'}`,
    `字号档数: ${m.fontSizesSig ?? '-'}`,
    `颜色总数: ${m.colorsTotal ?? '-'}`,
    `圆角值: ${m.radii ?? '-'}`,
    `阴影值: ${m.shadows ?? '-'}`,
    `渐变数: ${m.gradients ?? '-'}`,
    `Hero/正文比: ${m.heroBodyRatio ?? '-'}`,
    `正文对比度: ${m.contrast ?? '-'}`,
    `低于 AA 文本占比: ${m.lowContrastShare != null ? Math.round(m.lowContrastShare * 100) + '%' : '-'}`,
  ].join('\n');

  const lines = [
    `# 审美整改指令：${m.title || job.input?.url || '目标页面'}`,
    '',
    `- 目标页面：${job.input?.url || '-'}`,
    `- 行业对标：${job.input?.industry || '不限'}`,
    `- 当前总分：${v.total_score ?? '-'}/100（指标分 ${v.metric_score ?? m.metric_score ?? '-'}，视觉分 ${v.visual_score ?? '-'}）`,
    '',
    '## 一、审查结论',
    v.summary || v.verdict || '-',
    '',
    '## 二、客观指标（必须全部达标）',
    '```',
    metrics,
    '```',
    '',
    '## 三、设计 token（直接覆盖为这套值）',
    '```css',
    ':root {',
    tokens || '  /* 模型未给出 token */',
    '}',
    '```',
    '',
    '## 四、逐条整改任务（按优先级从高到低执行）',
    issues || '（无问题清单）',
    '',
    '## 五、硬性约束',
    '1. 不改变页面文案含义与业务信息结构，只改视觉呈现与排版。',
    '2. 不引入新的 UI 框架或依赖；只用现有技术栈实现。',
    '3. 颜色总数 ≤ 12，字号档 ≤ 7，圆角值 ≤ 3，阴影 ≤ 2，渐变 ≤ 1。',
    '4. 中文正文字体不得使用宋体/仿宋/楷体等衬线中文字体，改用思源黑体 / 苹方 / 微软雅黑等黑体族。',
    '5. 正文对比度 ≥ 4.5:1，移动端无横向溢出，点击区 ≥ 44px。',
    '6. 改完自行检查一遍上述每一条，并列出改动文件与关键 diff。',
    '',
    '## 六、下一步动作',
    (v.next_actions || []).map((x, i) => `${i + 1}. ${x}`).join('\n') || '-',
  ];
  return lines.join('\n');
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
      startJob(id, 'site', {
        url: body.url,
        industry: body.industry || '',
        mobile: !!body.mobile,
        model: body.model || currentModel(),
      });
      return json(res, 200, { id });
    }

    /* ---------------- 配置 / 模型 / 行业 ---------------- */
    if (req.method === 'GET' && p === '/api/config') {
      return json(res, 200, { ...loadConfig(), model: currentModel(), defaultModel: DEFAULT_MODEL });
    }
    if (req.method === 'POST' && p === '/api/config') {
      const body = JSON.parse(await readBody(req));
      const cfg = loadConfig();
      if (body.model) cfg.model = String(body.model);
      saveConfig(cfg);
      return json(res, 200, { ok: true, ...cfg });
    }
    /* 新增自定义模型 */
    if (req.method === 'POST' && p === '/api/config/custom-model') {
      const body = JSON.parse(await readBody(req));
      if (!body.model || !body.baseUrl) return json(res, 400, { error: '需要 model 与 baseUrl' });
      const cfg = loadConfig();
      const list = cfg.customModels || [];
      const id = body.id || `custom/${body.model}`;
      const entry = {
        id,
        provider: 'custom',
        model: body.model,
        name: body.name || body.model,
        api: body.api || 'openai-completions',
        baseUrl: body.baseUrl.replace(/\/$/, ''),
        apiKey: body.apiKey || '',
        image: body.image !== false,
      };
      const i = list.findIndex((m) => m.id === id);
      if (i >= 0) list[i] = entry; else list.push(entry);
      cfg.customModels = list;
      saveConfig(cfg);
      return json(res, 200, { ok: true, model: entry });
    }
    if (req.method === 'DELETE' && p.startsWith('/api/config/custom-model/')) {
      const id = decodeURIComponent(p.split('/').pop());
      const cfg = loadConfig();
      cfg.customModels = (cfg.customModels || []).filter((m) => m.id !== id);
      saveConfig(cfg);
      return json(res, 200, { ok: true });
    }
    /* 测试模型连通性 */
    if (req.method === 'POST' && p === '/api/config/test-model') {
      const body = JSON.parse(await readBody(req));
      const model = body.model || currentModel();
      try {
        const text = await callVisionModel({ prompt: '只回复两个字：可用', images: [], model });
        return json(res, 200, { ok: true, model, reply: text.slice(0, 120), endpoint: lastUsed });
      } catch (e) {
        return json(res, 400, { ok: false, model, error: String(e.message || e) });
      }
    }
    if (req.method === 'GET' && p === '/api/models') {
      return json(res, 200, { models: listModels(), current: currentModel() });
    }
    if (req.method === 'GET' && p === '/api/industries') {
      return json(res, 200, { industries: INDUSTRIES });
    }
    if (req.method === 'GET' && p === '/api/auth-state') {
      const target = url.searchParams.get('url') || '';
      return json(res, 200, { url: target, hasAuth: hasAuthState(target) });
    }

    /* 登录态采集：拉起可见浏览器，人工登录后保存会话 */
    if (req.method === 'POST' && p === '/api/auth/login') {
      const body = JSON.parse(await readBody(req));
      if (!body.url) return json(res, 400, { error: '缺少 url' });
      const statePath = authStatePath(body.url);
      const logPath = path.join(DATA_DIR, 'auth-login.log');
      const child = spawn('python3', [
        path.join(__dirname, 'scripts/login.py'), body.url, '--out', statePath,
        '--timeout', String(Number(body.timeout) || 300),
      ], { cwd: __dirname, env: process.env, detached: true, stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')] });
      child.unref();
      return json(res, 200, { ok: true, statePath, log: logPath, pid: child.pid });
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
      startJob(id, 'image', { imagePath: imgPath, type: body.type || '', model: body.model || currentModel() });
      return json(res, 200, { id });
    }

    /* 整改指令包：可直接粘给 AI 编程工具 */
    if (req.method === 'GET' && p.endsWith('/fixpack') && p.startsWith('/api/job/')) {
      const id = p.split('/')[3];
      const job = loadJob(id);
      if (!job) return json(res, 404, { error: 'job 不存在' });
      if (job.status !== 'done') return json(res, 400, { error: 'job 尚未完成' });
      const md = buildFixPack(job);
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(md);
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
      return json(res, 200, { ok: true, model: currentModel(), workspace: WORKSPACE });
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
  console.log(`视觉模型: ${currentModel()}`);
});
