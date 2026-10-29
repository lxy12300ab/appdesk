#!/usr/bin/env node
// Taste Lab — 本地「网站/图片审美审查」应用
// 后端：Node 原生 http，无第三方依赖
// 流程：脚本采集指标 (design-taste) -> 视觉模型打分 (Impeccable 框架 + design-taste 审查) -> JSON 结果
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
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

/**
 * 采集引擎：优先用项目内 vendor 的版本（apps/taste-lab/engine/capture.py）。
 * 这样改指标口径不会影响 OpenClaw 工作区里共享的 design-taste skill。
 */
const ENGINE_DIR = path.join(__dirname, 'engine');
const ENGINE_SCRIPT = path.join(ENGINE_DIR, 'capture.py');
const USE_LOCAL_ENGINE = fs.existsSync(ENGINE_SCRIPT);
const CAPTURE_SCRIPT = USE_LOCAL_ENGINE ? ENGINE_SCRIPT : path.join(DT_SKILL, 'scripts/review_site.py');
const CAPTURE_CWD = USE_LOCAL_ENGINE ? ENGINE_DIR : DT_SKILL;

/** 找一个真的装了 playwright 的 python（launchd 下 PATH 不可靠） */
function resolvePython() {
  const cands = [process.env.TASTE_LAB_PYTHON, '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3'].filter(Boolean);
  for (const c of cands) {
    if (c === 'python3' || fs.existsSync(c)) {
      try {
        const probe = spawnSync(c, ['-c', 'import playwright'], { timeout: 8000 });
        if (probe.status === 0) return c;
      } catch { /* try next */ }
    }
  }
  return 'python3';
}
const PYTHON = resolvePython();
const RUNS_DIR = path.join(__dirname, 'runs');
const DATA_DIR = path.join(__dirname, 'data');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const PORT = Number(process.env.TASTE_LAB_PORT || 8787);
const MODEL_TIMEOUT_MS = 240000;
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
    const p = spawn(cmd, args, { cwd: opts.cwd || __dirname, env: opts.env || process.env });
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

// 进程重启后，磁盘上残留的 running 状态没有进程接管，会永远挂着。
// 超过这个时长仍为 running 的，判定为「中断」，直接收敛成 error。
const STALE_JOB_MS = 2 * 60 * 1000;

function loadJob(id) {
  const job = jobs.get(id);
  if (job) return job;
  try {
    const f = path.join(RUNS_DIR, id, 'job.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.status === 'running') {
        const started = j.finishedAt || j.createdAt || Date.now();
        if (Date.now() - started > STALE_JOB_MS) {
          j.status = 'error';
          j.error = j.error || '服务在审查过程中重启，该任务已中断，请重新发起';
          j.finishedAt = Date.now();
          try { fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf8'); } catch { /* ignore */ }
        }
      }
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

function buildJudgePrompt({ mode, metrics, extraContext, baseline, reference, regions, siteRules }) {
  const measured = (metrics.dimensions ? Object.entries(metrics.dimensions)
    .map(([k, d]) => `${k}: ${d.measured ? Math.round(d.score) : '未测（' + (d.why || '') + '）'}`).join('；') : '');
  const regionNames = (regions || []).map((r) => r.label);
  return `你是一名资深品牌视觉/前端设计总监，正在为一个「审美审查台」工具产出结构化评审结果。

以下是完整的评审准则，请严格按它打分：

---
${fs.readFileSync(RUBRIC_PATH, 'utf8')}
---

以下是脚本采集到的客观指标 JSON：
${JSON.stringify(metrics, null, 2)}

${metrics.pageTypeZh ? `页面类型判定：**${metrics.pageTypeZh}**（阈值按此类型取：颜色 ≤${metrics.thresholds?.colorMax}、主标题 ≥${metrics.thresholds?.heroMin}px、正文 ≥${metrics.thresholds?.bodyMin}px）。请按该类型的真实审美水位评审——不要拿营销落地页的尺子去量后台/工具页。` : ''}
${measured ? `各维度实测状态：${measured}。标"未测"的维度是没采到数据，不要凭空编分数或问题。` : ''}
${metrics.colorClusters ? `颜色已按 CIELAB ΔE 聚类：原始 ${metrics.colorsRawTotal} 个色值 → ${metrics.colorsTotal} 个色簇。谈"颜色泛滥"时请以聚类后数字为准，不要把同一灰阶的微差当成多个颜色。` : ''}
${metrics.contrastP50 ? `对比度按真实 WCAG 逐元素计算：正文 P50 = ${metrics.contrastP50.toFixed(2)}:1，低于 AA(4.5) 的文本占 ${((metrics.belowAAShare || 0) * 100).toFixed(1)}%。` : ''}

${siteRules ? `\n## 站点既定规则（优先级高于通用审美偏好）\n${siteRules}\n` : ''}
图片已随本消息一并提供，请逐张看图后结合指标给出评审。
${regionNames.length ? `\n## 分区域评审（必做）\n除了整页截图，本次还提供了按区域裁切的高清图，图前有【区域：xxx】标签：${regionNames.map((n) => '「' + n + '」').join('、')}。
请对**每一个区域**单独过一遍这五项，不许跳过任何一个区域：
1. 留白与间距：区域内间距是否成体系，有无塌陷或拥挤
2. 层级：区域内的主次关系是否一眼可读
3. 对齐：左右边界与基线是否对齐，有无 1–2px 的错位
4. 组件状态：按钮 / 输入框 / 空状态 / 禁用 / hover 是否被明确定义
5. 文案贴合：区域里的文案是否具体，有没有空词
每条 issue 必须标 \`region\` 字段（用上面的区域名；跨区域或整页问题写「全局」）。
如果某个区域确实没毛病，不要为它编问题。` : ''}
${baseline ? `\n## 行业对标基准（${baseline.industryZh}，${baseline.count} 家样本）\n- 同行业平均总分：${baseline.avg}/100\n- 同行业标杆：${baseline.top.join('；')}\n- 评分时请以同行业标杆的审美水位为参照，低于均值的问题要写进 issues。` : ''}
${metrics.loginWall ? '\n⚠️ 注意：本次采集到的是登录页/后台鉴权页，截图不代表真实业务界面。请在 summary 里说明这一点，issues 里不要把登录表单本身当成设计缺陷，而是给出「需要登录态才能看到真实界面」的提示。' : ''}
${metrics.serifCharShare ? `\n⚠️ 字体提醒：检测到页面使用了衬线中文字体（${(metrics.serifFonts || []).join('、') || '宋体/衬线'}），中文网页里这类字体已过时，正文与标题应改用黑体族（思源黑体 / 苹方 / 微软雅黑）。若截图中确实如此，请作为一条 P1 问题写出。` : ''}
${reference ? `\n## 对标参考（重要）\n我们提供了一个参考对象。请学习它优秀的设计手法，用来修我们自己的页面。\n${reference}\n要求：借鉴的是「原理与节奏」，不是具体数值——不要照抄参考对象的色值、字号、圆角，要按我们自己页面的内容重新推导。\n在 issues 里，如果某条问题可以用参考对象的手法解决，就在 fix 里点明「参照参考对象的 XX 手法」。` : ''}
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
    {"priority": "P0", "area": "版式层级", "region": "主栏", "anchor": "页面上那句可见原文", "problem": "问题描述（中文，具体到可执行）", "fix": "修改建议（给出具体数值/改法）"}
  ],
  "tokens": {"font_family": "推荐字体", "font_size_hero": "64px", "body_size": "16px", "primary_color": "#XXXXXX", "accent_color": "#XXXXXX", "radius": "8px"},
  "next_actions": ["下一步动作1", "下一步动作2"],
  "borrow": [{"from": "参考对象的哪个手法", "ours": "我们当前缺什么/哪里弱", "how": "借鉴后具体怎么改（中文，带可落地参数）"}]
}
${regionNames.length ? 'P0/P1/P2 各最多 3 条，总数不超过 9 条；宁缺毋滥，每个区域说到点子上比凑数量重要。' : 'P0/P1/P2 最多各 2 条，每条 problem 必须指向具体可见问题，fix 必须给出可落地参数。'}
「anchor」是从截图上原样抄下来的一句可见文案（2–20 字，按钮文字/标题/标签都行），用来在截图上把这条问题框出来；找不到对应文案就输出空字符串，不要编。
「fix」写成可以直接交给 AI 编程工具（Claude Code / Cursor 等）执行的中文指令，包含具体数值与改法，不要只说“优化一下”。
「tokens.font_family」在中文网页里不要给宋体/衬线，默认给黑体族。
${reference ? '"borrow" 字段：只有在提供了对标参考时才输出，最多 3 条，每条说明「学参考对象的哪个手法 → 我们缺什么 → 具体怎么改」。没有参考对象时输出空数组。' : ''}`;
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

/**
 * 单次调用（指定协议）。
 * images 支持两种元素：
 *   - string                纯图片路径
 *   - { path, label }       带标签的图片，标签会作为文字块插在图片前面
 * 后者用于「同时看我们的页面 + 参考页面并做对比」的场景。
 */
async function callEndpoint({ prompt, images, ep }) {
  if (ep.api === 'anthropic-messages') {
    const content = [];
    for (const item of images) {
      const img = typeof item === 'string' ? item : item.path;
      const label = typeof item === 'string' ? null : item.label;
      if (label) content.push({ type: 'text', text: label });
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
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (!text) throw new Error('返回为空');
    return text;
  }

  const content = [];
  for (const item of images) {
    const img = typeof item === 'string' ? item : item.path;
    const label = typeof item === 'string' ? null : item.label;
    if (label) content.push({ type: 'text', text: label });
    const buf = fs.readFileSync(img);
    const mime = img.endsWith('.jpg') || img.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } });
  }
  content.push({ type: 'text', text: prompt });
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
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
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

async function judge({ mode, metrics, images, extraContext, model, baseline, reference, regions, siteRules }) {
  const prompt = buildJudgePrompt({ mode, metrics, extraContext, baseline, reference, regions, siteRules });
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

/* --------------------------- 整站扫描（Lighthouse） --------------------------- */
/**
 * unlighthouse 0.19 在本机装崩了（嵌套 lighthouse 缺 report-generator.js），
 * 改成 lighthouse CLI + 自家 Playwright 爬虫：
 *   crawl.py 拿同源页面清单 → 逐页跑 lighthouse → 归一化成表格。
 * 只测性能 / 可访问性 / SEO / 最佳实践，不做视觉评审（那是 reviewSite 的活）。
 */
const LH_CLI = path.join(__dirname, 'node_modules/lighthouse/cli/index.js');
const LH_CATS = 'performance,accessibility,seo,best-practices';

function resolveChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  try {
    const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) {
      const cands = [
        path.join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        path.join(base, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
      ];
      for (const c of cands) if (fs.existsSync(c)) return c;
    }
  } catch { /* ignore */ }
  return '';
}
const CHROME_BIN = resolveChrome();

/* Lighthouse 的红项标题是英文长句，给业务方看不动。常见的这批翻成中文短语，
   没收录的（版本新增审计项）原样保留英文，不硬编。 */
const LH_ZH = {
  'uses-deprecated-apis': '用了已废弃的浏览器 API',
  'deprecations': '用了已废弃的浏览器 API',
  'third-party-cookies': '用了第三方 Cookie（会被浏览器逐步封杀）',
  'color-contrast': '文字与背景对比度不足',
  'heading-order': '标题层级跳级（h1 直接跳 h3）',
  'inspector-issues': 'Chrome 开发者工具报了页面错误',
  'bf-cache': '无法进入前进/后退缓存（返回要重新加载）',
  'canonical': '缺少 rel=canonical 规范链接',
  'image-alt': '图片缺少 alt 替代文字',
  'link-name': '链接没有可读文字',
  'button-name': '按钮没有可读文字',
  'label': '表单控件缺少 label',
  'html-has-lang': 'html 标签没有声明语言',
  'meta-description': '缺少 meta description',
  'document-title': '缺少页面标题',
  'is-crawlable': '页面被禁止搜索引擎抓取',
  'hreflang': 'hreflang 多语言配置无效',
  'crawlable-anchors': '链接用了搜索引擎抓不到的写法',
  'link-text': '链接文字没意义（"点击这里"）',
  'tap-targets': '可点区域太小（手指点不准）',
  'font-size': '字号过小',
  'viewport': 'viewport 配置有问题（移动端会缩放）',
  'robots-txt': 'robots.txt 无效',
  'image-aspect-ratio': '图片宽高比被拉伸',
  'unsized-images': '图片没写宽高（加载时页面会跳）',
  'render-blocking-resources': '有阻塞首屏渲染的资源',
  'unused-css-rules': 'CSS 有大量没用到的规则',
  'unused-javascript': 'JS 有大量没用到的代码',
  'uses-responsive-images': '图片尺寸远超实际显示尺寸',
  'modern-image-formats': '图片没用 WebP/AVIF',
  'offscreen-images': '首屏外的图片被提前加载',
  'uses-optimized-images': '图片没压缩',
  'uses-text-compression': '文本没开 gzip/brotli 压缩',
  'uses-long-cache-ttl': '静态资源缓存时间太短',
  'efficient-animated-content': '动图用 GIF 而不是视频',
  'uses-rel-preconnect': '关键第三方域名没加 preconnect',
  'uses-rel-preload': '关键资源没加 preload',
  'redirects': '有多余的跳转链路',
  'font-display': '字体加载阻塞了文字显示',
  'lcp-lazy-loaded': 'LCP 主图被设成懒加载',
  'prioritize-lcp-image': 'LCP 主图没优先加载',
  'non-composited-animations': '动画没走合成层（会卡）',
  'layout-shifts': '页面出现布局抖动',
  'third-party-summary': '第三方脚本拖慢页面',
  'legacy-javascript': '打进了老浏览器兼容代码',
  'duplicated-javascript': 'JS 被重复打包',
  'mainthread-work-breakdown': '主线程任务过重',
  'bootup-time': 'JS 执行耗时过长',
  'dom-size': 'DOM 节点过多',
  'server-response-time': '服务器响应慢',
  'csp-xss': '缺少 CSP 内容安全策略',
  'origin-isolation': '缺少跨源隔离',
  'geolocation-on-start': '一进页面就申请定位权限',
  'notification-on-start': '一进页面就申请通知权限',
  'password-inputs-can-be-pasted-into': '密码框禁止粘贴',
  'plugins': '用了已废弃的插件',
  'valid-source-maps': 'source map 无效',
  'errors-in-console': '控制台有报错',
  'clickjacking-mitigation': '缺少点击劫持防护',
  'has-hsts': '缺少 HSTS',
  'network-dependency-tree': '关键请求链过深',
  'forced-reflow': '脚本触发了强制重排',
  'lcp-request-discovery': 'LCP 资源发现得太晚',
  'lcp-discovery': 'LCP 资源发现得太晚',
  'largest-contentful-paint-element': 'LCP 主元素定位',
  'interactive-element-affordance': '可点元素看不出能点',
  'logical-tab-order': 'Tab 键焦点顺序不合理',
  'focus-traps': '焦点被困住出不来',
  'managed-focus': '页面切换后焦点没跟着走',
  'use-landmarks': '缺少地标区域（屏幕阅读器用）',
  'aria-hidden-focus': 'aria-hidden 元素里还有可聚焦控件',
  'aria-allowed-attr': 'aria 属性用错了',
  'duplicate-id-aria': 'aria 引用的 id 重复',
  'form-field-multiple-labels': '一个表单项挂了多个 label',
};

/** Lighthouse 的 displayValue 是英文（"1 warning found"），能机械翻译的先翻掉 */
function zhValue(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = [
    [/^(\d+) warnings? found$/i, (n) => `${n} 处警告`],
    [/^(\d+) cookies? found$/i, (n) => `${n} 个 Cookie`],
    [/^(\d+) failure reasons?$/i, (n) => `${n} 个原因`],
    [/^(\d+) errors?$/i, (n) => `${n} 个错误`],
    [/^(\d+) (?:resources?|requests?) blocked$/i, (n) => `${n} 个资源被阻塞`],
    [/^(\d+) element(?:s)? failed$/i, (n) => `${n} 个元素未通过`],
    [/^Potential savings of ([\d,]+) ms$/i, (n) => `可节省 ${n} ms`],
    [/^Potential savings of ([\d,.]+) KiB$/i, (n) => `可节省 ${n} KB`],
  ];
  for (const [re, fn] of m) {
    const hit = s.match(re);
    if (hit) return fn(hit[1]);
  }
  return s === 'None' ? null : s;
}

/* 这些指标已经在表格列里单独展示，不再重复塞进「红项」 */
const LH_METRIC_IDS = new Set([
  'first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time',
  'cumulative-layout-shift', 'speed-index', 'interactive',
  'max-potential-fid', 'first-meaningful-paint', 'estimated-input-latency',
  'total-byte-weight',
]);

function normalizeLh(file, url) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const finalUrl = d.finalDisplayedUrl || d.requestedUrl || url;
    const c = d.categories || {};
    const sc = (k) => (c[k] && c[k].score != null ? Math.round(c[k].score * 100) : null);
    const a = d.audits || {};
    const disp = (k) => (a[k] && a[k].displayValue) || null;

    /* ---- 落地检查：先判断「到底测到了什么」，再谈分数 ---- */
    let blocked = '';
    let reason = '';
    if (d.runtimeError) {
      blocked = 'load';
      reason = `页面没加载起来（${d.runtimeError.code}）`;
      const warn = (d.runWarnings || []).find((w) => /redirected to/i.test(w));
      if (warn) reason += ' · Lighthouse 提示：请求被重定向';
    } else {
      let finalPath = '';
      try { finalPath = new URL(finalUrl).pathname; } catch { /* ignore */ }
      if (LOGIN_PATH_RE.test(finalPath) && !LOGIN_PATH_RE.test((() => {
        try { return new URL(url).pathname; } catch { return '/'; }
      })())) {
        blocked = 'login';
        reason = `被弹回登录页（${finalPath}）——测的是登录页，不是这一页`;
      } else if (Object.values(c).every((cat) => cat && cat.score == null)) {
        blocked = 'empty';
        reason = '四张分全为空，等于没测出东西';
      }
    }
    if (blocked) {
      return { url, finalUrl, role: undefined, blocked, error: reason };
    }

    const fails = [];
    for (const [k, v] of Object.entries(a)) {
      if (!v || v.score == null) continue;
      if (LH_METRIC_IDS.has(k)) continue;
      const bad = v.scoreDisplayMode === 'binary'
        ? v.score < 1
        : v.scoreDisplayMode === 'numeric' ? v.score < 0.9 : false;
      if (!bad) continue;
      fails.push({
        id: k,
        title: LH_ZH[k] || LH_ZH[k.replace(/-insight$/, '')] || v.title,
        titleEn: v.title,
        detail: (v.description || '').slice(0, 120),
        value: zhValue(v.displayValue),
        binary: v.scoreDisplayMode === 'binary',
        score: v.score,
      });
    }
    /* 硬错误排在前面，可优化项按严重程度排 */
    fails.sort((x, y) => (Number(y.binary) - Number(x.binary)) || (x.score - y.score));
    const bytes = (a['total-byte-weight'] && a['total-byte-weight'].numericValue) || null;
    const ttfbMs = (a['server-response-time'] && a['server-response-time'].numericValue) || null;
    return {
      url,
      finalUrl,
      scores: {
        performance: sc('performance'), accessibility: sc('accessibility'),
        seo: sc('seo'), bestPractices: sc('best-practices'),
      },
      metrics: {
        lcp: disp('largest-contentful-paint'), cls: disp('cumulative-layout-shift'),
        tbt: disp('total-blocking-time'), fcp: disp('first-contentful-paint'),
        ttfb: ttfbMs ? Math.round(ttfbMs) + ' ms' : disp('server-response-time'),
        weight: bytes ? (bytes / 1024).toFixed(0) + ' KB' : disp('total-byte-weight'),
      },
      fails: fails.slice(0, 12),
      failCount: fails.length,
    };
  } catch (e) {
    return { url, error: String(e.message || e).slice(0, 200), blocked: 'load' };
  }
}

/**
 * 整站扫描：人工指定页面清单 + 类型标签（首页/列表/详情/单页/表单）。
 * 为什么不让爬虫自己挑：Lighthouse 的分数是跟着「页面模板」走的，不是跟着页面数量走的。
 * 自动抓 6 页很可能是 5 个详情页 + 首页，列表页和单页一个没测到——数量够了，覆盖没够。
 * 所以爬虫降级成「候选建议」（/api/audit/discover），由人决定测哪几页、每页是什么类型。
 */
const AUDIT_ROLES = {
  home: '首页', dashboard: '工作台', list: '列表', detail: '详情',
  form: '表单/流程', single: '单页', settings: '设置', other: '其他',
  flow: '表单/流程', // 老数据兼容
};

/* 后台/管理系统里这几类才是主力模板；用到就说明不是公开官网 */
const BACKEND_ROLES = new Set(['dashboard', 'form', 'settings']);
/* 落到这些路径，基本可以断定是被登录墙弹回来了 */
const LOGIN_PATH_RE = /(^|\/)(login|log-in|signin|sign-in|sign_in|auth|sso|passport|cas|oauth|authorize|session\/new)(\/|$|\.)/i;

/** 补协议 + 校验；URL 归一化后顺便当去重键 */
function ensureUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const withProto = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  try {
    const u = new URL(withProto);
    if (!u.hostname || !u.hostname.includes('.')) return '';
    return u.toString();
  } catch { return ''; }
}

/** 补协议、去重、限条数；role 落库前先归一到合法值 */
function normalizeAuditTargets(raw, fallbackUrl) {
  const out = [];
  const seen = new Set();
  const arr = Array.isArray(raw) ? raw : [];
  for (const it of arr) {
    const u = ensureUrl(typeof it === 'string' ? it : (it && it.url) || '');
    if (!u) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    const role = it && AUDIT_ROLES[it.role] ? it.role : 'other';
    out.push({ url: u, role });
  }
  if (!out.length && fallbackUrl) {
    const u = ensureUrl(fallbackUrl);
    if (u) out.push({ url: u, role: 'home' });
  }
  return out.slice(0, 12);
}

/**
 * 从路径猜页面类型，只用来预填候选，人可以改。
 * 顺序很重要：先判「详情」（`xxx-case` 里有 case 但那不是列表），再判「容器型列表」，最后才是单页。
 * 猜错不要紧，这是给人省几下手的事，不是自动决策。
 */
const ROLE_CONTAINERS = new Set([
  'cases', 'case', 'news', 'articles', 'article', 'products', 'product',
  'projects', 'project', 'blog', 'list', 'lists', 'category', 'showroom',
  'gallery', 'portfolio', 'works', 'solutions',
]);
const ROLE_SINGLE = /^(about|aboutus|about-us|contact|contactus|contact-us|service|services|faq|team|join|jobs|honor|honors|intro|introduction|culture|company|profile)$/;

function guessRole(u) {
  let pathname = '/';
  try { pathname = new URL(u).pathname; } catch { return 'other'; }
  const p = decodeURIComponent(pathname).toLowerCase().replace(/\/+$/, '');
  if (!p) return 'home';
  if (/\/(index|default)\.(html?|php|aspx?)$/.test(p)) return 'home';

  const segs = p.split('/').filter(Boolean);
  const last = segs[segs.length - 1] || '';

  /* 1. 详情：显式标记，或「案例/产品名 + case」这种复合词，或带数字尾缀的 slug */
  if (/detail|content|\/p\/|view/.test(p)) return 'detail';
  if (/(^|[-_])case([-_]|$)/.test(last) && !ROLE_CONTAINERS.has(last)) return 'detail';
  if (/-case$|^case-|_case$/.test(last)) return 'detail';
  if (/\d{2,}$/.test(last) && /[a-z]/.test(last) && last.length > 8) return 'detail';

  /* 2. 容器型列表：`/cases`、`/news`、`/list_40`、`/articles` */
  if (ROLE_CONTAINERS.has(last)) return 'list';
  if (/^(list|page|index|column|cat)[-_]?\d*$/.test(last)) return 'list';
  if (/(^|[-_])(list|category)([-_]|$)/.test(last)) return 'list';

  /* 3. 单页：关于、联系、服务、FAQ 这类固定栏目 */
  if (ROLE_SINGLE.test(last)) return 'single';
  if (/^(about|contact|service|join|honor|intro)/.test(last) && last.length <= 14) return 'single';

  /* 4. 后台/管理系统的固定模板 */
  if (/(^|\/)(dashboard|workbench|home|overview|index|console|main)(\/|$)/.test(p)) return 'dashboard';
  if (/(^|\/)(setting|settings|preference|preferences|config|configs|profile|account|users?|roles?|permission)s?(\/|$)/.test(p)) return 'settings';
  if (/(new|create|add|edit|update)(\/|$)/.test(p) || /(^|[-_])(new|create|edit)([-_]|$)/.test(last)) return 'form';
  if (/form|apply|submit|quote|signup|register|budget|calculator/.test(last)) return 'form';

  return 'other';
}

/**
 * 后台/管理系统的登录态。
 * Lighthouse 是独立起一个干净 Chrome，不认 Playwright 的 storage_state，
 * 唯一能带进去的是 `--extra-headers`（每个请求都附上）。
 * 所以这里存的是**请求头**，不是 cookie jar：Cookie 串或 Authorization 都能塞。
 * 实测（本地登录墙站点）：`--extra-headers '{"Cookie":"sid=ok"}'` 能让 finalUrl 停在受保护页。
 * 反过来 `--chrome-flags=--user-data-dir=...` 没用——chrome-launcher 会再塞自己的 profile，cookie 读不到。
 */
function authHeadersPath(url) {
  let host = 'unknown';
  try { host = new URL(url).host.replace(/[^a-z0-9.-]/gi, '_'); } catch { /* ignore */ }
  return path.join(AUTH_DIR, host + '.headers.json');
}

/** 只回显尾巴几位，避免把整串 cookie 打到前端 */
function mask(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 12) return '••••';
  return s.slice(0, 6) + '••••' + s.slice(-4);
}

function loadAuthHeaders(url) {
  try {
    const d = JSON.parse(fs.readFileSync(authHeadersPath(url), 'utf8'));
    const h = {};
    if (d.cookie) h.Cookie = String(d.cookie);
    if (d.authorization) h.Authorization = String(d.authorization);
    return Object.keys(h).length ? h : null;
  } catch { return null; }
}

function saveAuthHeaders(url, { cookie, authorization }) {
  const p = authHeadersPath(url);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!cookie && !authorization) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
    return null;
  }
  const d = {
    cookie: cookie ? String(cookie).trim() : '',
    authorization: authorization ? String(authorization).trim() : '',
    savedAt: Date.now(),
  };
  fs.writeFileSync(p, JSON.stringify(d, null, 2));
  return d;
}

/**
 * 从 login.py 保存的 storage_state 里捞出可用请求头。
 * cookie 直接拼 Cookie 串；localStorage 里如果有像 token 的键，猜成 Bearer——
 * 猜错了不要紧，落地检查会把结果标成「被登录墙挡住」，不会给假分数。
 */
function headersFromState(url) {
  let st;
  try { st = JSON.parse(fs.readFileSync(authStatePath(url), 'utf8')); } catch { return null; }
  const cookies = Array.isArray(st.cookies) ? st.cookies : [];
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  let authorization = '';
  for (const o of st.origins || []) {
    for (const item of o.localStorage || []) {
      if (!/token|jwt|auth|session/i.test(item.name)) continue;
      const v = String(item.value || '').replace(/^"|"$/g, '');
      if (v.length < 12) continue;
      authorization = /^bearer\s/i.test(v) ? v : 'Bearer ' + v;
      break;
    }
    if (authorization) break;
  }
  if (!cookie && !authorization) return null;
  return { cookie, authorization, savedAt: Date.now() };
}

/** 调 crawl.py 的参数：有登录态就一起带上，否则后台站点永远只发现 1 页 */
function crawlArgs(target, max) {
  const args = [path.join(ENGINE_DIR, 'crawl.py'), target, '--max', String(max)];
  const h = loadAuthHeaders(target);
  if (h && h.Cookie) args.push('--cookie', h.Cookie);
  if (h && h.Authorization) args.push('--authorization', h.Authorization);
  return args;
}

async function runAudit(job) {
  const { url, maxPages, urls } = job.input;
  const runDir = path.join(RUNS_DIR, job.id);
  fs.mkdirSync(runDir, { recursive: true });

  if (!fs.existsSync(LH_CLI)) throw new Error('缺 lighthouse，先在 apps/taste-lab 下执行 npm i');
  if (!CHROME_BIN) throw new Error('找不到可用的 Chrome（Playwright 缓存里没有 chromium）');

  /* 1. 目标清单：人工给的优先（哪怕只给一页，也照办）；完全没给才退回自动爬 */
  const manual = (Array.isArray(urls) ? urls : []).some((x) => ensureUrl(typeof x === 'string' ? x : (x && x.url) || ''));
  let targets = normalizeAuditTargets(urls, manual ? '' : url);
  let source = 'manual';
  if (!manual || !targets.length) {
    /* 只给了域名、没给清单 → 自动发现补位（source='crawl'，界面会标「自动发现」） */
    const want = Math.max(2, Math.min(Number(maxPages) || 6, 12));
    setJob(job.id, { progress: { phase: 'crawl', done: 0, total: want, text: '正在发现候选页面…' } });
    const cr = await run(PYTHON, crawlArgs(url || (targets[0] && targets[0].url), want), { cwd: ENGINE_DIR });
    let list = [];
    try {
      const line = String(cr.stdout || '').trim().split('\n').pop();
      list = JSON.parse(line).pages || [];
    } catch { /* ignore */ }
    if (!list.length) {
      throw new Error('没爬到可扫描的同源页面：' + String(cr.stderr || '').slice(-300));
    }
    source = 'crawl';
    const seen = new Set(targets.map((t) => t.url));
    for (const u of list) {
      if (seen.has(u)) continue;
      seen.add(u);
      targets.push({ url: u, role: guessRole(u) });
      if (targets.length >= want) break;
    }
  }
  if (!targets.length) throw new Error('没有可扫描的页面');

  /* 2. 逐页跑 lighthouse（串行，避免抢 CPU 把分数跑崩） */
  const hdrs = loadAuthHeaders((targets[0] && targets[0].url) || url || '');
  const headerArg = hdrs ? '--extra-headers=' + JSON.stringify(hdrs) : null;
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const { url: pageUrl, role } = targets[i];
    setJob(job.id, {
      progress: { phase: 'scan', done: i, total: targets.length, text: `${AUDIT_ROLES[role]} · ${pageUrl}` },
    });
    const out = path.join(runDir, `lh-${i}.json`);
    const args = [
      LH_CLI, pageUrl,
      '--output=json', '--output-path=' + out,
      '--only-categories=' + LH_CATS,
      '--chrome-flags=--headless=new --no-sandbox --disable-gpu',
      '--quiet',
    ];
    if (headerArg) args.push(headerArg);
    const r = await run(process.execPath, args, { cwd: __dirname, env: { ...process.env, CHROME_PATH: CHROME_BIN } });
    if (fs.existsSync(out)) {
      results.push({ ...normalizeLh(out, pageUrl), role });
    } else {
      const msg = String(r.stderr || r.stdout || '未生成报告').slice(-160);
      results.push({ url: pageUrl, role, error: msg, blocked: 'load' });
    }
  }

  /* 被登录墙挡住 / 压根没加载起来的页，不能参与均值——否则就是拿登录页的分数冒充后台页 */
  const ok = results.filter((r) => !r.error && !r.blocked);
  const blockedList = results.filter((r) => r.blocked).map((r) => ({
    url: r.url, role: r.role, blocked: r.blocked, reason: r.error || '',
  }));
  const avgOf = (rows, k) => {
    const vals = rows.map((r) => r.scores && r.scores[k]).filter((v) => typeof v === 'number');
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };
  const avg = (k) => avgOf(ok, k);

  /* 按模板聚合：同类页面取均值，不同模板之间的差距才是改版的落点 */
  const byRole = Object.keys(AUDIT_ROLES)
    .map((role) => {
      const rows = ok.filter((r) => r.role === role);
      if (!rows.length) return null;
      return {
        role, label: AUDIT_ROLES[role], count: rows.length,
        performance: avgOf(rows, 'performance'), accessibility: avgOf(rows, 'accessibility'),
        seo: avgOf(rows, 'seo'), bestPractices: avgOf(rows, 'bestPractices'),
      };
    })
    .filter(Boolean);

  const isBackend = targets.some((t) => BACKEND_ROLES.has(t.role));
  return {
    scanUrl: (targets.find((t) => t.role === 'home') || targets[0]).url,
    source,
    pageCount: results.length,
    okCount: ok.length,
    blocked: blockedList,
    blockedCount: blockedList.length,
    allBlocked: results.length > 0 && ok.length === 0,
    authUsed: !!hdrs,
    isBackend,
    summary: {
      performance: avg('performance'), accessibility: avg('accessibility'),
      seo: avg('seo'), bestPractices: avg('bestPractices'),
    },
    byRole,
    worst: ok.slice().sort((a, b) => (a.scores.performance || 0) - (b.scores.performance || 0)).slice(0, 3)
      .map((r) => ({ url: r.url, role: r.role, performance: r.scores.performance })),
    pages: results,
    chromeMissing: !CHROME_BIN,
  };
}

/** 候选页面建议（不跑 lighthouse，只爬链接 + 猜类型） */
async function discoverPages(url, maxPages) {
  const want = Math.max(2, Math.min(Number(maxPages) || 12, 24));
  const cr = await run(PYTHON, crawlArgs(url, want), { cwd: ENGINE_DIR });
  let payload = {};
  try {
    payload = JSON.parse(String(cr.stdout || '').trim().split('\n').pop()) || {};
  } catch { /* ignore */ }
  const pages = payload.pages || [];
  if (!pages.length) throw new Error('没爬到同源链接：' + String(cr.stderr || '').slice(-200));
  return {
    candidates: pages.map((u) => ({ url: u, role: guessRole(u), label: AUDIT_ROLES[guessRole(u)] })),
    total: payload.total || pages.length,
    authUsed: !!loadAuthHeaders(url),
  };
}

function authStatePath(url) {
  let host = 'unknown';
  try { host = new URL(url).host.replace(/[^a-z0-9.-]/gi, '_'); } catch { /* ignore */ }
  return path.join(AUTH_DIR, host + '.json');
}
function hasAuthState(url) {
  return fs.existsSync(authStatePath(url));
}

/** 送给模型的指标：去掉元素目录这类几十 KB 的原始数据 */
const HEAVY_METRIC_KEYS = ['catalog', 'notable', 'suspects', 'stateShots', 'images'];
function metricsForPrompt(m) {
  const out = {};
  for (const [k, v] of Object.entries(m || {})) if (!HEAVY_METRIC_KEYS.includes(k)) out[k] = v;
  return out;
}

/** 读元素目录（截图标注用） */
function loadElements(runDir) {
  try { return JSON.parse(fs.readFileSync(path.join(runDir, 'elements.json'), 'utf8')); } catch { return null; }
}

/** 读分区截图（分块评审用） */
function loadRegions(runDir) {
  try { return JSON.parse(fs.readFileSync(path.join(runDir, 'regions.json'), 'utf8')).items || []; } catch { return []; }
}

/* --------------------------- 站点设计系统基线 --------------------------- */
/**
 * 后台类站点有几十上百个页面，逐页"审美评审"没有意义。
 * 正确做法：首页当母版，把设计系统落成基线（色板/字号档/圆角族/字体族），
 * 后续页面只做"是否守规则 + 哪里破了"的一致性审计。
 *
 * 偏离检测走脚本（ΔE 比对），确定、可复现；模型只负责判断哪些偏离是真问题。
 */
const SITES_DIR = path.join(DATA_DIR, 'sites');
fs.mkdirSync(SITES_DIR, { recursive: true });

/** 找该 host 最近一次成功的 site 审查（建基线时没传 jobId 就用它） */
function latestDoneJobForHost(targetUrl) {
  const host = hostOf(targetUrl);
  let best = null;
  let bestTime = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(RUNS_DIR); } catch { return null; }
  for (const d of dirs) {
    if (!d.startsWith('site-')) continue;
    const j = loadJob(d);
    if (!j || j.status !== 'done' || !j.result || !j.result.metrics) continue;
    const u = (j.input && j.input.url) || j.result.metrics.url || '';
    if (hostOf(u) !== host) continue;
    if ((j.createdAt || 0) > bestTime) { bestTime = j.createdAt || 0; best = j; }
  }
  return best;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'unknown'; }
}
function baselinePath(url) {
  return path.join(SITES_DIR, hostOf(url).replace(/[^a-z0-9.-]/gi, '_') + '.json');
}
function loadBaseline(url) {
  try { return JSON.parse(fs.readFileSync(baselinePath(url), 'utf8')); } catch { return null; }
}
function saveBaseline(url, b) {
  fs.writeFileSync(baselinePath(url), JSON.stringify(b, null, 2), 'utf8');
  return b;
}

function hexToLab(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const [r, g, b] = rgb.map(f);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const [fx, fy, fz] = [t(x), t(y), t(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function deltaE(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** 从一次审查的指标里抽出设计系统基线 */
function tokensFromMetrics(m, jobId) {
  const colors = [];
  for (const g of ['text', 'bg', 'border']) {
    for (const c of (m.colorClusters && m.colorClusters[g]) || []) if (c.hex) colors.push(c.hex);
  }
  const sizes = [];
  for (const s of m.fontSizes || []) {
    const px = String(s).split('×')[0].trim();
    if (px && !sizes.includes(px)) sizes.push(px);
  }
  return {
    host: hostOf(m.url || m.finalUrl || ''),
    createdAt: Date.now(),
    fromJob: jobId || null,
    pageType: m.pageType || null,
    colors: [...new Set(colors)],
    fontSizes: sizes,
    fontFamilies: [...new Set(m.fonts || [])],
    radii: [...new Set(m.radiiList || [])],
    weights: [...new Set(m.fontWeightsList || [])],
    bodySize: m.bodySize ?? null,
    heroSize: m.heroSize ?? null,
    shadows: m.shadows || 0,
    gradients: m.gradients || 0,
  };
}

/** 确定性偏离比对：新页面 vs 站点基线 */
function diffBaseline(m, base) {
  if (!base) return null;
  const items = [];
  const push = (o) => items.push(o);

  const knownLabs = (base.colors || []).map(hexToLab).filter(Boolean);
  const seen = new Set();
  for (const g of ['text', 'bg', 'border']) {
    for (const c of (m.colorClusters && m.colorClusters[g]) || []) {
      if (!c.hex || seen.has(c.hex)) continue;
      seen.add(c.hex);
      const lab = hexToLab(c.hex);
      if (!lab || !knownLabs.length) continue;
      if (!knownLabs.some((k) => deltaE(lab, k) <= 6)) {
        push({ type: 'color', value: c.hex, count: c.count || 0, hint: '基线色板里没有这个颜色' });
      }
    }
  }

  const baseSizes = new Set((base.fontSizes || []).map(String));
  for (const s of m.fontSizes || []) {
    const [px, cnt] = String(s).split('×');
    if (baseSizes.size && !baseSizes.has(String(px).trim())) {
      push({ type: 'font-size', value: String(px).trim(), count: Number(cnt) || 1, hint: '基线字号档里没有这个尺寸' });
    }
  }

  const baseRadii = new Set((base.radii || []).map(String));
  for (const r of m.radiiList || []) {
    if (baseRadii.size && !baseRadii.has(String(r))) push({ type: 'radius', value: String(r), hint: '基线圆角族里没有这个值' });
  }

  const baseFams = new Set((base.fontFamilies || []).map(String));
  for (const f of m.fonts || []) {
    if (baseFams.size && !baseFams.has(String(f))) push({ type: 'font-family', value: String(f), hint: '基线字体族里没有' });
  }

  if (base.bodySize && m.bodySize && Math.abs(Number(m.bodySize) - Number(base.bodySize)) >= 1) {
    push({ type: 'body-size', value: `${m.bodySize}px`, base: `${base.bodySize}px`, hint: '正文基准字号与基线不一致' });
  }

  items.sort((a, b) => (b.count || 0) - (a.count || 0));
  return {
    baseline: { createdAt: base.createdAt, fromJob: base.fromJob, pageType: base.pageType, counts: {
      colors: (base.colors || []).length, fontSizes: (base.fontSizes || []).length, radii: (base.radii || []).length,
    } },
    items: items.slice(0, 20),
    driftScore: Math.min(100, items.length * 8),
  };
}

function siteRulesBrief(base, drift) {
  if (!base) return '';
  const d = new Date(base.createdAt);
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const lines = [
    `这个站点已建立设计系统基线（建立于 ${stamp}，母版页面类型：${base.pageType || '未记录'}）。以下视为既定事实，不要重新发明：`,
    `- 色板（${(base.colors || []).length} 个）：${(base.colors || []).join(' ')}`,
    `- 字号档（${(base.fontSizes || []).length} 档）：${(base.fontSizes || []).join(' ')}`,
    `- 圆角族：${(base.radii || []).join(' ') || '未记录'}`,
    `- 字体族：${(base.fontFamilies || []).join(' ') || '未记录'}`,
    `- 正文基准：${base.bodySize ? base.bodySize + 'px' : '未记录'}`,
  ];
  if (drift && drift.items.length) {
    lines.push('', '脚本已做客观比对，本页出现以下**偏离基线**的地方（不全是错的）：');
    for (const it of drift.items.slice(0, 12)) {
      const cnt = it.count ? `（${it.count} 处）` : '';
      lines.push(`- [${it.type}] ${it.value}${cnt}：${it.hint}`);
    }
    lines.push('', '请在 issues 里逐项判断：哪些是真问题（该改回基线）、哪些是合理扩展（该把新值补进设计系统）。'
      + '合理的偏离不要报成问题。对应的 fix 写成二选一的可执行指令：「改用基线里的 X」或「把 Y 补进设计系统并说明用途」。');
    const big = drift.items.filter((it) => (it.count || 0) >= 50);
    if (big.length) {
      lines.push(`注意：${big.map((it) => `${it.type} ${it.value}（${it.count} 处）`).join('、')} 出现次数很多，`
        + '说明不是个别例外而是体系问题，必须单独写成一条 P1，不要混在其他条目里带过。');
    }
  } else if (drift) {
    lines.push('', '本页没有发现偏离基线的色值/字号/圆角，一致性良好——不要为了凑数报一致性问题。');
  }
  return lines.join('\n');
}

/**
 * 把模型给的 anchor 文案匹配回元素 bbox，让每条问题能在截图上被框出来。
 * 没有 bbox 的建议只能靠人自己在图里找——这是"报告不可执行"的主因之一。
 */
function annotateIssues(issues, elements) {
  const cat = (elements && elements.catalog) || [];
  if (!cat.length) return [];
  const norm = (s) => String(s || '').replace(/[\s　]+/g, '').trim();
  const out = (issues || []).map((it) => {
    const quoted = (String(it.problem || '').match(/[「『“"]([^」』”"]{2,20})[」』”"]/g) || []).map((s) => s.slice(1, -1));
    const anchors = [it.anchor, ...quoted].map(norm).filter(Boolean);
    let best = null;
    let bestScore = 0;
    for (const a of anchors) {
      if (a.length < 2) continue;
      for (const el of cat) {
        const t = norm(el.text);
        if (!t) continue;
        let score = 0;
        if (t === a) score = 1;
        else if (t.includes(a) || a.includes(t)) score = (Math.min(t.length, a.length) / Math.max(t.length, a.length)) * 0.9;
        if (score > bestScore) { bestScore = score; best = el; }
      }
      if (bestScore >= 0.99) break;
    }
    if (!best || bestScore < 0.6) return null;
    const b = best.box;
    return {
      box: b,
      shot: b.y + b.h <= 900 ? 'fold.png' : 'full.png',
      text: best.text,
      selector: best.selector,
      confidence: Math.round(bestScore * 100) / 100,
    };
  });
  return out;
}

async function reviewSite(job) {
  const { url, industry, mobile } = job.input;
  const model = job.input.model || currentModel();
  const runDir = path.join(RUNS_DIR, job.id);
  fs.mkdirSync(runDir, { recursive: true });

  /* ---- 第 1 步：采集参考对象 ---- */
  const refInput = job.input.reference || null;
  let reference = null;
  if (refInput && (refInput.url || (refInput.images && refInput.images.length))) {
    const refDir = path.join(runDir, 'reference');
    fs.mkdirSync(refDir, { recursive: true });
    const refImages = [];
    let refMetrics = null;

    if (refInput.url) {
      try {
        const cap = await captureReferenceSite(refInput.url, path.join(refDir, 'site'));
        refMetrics = cap.metrics;
        refImages.push(...cap.images.map((p) => ({ path: p, label: '【参考对象截图】' })));
      } catch (e) {
        refInput.urlError = String(e.message || e);
      }
    }
    // 用户直接上传的参考截图
    for (const p of refInput.images || []) {
      refImages.push({ path: p, label: '【用户提供的参考截图】' });
    }

    if (refImages.length) {
      /* ---- 第 2 步：提炼可迁移的设计手法 ---- */
      try {
        const analysis = await analyzeReference({
          metrics: refMetrics || {},
          images: refImages.map((x) => x.path),
          notes: refInput.notes || '',
          model,
        });
        reference = { notes: refInput.notes || '', analysis, images: refImages, metrics: refMetrics };
      } catch (e) {
        reference = { notes: refInput.notes || '', analysisError: String(e.message || e), images: refImages, metrics: refMetrics };
      }
    }
  }

  /* ---- 采集当前页面 ---- */
  const args = [CAPTURE_SCRIPT, url, '--out', runDir];
  if (USE_LOCAL_ENGINE) {
    args.push('--breakpoints', '390,768,1440,1920');
    if (industry) args.push('--industry', industry);
  } else {
    args.push('--lang', 'zh');
    if (industry) args.push('--industry', industry);
    if (mobile) args.push('--mobile');
  }
  const statePath = authStatePath(url);
  const useAuth = fs.existsSync(statePath);
  if (useAuth) args.push('--storage-state', statePath);
  const r = await run(PYTHON, args, { cwd: CAPTURE_CWD, timeout: 240000 });
  const metricsPath = path.join(runDir, 'metrics.json');
  if (!fs.existsSync(metricsPath)) {
    throw new Error(`采集失败：${(r.stderr || r.stdout).slice(-600)}`);
  }
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const elements = loadElements(runDir);
  const regions = loadRegions(runDir);
  // 整页图 + 分区高清图。有分区图时不再重复喂 full.png（分区已覆盖整页）
  const regionPicks = regions.slice(0, 3);
  const baseShots = regionPicks.length
    ? ['fold.png', 'mobile.png', 'states/hover.png']
    : ['fold.png', 'full.png', 'mobile.png', 'states/hover.png'];
  const images = [...baseShots, ...regionPicks.map((r) => r.path), 'hero.png']
    .map((f) => path.join(runDir, f))
    .filter((f) => fs.existsSync(f));

  /* ---- 第 3 步：主评审（带上参考页面截图与手法） ---- */
  /* 站点基线：有这个站的母版就做一致性审计，没有就按通用标准评 */
  const siteBase = loadBaseline(url);
  const drift = diffBaseline(metrics, siteBase);
  const regionLabel = new Map(regionPicks.map((r) => [path.join(runDir, r.path), `【区域：${r.label}】`]));
  const ours = images.map((p) => ({ path: p, label: regionLabel.get(p) || '【整页 / 状态截图】' }));
  const judgeImages = reference ? [...ours, ...reference.images] : ours;
  const visual = await judge({
    mode: 'site', metrics: metricsForPrompt(metrics), images: judgeImages, model,
    baseline: industryBaseline(industry),
    reference: referenceBrief(reference),
    regions: regionPicks,
    siteRules: siteRulesBrief(siteBase, drift),
  });
  const total = Number(
    (0.45 * Number(visual.metric_score ?? metrics.metric_score ?? 0) +
      0.55 * Number(visual.visual_score ?? 0) * 10).toFixed(1)
  );
  return {
    metrics,
    visual: { ...visual, total_score: visual.total_score ?? total, model },
    images: images.map((p) => path.relative(runDir, p)),
    annotations: annotateIssues(visual.issues, elements),
    pageType: metrics.pageType,
    site: {
      baselineExists: !!siteBase,
      canCreateBaseline: !siteBase,
      host: hostOf(url),
      drift: drift || null,
    },
    usedAuth: useAuth,
    loginWall: !!metrics.loginWall,
    reference: reference ? {
      url: refInput?.url || '',
      notes: reference.notes || '',
      analysis: reference.analysis || null,
      analysisError: reference.analysisError || '',
      urlError: refInput?.urlError || '',
      imageCount: reference.images?.length || 0,
    } : null,
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
  const fn = mode === 'site' ? reviewSite : mode === 'audit' ? runAudit : reviewImage;
  fn(jobs.get(id))
    .then((result) => setJob(id, { status: 'done', result, finishedAt: Date.now() }))
    .catch((err) => setJob(id, { status: 'error', error: String(err.message || err), finishedAt: Date.now() }));
}

/* ------------------------- 对标参考 ------------------------- */
/**
 * 对标参考：让模型「学习对方优秀的设计」来修当前页面。
 *
 * 分三步，避免模型直接抄像素：
 *   1. 采集参考对象（网址 → 截图 + 指标；或直接用用户上传的截图）
 *   2. 单独分析参考对象，提炼出「可迁移的设计手法」（原理，不是具体数值）
 *   3. 主评审同时拿到我们的页面、参考页面截图、以及提炼出的手法，产出借鉴建议
 *
 * 关键在于第 2 步：如果直接把参考页面丢给主评审，模型会照抄色值和字号；
 * 先抽象成手法再注入，模型学到的才是排版逻辑、层级策略这类可迁移的东西。
 */

/** 采集参考网址：返回 { metrics, images } */
async function captureReferenceSite(url, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const args = [CAPTURE_SCRIPT, url, '--out', outDir];
  if (USE_LOCAL_ENGINE) { args.push('--breakpoints', '1440', '--no-states'); }
  else { args.push('--lang', 'zh'); }
  const statePath = authStatePath(url);
  if (fs.existsSync(statePath)) args.push('--storage-state', statePath);
  const r = await run(PYTHON, args, { cwd: CAPTURE_CWD });
  const metricsPath = path.join(outDir, 'metrics.json');
  if (!fs.existsSync(metricsPath)) {
    throw new Error(`参考对象采集失败：${(r.stderr || r.stdout).slice(-400)}`);
  }
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const images = ['fold.png', 'full.png', 'hero.png']
    .map((f) => path.join(outDir, f))
    .filter((f) => fs.existsSync(f));
  return { metrics: metricsForPrompt(metrics), images };
}

/** 从参考对象提炼「可迁移的设计手法」 */
async function analyzeReference({ metrics, images, notes, model }) {
  const prompt = `你是一位资深设计总监，正在为另一个项目做对标分析。

请分析这些「参考对象」的截图与指标，**不要复制它的具体数值**（不要抄它的色值、字号、圆角），
而是提炼出「可迁移的设计手法」——即：它为什么好看背后的排版逻辑、层级策略、视觉节奏策略。

以下是参考对象的客观指标：
${JSON.stringify(metrics, null, 2)}
${notes ? `\n用户补充的参考要求 / 规则：\n${notes}\n` : ''}

请严格输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块：
{
  "summary": "参考对象整体是什么设计路子（中文，2 句内）",
  "principles": [
    {
      "name": "手法名称（如：单一焦点+ 满幅出血）",
      "evidence": "在截图里看到的具体证据（中文，要可验证）",
      "principle": "背后的可迁移原理（中文，抽象成能套用到别的页面的规则）",
      "how_to_apply": "迁移到别的页面时具体怎么做（中文）"
    }
  ],
  "signature": ["它最值得学的 1-3 个签名元素"],
  "avoid": ["只适合它自己、不该照搬的地方（如品牌色、插画风格）"]
}
principles 3-6 条，每条 evidence 必须指向截图里真实可见的东西。`;

  const text = await callVisionModel({ prompt, images, model });
  const chunk = extractJsonObject(text);
  if (!chunk) throw new Error('参考对象分析未返回合法 JSON：' + text.slice(0, 200));
  try {
    return JSON.parse(chunk);
  } catch (e) {
    const fixed = await callVisionModel({
      model,
      prompt: `下面是参考对象分析的 JSON，解析失败（${e.message}）。请修复它，只输出合法 JSON 对象。\n\n${chunk}`,
      images: [],
    });
    const fixedChunk = extractJsonObject(fixed);
    if (!fixedChunk) throw new Error('参考对象分析 JSON 修复失败');
    return JSON.parse(fixedChunk);
  }
}

/** 把参考手法渲染成给主评审看的文字块 */
function referenceBrief(ref) {
  if (!ref) return '';
  const lines = [];
  if (ref.notes) lines.push(`用户提供的参考要求 / 规则：${ref.notes}`);
  if (ref.analysis) {
    lines.push(`参考对象整体路子：${ref.analysis.summary || ''}`);
    if (Array.isArray(ref.analysis.principles)) {
      lines.push('参考对象值得学的手法（请借鉴原理，不要照抄它的具体色值/字号）：');
      for (const p of ref.analysis.principles) {
        lines.push(`- 【${p.name}】原理：${p.principle}｜证据：${p.evidence}｜迁移做法：${p.how_to_apply}`);
      }
    }
    if (Array.isArray(ref.analysis.signature) && ref.analysis.signature.length) {
      lines.push(`参考对象的签名元素：${ref.analysis.signature.join('、')}`);
    }
    if (Array.isArray(ref.analysis.avoid) && ref.analysis.avoid.length) {
      lines.push(`不该照搬的地方：${ref.analysis.avoid.join('、')}`);
    }
  }
  return lines.join('\n');
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

  /* 对标借鉴：从参考对象手法 → 我们怎么改 */
  const borrowPack = (() => {
    const ref = r.reference;
    const borrow = v.borrow || [];
    const principles = ref?.analysis?.principles || [];
    if (!borrow.length && !principles.length) return '';
    const lines = [];
    if (principles.length) {
      lines.push('参考对象值得学的手法（借鉴原理，不要照抄具体数值）：');
      for (const p of principles) {
        lines.push(`- 【${p.name || ''}】${p.principle || ''}`);
        if (p.how_to_apply) lines.push(`  迁移做法：${p.how_to_apply}`);
      }
      lines.push('');
    }
    if (borrow.length) {
      lines.push('结合本页面，具体要改的是：');
      for (const b of borrow) {
        lines.push(`- 借鉴「${b.from || ''}」→ 我们当前：${b.ours || ''} → 改成：${b.how || ''}`);
      }
    }
    return lines.join('\n');
  })();

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
    ...(borrowPack ? ['', '## 五、对标借鉴（来自参考对象的设计手法）', borrowPack, ''] : []),
    '',
    borrowPack ? '## 六、硬性约束' : '## 五、硬性约束',
    '1. 不改变页面文案含义与业务信息结构，只改视觉呈现与排版。',
    '2. 不引入新的 UI 框架或依赖；只用现有技术栈实现。',
    '3. 颜色总数 ≤ 12，字号档 ≤ 7，圆角值 ≤ 3，阴影 ≤ 2，渐变 ≤ 1。',
    '4. 中文正文字体不得使用宋体/仿宋/楷体等衬线中文字体，改用思源黑体 / 苹方 / 微软雅黑等黑体族。',
    '5. 正文对比度 ≥ 4.5:1，移动端无横向溢出，点击区 ≥ 44px。',
    '6. 改完自行检查一遍上述每一条，并列出改动文件与关键 diff。',
    ...(borrowPack ? ['7. 只借鉴参考对象的「设计手法与节奏」，不要照抄它的具体色值、字号、品牌元素。'] : []),
    '',
    borrowPack ? '## 七、下一步动作' : '## 六、下一步动作',
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
      const jobDir = path.join(RUNS_DIR, id);
      fs.mkdirSync(jobDir, { recursive: true });

      /* 参考对象：网址 + 规则文字 + 上传的参考截图 */
      let reference = null;
      const r = body.reference || {};
      const refImages = [];
      if (r.images && r.images.length) {
        const refDir = path.join(jobDir, 'reference', 'uploads');
        fs.mkdirSync(refDir, { recursive: true });
        for (const item of r.images) {
          try {
            const dataUrl = typeof item === 'string' ? item : item.dataUrl;
            const name = (typeof item === 'object' && item.name) || 'ref';
            const ext = (name.split('.').pop() || 'png').toLowerCase();
            const safeExt = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : 'png';
            const buf = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64');
            if (!buf.length) continue;
            const fname = `ref-${refImages.length + 1}.${safeExt}`;
            fs.writeFileSync(path.join(refDir, fname), buf);
            refImages.push(path.join(refDir, fname));
          } catch { /* 跳过坏图 */ }
        }
      }
      if (r.url || r.notes || refImages.length) {
        reference = { url: (r.url || '').trim(), notes: (r.notes || '').trim(), images: refImages };
      }

      startJob(id, 'site', {
        url: body.url,
        industry: body.industry || '',
        mobile: !!body.mobile,
        model: body.model || currentModel(),
        reference,
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
      const child = spawn(PYTHON, [
        path.join(__dirname, 'scripts/login.py'), body.url, '--out', statePath,
        '--timeout', String(Number(body.timeout) || 300),
      ], { cwd: __dirname, env: process.env, detached: true, stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')] });
      child.unref();
      return json(res, 200, { ok: true, statePath, log: logPath, pid: child.pid });
    }

    /* 后台/管理系统登录态：Cookie 串或 Authorization 头，存起来给 Lighthouse 用 */
    if (p === '/api/audit/auth') {
      if (req.method === 'GET') {
        const target = ensureUrl(url.searchParams.get('url') || '');
        if (!target) return json(res, 400, { error: '缺少 url' });
        const h = loadAuthHeaders(target);
        const st = (() => { try { return JSON.parse(fs.readFileSync(authStatePath(target), 'utf8')); } catch { return null; } })();
        let savedAt = 0;
        try { savedAt = JSON.parse(fs.readFileSync(authHeadersPath(target), 'utf8')).savedAt || 0; } catch { /* ignore */ }
        return json(res, 200, {
          url: target,
          has: !!h,
          kinds: h ? Object.keys(h) : [],
          preview: h ? { cookie: mask(h.Cookie), authorization: mask(h.Authorization) } : null,
          savedAt,
          hasBrowserState: !!st,
          cookieCount: st && Array.isArray(st.cookies) ? st.cookies.length : 0,
        });
      }
      if (req.method === 'POST') {
        let body = {};
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
        const target = ensureUrl(body.url);
        if (!target) return json(res, 400, { error: '缺少 url' });
        if (body.fromState) {
          const derived = headersFromState(target);
          if (!derived) return json(res, 400, { error: '浏览器登录态里没找到可用 cookie / token，先用「浏览器登录一次」' });
          saveAuthHeaders(target, derived);
          return json(res, 200, { ok: true, kinds: Object.keys(loadAuthHeaders(target) || {}), derived: true });
        }
        const saved = saveAuthHeaders(target, { cookie: body.cookie, authorization: body.authorization });
        return json(res, 200, { ok: true, cleared: !saved, kinds: saved ? Object.keys(loadAuthHeaders(target) || {}) : [] });
      }
      if (req.method === 'DELETE') {
        const target = ensureUrl(url.searchParams.get('url') || '');
        if (!target) return json(res, 400, { error: '缺少 url' });
        saveAuthHeaders(target, {});
        return json(res, 200, { ok: true });
      }
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

    if (req.method === 'POST' && p === '/api/audit/site') {
      const body = JSON.parse(await readBody(req));
      const list = Array.isArray(body.urls) ? normalizeAuditTargets(body.urls, '') : [];
      const target = ensureUrl(body.url);
      if (!list.length && !target) return json(res, 400, { error: '至少给一个页面地址' });
      const id = 'audit-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      startJob(id, 'audit', {
        url: target || (list[0] && list[0].url) || '',
        urls: list,
        maxPages: body.maxPages || 6,
      });
      return json(res, 200, { id, targets: list.length || 'auto' });
    }

    /* 候选页面建议：只爬链接不跑 lighthouse，给人工挑页面用 */
    if (req.method === 'POST' && p === '/api/audit/discover') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const target = ensureUrl(body.url);
      if (!target) return json(res, 400, { error: '缺少 url' });
      try {
        return json(res, 200, await discoverPages(target, body.maxPages));
      } catch (e) {
        return json(res, 500, { error: String(e.message || e).slice(0, 300) });
      }
    }

    /* 站点基线：GET 读 / POST 从某次审查建立 / DELETE 删除 */
    if (p === '/api/baseline') {
      if (req.method === 'GET') {
        const u = url.searchParams.get('url') || '';
        const b = u ? loadBaseline(u) : null;
        return json(res, 200, b ? { exists: true, baseline: b } : { exists: false });
      }
      if (req.method === 'POST') {
        let body = {};
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
        let job = body.jobId ? loadJob(body.jobId) : null;
        if (!job && body.url) job = latestDoneJobForHost(body.url);
        if (!job || !job.result || !job.result.metrics) {
          return json(res, 400, { error: '找不到可用的审查结果，先跑一次审查再建基线' });
        }
        const target = (job.input && job.input.url) || body.url;
        const tokens = tokensFromMetrics(job.result.metrics, job.id);
        saveBaseline(target, tokens);
        return json(res, 200, { ok: true, baseline: tokens });
      }
      if (req.method === 'DELETE') {
        const u = url.searchParams.get('url') || '';
        if (u) { try { fs.unlinkSync(baselinePath(u)); } catch { /* ignore */ } }
        return json(res, 200, { ok: true });
      }
    }

    /* 历史记录：把 runs 目录里已落盘的任务整理成列表（不重跑模型） */
    if (req.method === 'GET' && p === '/api/history') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 60, 300);
      const thumbCandidates = ['fold.png', 'hero.png', 'full.png', 'mobile.png',
        'input.png', 'input.jpg', 'input.jpeg', 'input.webp'];
      const items = [];
      let dirs = [];
      try {
        dirs = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
          .filter((d) => d.isDirectory()).map((d) => d.name);
      } catch { /* ignore */ }
      for (const name of dirs) {
        const jobFile = path.join(RUNS_DIR, name, 'job.json');
        let j;
        try { j = JSON.parse(fs.readFileSync(jobFile, 'utf8')); } catch { continue; }
        if (!j || j.status === 'running') continue;
        const v = (j.result && j.result.visual) || {};
        const mtr = (j.result && j.result.metrics) || {};
        const input = j.input || {};
        const isAudit = (j.mode || '') === 'audit' || String(name).startsWith('audit-');
        const asum = (j.result && j.result.summary) || {};
        const thumb = thumbCandidates.find((f) => fs.existsSync(path.join(RUNS_DIR, name, f))) || null;
        items.push({
          id: name,
          mode: isAudit ? 'audit' : (j.mode || 'site'),
          status: j.status,
          createdAt: j.createdAt || 0,
          finishedAt: j.finishedAt || 0,
          score: isAudit
            ? (Number.isFinite(asum.performance) ? asum.performance : null)
            : (Number(v.total_score) || null),
          grade: isAudit ? null : (v.grade || null),
          verdict: isAudit
            ? (j.result && j.result.pageCount ? `${j.result.pageCount} 页 · SEO ${asum.seo ?? '—'}` : '')
            : (v.verdict || ''),
          title: isAudit
            ? ((j.result && j.result.scanUrl) || input.url || '')
            : (mtr.title || input.filename || ''),
          url: isAudit ? ((j.result && j.result.scanUrl) || input.url || '') : (input.url || ''),
          error: j.status === 'error' ? (j.error || '失败') : '',
          thumb,
        });
      }
      items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return json(res, 200, { items: items.slice(0, limit), total: items.length });
    }

    /* 删除一条历史记录（连目录一起） */
    if (req.method === 'DELETE' && p.startsWith('/api/job/')) {
      const id = p.split('/').pop();
      if (!/^[A-Za-z0-9._-]+$/.test(id)) return json(res, 400, { error: '非法 id' });
      const dir = path.join(RUNS_DIR, id);
      if (!dir.startsWith(RUNS_DIR + path.sep) || !fs.existsSync(dir)) {
        return json(res, 404, { error: 'job 不存在' });
      }
      fs.rmSync(dir, { recursive: true, force: true });
      jobs.delete(id);
      return json(res, 200, { ok: true, id });
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
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
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
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      // 前端是原文件直出、没有构建哈希，浏览器开启发式缓存会导致改完看不到变化
      'cache-control': 'no-store',
    });
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
