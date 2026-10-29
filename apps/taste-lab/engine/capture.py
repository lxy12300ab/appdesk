#!/usr/bin/env python3
"""Taste Lab 采集引擎 v2（本地 vendor 版，不再依赖和改动 OpenClaw 共享 skill）

相对 v1（design-taste/scripts/review_site.py）改了四件事：

1. 颜色按 CIELAB ΔE 聚类。v1 用 `new Set(color)` 去重，rgb(239,240,241) 与
   rgb(240,239,247) 算两种颜色，仪表盘动辄"36 种颜色"→ 色彩分直接 0，模型跟着复读。
2. 正文识别按文本量加权，不再取"出现次数最多的字号"。v1 在后台页取到 10px 标签
   → bodySize=null → 可访问性分静默兜底 50 分（假数据）。
3. 对比度用真实 WCAG 逐元素计算，输出加权中位数 / 低于 AA 占比；权重不再默认 16px。
4. 按页面类型（landing / app / doc / commerce / login）切阈值。v1 一套落地页尺子
   量所有页面，后台页永远 60 分 C。

另外补了：768 / 1920 断点、横向溢出检测、hover / focus / 展开导航 三种交互态截图、
elements.json（元素级 selector + bbox，供结果页在截图上画框定位）。

Usage:
  python3 capture.py <url> --out DIR [--industry NAME] [--breakpoints 390,768,1440,1920]
                     [--storage-state FILE] [--full-max 8000] [--no-states]
"""
import argparse
import asyncio
import csv
import json
import math
import os
import statistics
import sys
from urllib.parse import urlparse

try:
    from playwright.async_api import async_playwright
except ImportError:
    sys.exit("playwright missing: pip install playwright && python3 -m playwright install chromium")

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 1440, 900
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")

# ------------------------------------------------------------------ 采集 JS
JS_COLLECT = r"""
([VW, VH]) => {
  const parse = c => { const m = c && c.match(/rgba?\(([^)]+)\)/); return m ? m[1].split(',').map(parseFloat) : null; };
  const lum = p => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
                     return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = e => { for (; e; e = e.parentElement) { const p = parse(getComputedStyle(e).backgroundColor);
                      if (p && (p.length < 4 || p[3] > 0.5)) return p; } return [255, 255, 255]; };
  const vis = e => { const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || +cs.opacity < 0.05) return false;
                     const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const ownText = e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim();
  const key = p => [Math.round(p[0]), Math.round(p[1]), Math.round(p[2])].join(',');
  const sel = e => {
    const parts = [];
    for (let n = e, d = 0; n && n.nodeType === 1 && d < 4; n = n.parentElement, d++) {
      let s = n.tagName.toLowerCase();
      if (n.id) { s += '#' + String(n.id).replace(/[^\w-]/g, ''); parts.unshift(s); break; }
      const cn = typeof n.className === 'string' ? n.className : '';
      const cls = cn.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      if (cls) s += '.' + cls.replace(/[^\w.-]/g, '');
      const p = n.parentElement;
      if (p) { const same = [...p.children].filter(x => x.tagName === n.tagName);
               if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'; }
      parts.unshift(s);
    }
    return parts.join(' > ');
  };

  const tc = {}, bc = {}, boc = {};
  const bump = (m, k) => { if (k) m[k] = (m[k] || 0) + 1; };
  const FS = {}, F = {}, FW = {}, R = {}, S = {};
  const SERIF = new Set();
  const SERIF_RE = /(simsun|songti|宋体|新宋|仿宋|fangsong|kaiti|楷体|stsong|noto ?serif ?(cjk|sc)|source ?han ?serif)/i;
  const CJK_SANS_RE = /(pingfang|hei ?ti|hei-ti|noto ?sans ?(cjk|sc)|source ?han ?sans|harmonyos ?sans|yahei|微软雅黑|苹方)/i;
  const HAS_CJK = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/;
  const GENERIC_SERIF = /(^|[\s,])serif$|serif(\s*,|$)/i;

  let grad = 0, maxW = 0, hero = 0, heroText = '', media = 0;
  let nInputs = 0, nTables = 0, nButtons = 0, navLinks = 0, priceLike = 0, hasAside = false, asideH = 0;
  let textChars = 0, serifChars = 0, cjkChars = 0, cjkSerifChars = 0;
  const blocks = [];        // 正文候选：{fs, len, contrast}
  const contrastPool = [];  // 全量文本：{c(对比度), n(字符数)}
  const notable = [];       // 可疑元素（低对比 / 过小字 / 小点击区）
  const catalog = [];       // 文本元素目录：给"问题定位"当锚点
  const ctaCands = [];
  let firstInput = null;

  const els = [...document.querySelectorAll('body *')].slice(0, 8000);
  for (const e of els) {
    const cs = getComputedStyle(e);
    const isEl = e.tagName;
    if (isEl === 'ASIDE' || (isEl === 'NAV' && e.getBoundingClientRect().height > VH * 0.5)) {
      hasAside = true; asideH = Math.max(asideH, e.getBoundingClientRect().height);
    }
    if (isEl === 'INPUT' || isEl === 'TEXTAREA' || isEl === 'SELECT') {
      nInputs += 1;
      if (!firstInput && (e.offsetParent !== null || e.getBoundingClientRect().width > 0)) firstInput = sel(e);
    }
    if (isEl === 'TABLE') nTables += 1;
    if (!vis(e)) continue;

    const r = e.getBoundingClientRect(), t = ownText(e);
    const box = { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY),
                  w: Math.round(r.width), h: Math.round(r.height) };
    const bgp = parse(cs.backgroundColor);
    if (bgp && (bgp.length < 4 || bgp[3] > 0.5)) bump(bc, key(bgp));
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') {
      const bcp = parse(cs.borderTopColor); if (bcp) bump(boc, key(bcp));
    }
    if (cs.borderTopLeftRadius !== '0px') R[cs.borderTopLeftRadius] = 1;
    if (cs.boxShadow !== 'none') S[cs.boxShadow] = 1;
    if (cs.backgroundImage.includes('gradient')) grad += 1;
    if (cs.backgroundImage.includes('url(')) {
      const a = Math.max(0, Math.min(r.right, VW) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, VH) - Math.max(r.top, 0));
      if (a > VW * VH * 0.15) media += a;
    }
    if (['MAIN', 'DIV', 'SECTION'].includes(isEl) && cs.maxWidth.endsWith('px')) {
      const mw = parseFloat(cs.maxWidth); if (mw >= 600 && mw <= 2600 && r.width > 500) maxW = Math.max(maxW, mw);
    }
    if ((isEl === 'A' || isEl === 'BUTTON' || e.getAttribute('role') === 'button')) {
      nButtons += 1;
      if (isEl === 'A' && r.top < VH) navLinks += 1;
      if (t.length > 0 && r.width >= 80 && r.height >= 24 && r.top < VH && r.bottom > 0) {
        const cls = (typeof e.className === 'string' ? e.className : '').toLowerCase();
        let score = Math.min(r.width * r.height, 200000) / 1000;
        if (/primary|cta|--main|btn-lg|hero/.test(cls)) score += 80;
        if (e.closest('aside, nav, header, footer')) score -= 90;
        if (e.closest('main, [role=main]')) score += 20;
        ctaCands.push({ selector: sel(e), text: t.slice(0, 24), box, score });
      }
    }
    if (/^[¥￥$€]\s?\d|^\d+(\.\d+)?\s?元/.test(t)) priceLike += 1;
    if (t.length < 2) continue;

    const fs = parseFloat(cs.fontSize);
    const cp = parse(cs.color);
    const ck = cp ? key(cp) : null;
    if (ck) bump(tc, ck);
    FW[cs.fontWeight] = 1;
    const fam = (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
    F[fam] = 1;
    FS[cs.fontSize] = (FS[cs.fontSize] || 0) + 1;
    textChars += t.length;

    if (SERIF_RE.test(fam)) { SERIF.add(fam); serifChars += t.length; }
    if (HAS_CJK.test(t)) {
      cjkChars += t.length;
      const stack = cs.fontFamily || '';
      if (SERIF_RE.test(stack) || (!CJK_SANS_RE.test(stack) && GENERIC_SERIF.test(stack))) {
        cjkSerifChars += t.length; SERIF.add(fam + '→(中文字形回退衬线)');
      }
    }

    if (!cp) continue;
    const cr = ratio(cp, bgOf(e));
    contrastPool.push({ c: cr, n: t.length });
    if (t.length >= 20) blocks.push({ fs, len: t.length, contrast: cr });
    if (t.length > 2 && r.top < VH && r.bottom > 0 && fs > hero) { hero = fs; heroText = t.slice(0, 80); }

    const link = isEl === 'A' || isEl === 'BUTTON' || e.getAttribute('role') === 'button';
    const ratioRounded = Math.round(cr * 100) / 100;
    if (t.length <= 60 && r.width >= 8 && r.height >= 8 && catalog.length < 700) {
      catalog.push({ selector: sel(e), tag: isEl.toLowerCase(), text: t.slice(0, 60), box,
                     fs, contrast: ratioRounded });
    }
    const suspect = cr < 4.5 || fs < 12 || (link && (r.width < 44 || r.height < 44));
    if (suspect && notable.length < 240) {
      notable.push({ selector: sel(e), tag: isEl.toLowerCase(), text: t.slice(0, 60), box,
                     fs, contrast: ratioRounded, color: cs.color,
                     bg: bgOf(e).slice(0, 3).join(','), clickable: link });
    }
  }
  for (const e of document.querySelectorAll('img,video,picture,canvas,svg')) {
    const rr = e.getBoundingClientRect();
    const a = Math.max(0, Math.min(rr.right, VW) - Math.max(rr.left, 0)) * Math.max(0, Math.min(rr.bottom, VH) - Math.max(rr.top, 0));
    if (a > VW * VH * 0.05) media += a;
  }

  // 正文：按字符数加权取众数（v1 是"出现次数最多"，后台页会取到 10px 标签）
  const bySize = {};
  blocks.forEach(b => { bySize[b.fs] = (bySize[b.fs] || 0) + b.len; });
  const bodyRank = Object.entries(bySize).sort((a, b) => b[1] - a[1]);
  const bodySize = bodyRank.length ? parseFloat(bodyRank[0][0]) : null;

  const totalChars = contrastPool.reduce((a, x) => a + x.n, 0);
  const sorted = contrastPool.slice().sort((a, b) => a.c - b.c);
  let acc = 0, p50 = null;
  for (const x of sorted) { acc += x.n; if (p50 === null && acc >= totalChars / 2) p50 = x.c; }
  const worst = sorted.length ? sorted.slice(0, 5).map(x => Math.round(x.c * 100) / 100) : [];

  const titleLow = (document.title || '').toLowerCase();
  const urlLow = location.href.toLowerCase();
  const hasPassword = [...document.querySelectorAll('input[type=password]')].some(e => e.offsetParent !== null || e.getClientRects().length > 0);
  const loginWord = /(登录|登陆|登入|sign ?in|log ?in|login|auth|认证|授权|管理后台|控制台|后台)/i;
  const bodyTextLen = (document.body ? document.body.innerText : '').trim().length;

  const top = (m, n) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    title: document.title, finalUrl: location.href,
    viewport: { w: VW, h: VH },
    pageHeight: document.documentElement.scrollHeight,
    nEls: els.length,
    textColors: top(tc, 40), bgColors: top(bc, 40), borderColors: top(boc, 30),
    fonts: Object.keys(F).slice(0, 12), fontCount: Object.keys(F).length,
    fontSizes: top(FS, 14).map(([k, n]) => k + '×' + n), fontWeights: Object.keys(FW).length,
    fontWeightsList: Object.keys(FW),
    radiiList: Object.keys(R).slice(0, 14), radii: Object.keys(R).length,
    shadows: Object.keys(S).length, gradients: grad,
    maxWidth: maxW, heroSize: hero, heroText,
    bodySize,
    bodySizeBasis: bodyRank.length ? 'text-weighted' : 'none',
    contrastP50: p50, contrastWorst: worst,
    contrastChars: totalChars,
    belowAAShare: totalChars ? contrastPool.filter(x => x.c < 4.5).reduce((a, x) => a + x.n, 0) / totalChars : null,
    heroMediaRatio: Math.min(1, media / (VW * VH)), heroMedia: media / (VW * VH) > 0.35,
    hasAside, hasPassword,
    nInputs, nTables, nButtons, navLinks, priceLike, bodyTextLen,
    loginWall: hasPassword || (loginWord.test(titleLow + ' ' + urlLow) && bodyTextLen < 1500),
    serifFonts: [...SERIF].slice(0, 8),
    serifCharShare: textChars ? serifChars / textChars : 0,
    cjkChars, cjkSerifChars,
    cjkSerifShare: cjkChars ? cjkSerifChars / cjkChars : 0,
    cjkFontFallback: cjkChars ? cjkSerifChars / cjkChars > 0.15 : false,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    cta: ctaCands.sort((a, b) => b.score - a.score)[0] || null,
    firstInput,
    notable, catalog,
  };
}
"""

# 页面分区：整页一张图只能给"全局观感"，分区高清图才能评到细节
REGION_JS = r"""() => {
  const out = [];
  const seen = new Set();
  const push = (el, key, label) => {
    if (!el || seen.has(key)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 150 || r.height < 56) return;
    seen.add(key);
    out.push({ key, label,
      box: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY),
             w: Math.round(r.width), h: Math.round(r.height) } });
  };
  const main = document.querySelector('main, [role=main], #main, .main');
  push(document.querySelector('aside, [role=complementary], .sidebar'), 'aside', '侧栏');
  push(document.querySelector('header, [role=banner]'), 'header', '顶栏');
  push(main, 'main', '主栏');
  if (!main) push(document.body, 'body', '页面主体');
  const form = document.querySelector('form');
  if (form && !(main && main.contains(form))) push(form, 'form', '表单');
  const table = document.querySelector('table');
  if (table && !(main && main.contains(table))) push(table.closest('section, div') || table, 'table', '表格');
  return out;
}"""

JS_HERO = r"""([VW, VH]) => {  let best = null, bestA = 0;
  for (const el of document.querySelectorAll('img,video,picture,canvas,svg,[style*="background"],section,header,div')) {
    const cs = getComputedStyle(el);
    const media = /^(IMG|VIDEO|PICTURE|CANVAS|svg)$/i.test(el.tagName) || (cs.backgroundImage && cs.backgroundImage.includes('url('));
    if (!media || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, r.left), y = Math.max(0, r.top);
    const x2 = Math.min(VW, r.right), y2 = Math.min(VH, r.bottom);
    const a = Math.max(0, x2 - x) * Math.max(0, y2 - y);
    if (a > bestA) { bestA = a; best = { x, y, width: x2 - x, height: y2 - y }; }
  }
  return best && bestA >= 0.12 * VW * VH ? best : null;
}"""

# ------------------------------------------------------------------ 颜色聚类
def _srgb_to_lab(rgb):
    def f(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = f(rgb[0]), f(rgb[1]), f(rgb[2])
    x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
    y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.0
    z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883

    def g_(t):
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    fx, fy, fz = g_(x), g_(y), g_(z)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def cluster_colors(pairs, threshold=5.0):
    """把肉眼无差的邻近色合并成一个色簇。pairs = [[key, count], ...]"""
    out = []
    for k, n in pairs:
        try:
            rgb = [float(x) for x in str(k).split(',')[:3]]
        except Exception:
            continue
        lab = _srgb_to_lab(rgb)
        hit = None
        for c in out:
            d = math.sqrt(sum((a - b) ** 2 for a, b in zip(lab, c["lab"])))
            if d <= threshold:
                hit = c
                break
        if hit:
            hit["count"] += n
            hit["members"].append(str(k))
        else:
            out.append({"lab": lab, "count": n, "rgb": [int(round(v)) for v in rgb[:3]], "members": [str(k)]})
    out.sort(key=lambda c: -c["count"])
    for c in out:
        c["hex"] = "#%02X%02X%02X" % tuple(max(0, min(255, v)) for v in c["rgb"])
        c.pop("lab", None)
    return out


# ------------------------------------------------------------------ 评分
TYPE_RULES = {
    "landing":  {"colorMax": 12, "heroMin": 48, "bodyMin": 16, "sizesMax": 7, "idealRatio": 3.5},
    "app":      {"colorMax": 14, "heroMin": 22, "bodyMin": 13, "sizesMax": 8, "idealRatio": 2.0},
    "doc":      {"colorMax": 12, "heroMin": 28, "bodyMin": 15, "sizesMax": 8, "idealRatio": 2.4},
    "commerce": {"colorMax": 14, "heroMin": 30, "bodyMin": 14, "sizesMax": 8, "idealRatio": 2.6},
    "login":    {"colorMax": 10, "heroMin": 22, "bodyMin": 14, "sizesMax": 6, "idealRatio": 2.0},
}
TYPE_ZH = {"landing": "落地页", "app": "应用/后台", "doc": "内容/文档", "commerce": "电商", "login": "登录页"}


def detect_page_type(m):
    if m.get("loginWall"):
        return "login"
    if m.get("priceLike", 0) >= 3 and m.get("nTables", 0) < 2:
        return "commerce"
    if m.get("nInputs", 0) >= 6 and (m.get("hasAside") or m.get("nTables", 0) >= 1):
        return "app"
    if m.get("hasAside") and m.get("bodyTextLen", 0) > 1200:
        return "app"
    if m.get("bodyTextLen", 0) > 3000 and m.get("heroMediaRatio", 0) < 0.25:
        return "doc"
    if m.get("heroMediaRatio", 0) >= 0.3 and m.get("bodyTextLen", 0) < 2500:
        return "landing"
    return "landing" if m.get("bodyTextLen", 0) < 1800 else "doc"


def clamp(x):
    return max(0.0, min(100.0, x))


def score_metrics(m):
    """缺数据的维度不再猜一个默认分，而是标记 measured:false 并把权重让给已测维度。"""
    ptype = detect_page_type(m)
    rule = TYPE_RULES[ptype]

    ncol = m["colorsTotal"]
    color = clamp(100 - max(0, ncol - rule["colorMax"]) * 4.5 - max(0, m["gradients"] - 3) * 1.5)

    serif_share = m.get("cjkSerifShare") or m.get("serifCharShare") or 0
    serif_penalty = 10 if serif_share >= 0.5 else 5 if serif_share >= 0.2 else 3 if serif_share >= 0.15 else 0
    body_small = 0
    if m.get("bodySize") and m["bodySize"] < rule["bodyMin"]:
        body_small = (rule["bodyMin"] - m["bodySize"]) * 5
    typ = clamp(100 - max(0, m["fontSizesSig"] - rule["sizesMax"]) * 10
                - max(0, m["fontCount"] - 2) * 12 - max(0, m["fontWeights"] - 3) * 8
                - serif_penalty - body_small)

    cons = clamp(100 - max(0, m["radii"] - 3) * 8 - max(0, m["shadows"] - 3) * 10)

    dims = {
        "color": {"score": color, "weight": 0.25, "measured": True},
        "type": {"score": typ, "weight": 0.25, "measured": True},
        "consist": {"score": cons, "weight": 0.15, "measured": True},
    }

    body = m.get("bodySize")
    hero = m.get("heroSize") or 0
    if body and hero:
        hb = hero / body
        hier = clamp(100 - abs(math.log(max(hb, 0.1) / rule["idealRatio"])) * 45)
        if hero < rule["heroMin"]:
            hier = clamp(hier - (rule["heroMin"] - hero) * 1.2)
        if body < rule["bodyMin"]:
            hier = clamp(hier - (rule["bodyMin"] - body) * 3)
        dims["hier"] = {"score": hier, "weight": 0.15, "measured": True, "ratio": round(hb, 2)}
        m["heroBodyRatio"] = round(hb, 2)
    else:
        m["heroBodyRatio"] = None
        dims["hier"] = {"score": 0, "weight": 0, "measured": False,
                        "why": "未识别到正文段落（页面可能全是短标签或图表）"}

    p50 = m.get("contrastP50")
    if p50 is not None and m.get("contrastChars", 0) > 0:
        aa = m.get("belowAAShare") or 0
        small = 15 if (body and body < rule["bodyMin"]) else 0
        acc = clamp(min(p50, 7) / 7 * 70 + 30 - aa * 60 - small)
        dims["access"] = {"score": acc, "weight": 0.20, "measured": True}
    else:
        dims["access"] = {"score": 0, "weight": 0, "measured": False,
                          "why": "没有可测的文本颜色/背景对"}

    wsum = sum(d["weight"] for d in dims.values())
    metric = sum(d["score"] * d["weight"] for d in dims.values()) / (wsum or 1)
    return {
        "pageType": ptype, "pageTypeZh": TYPE_ZH[ptype],
        "thresholds": rule,
        "colorsTotal": ncol,
        "serifCharShare": round(m.get("serifCharShare") or 0, 3),
        "cjkSerifShare": round(serif_share, 3),
        "serifPenalty": serif_penalty,
        "serifFonts": m.get("serifFonts", []),
        "cjkFontFallback": bool(m.get("cjkFontFallback")),
        "m_color": round(color), "m_type": round(typ), "m_consist": round(cons),
        "m_hier": round(dims["hier"]["score"]) if dims["hier"]["measured"] else None,
        "m_access": round(dims["access"]["score"]) if dims["access"]["measured"] else None,
        "dimensions": dims,
        "metric_score": round(metric, 1),
    }


def build_targets(m, s):
    rule = s["thresholds"]
    t = [
        ("colorsTotal", ("颜色数（聚类后）", "Colors (clustered)"), "≤%d" % rule["colorMax"], m["colorsTotal"] <= rule["colorMax"]),
        ("fontCount", ("字体族", "Font families"), "≤2", m["fontCount"] <= 2),
        ("fontSizesSig", ("字号档", "Font sizes"), "≤%d" % rule["sizesMax"], m["fontSizesSig"] <= rule["sizesMax"]),
        ("fontWeights", ("字重", "Font weights"), "≤3", m["fontWeights"] <= 3),
        ("radii", ("圆角值", "Radii"), "≤3", m["radii"] <= 3),
        ("shadows", ("阴影值", "Shadows"), "≤1", m["shadows"] <= 1),
        ("gradients", ("渐变", "Gradients"), "≤1", m["gradients"] <= 1),
        ("heroSize", ("主标题 px", "Hero px"), "≥%d" % rule["heroMin"], (m.get("heroSize") or 0) >= rule["heroMin"]),
        ("bodySize", ("正文 px", "Body px"), "≥%d" % rule["bodyMin"],
         None if m.get("bodySize") is None else m["bodySize"] >= rule["bodyMin"]),
        ("contrastP50", ("正文对比度 P50", "Contrast p50"), "≥4.5 AA", (m.get("contrastP50") or 0) >= 4.5),
        ("belowAAShare", ("低于 AA 文本占比", "Text below AA"), "≤2%",
         None if m.get("belowAAShare") is None else m["belowAAShare"] <= 0.02),
        ("overflowX", ("横向溢出 px", "Horizontal overflow"), "≤0", (m.get("overflowX") or 0) <= 0),
    ]
    return [{"key": k, "zh": zh, "en": en, "target": tg, "value": m.get(k), "ok": ok} for k, (zh, en), tg, ok in t]


# ------------------------------------------------------------------ 采集流程
async def settle(page, url):
    resp = await page.goto(url, wait_until="load", timeout=60000)
    try:
        await page.wait_for_load_state("networkidle", timeout=12000)
    except Exception:
        pass
    await page.wait_for_timeout(1800)
    return resp


CONSENT_TEXT = ["Accept all", "Accept All", "Accept All Cookies", "Accept all cookies", "Accept Cookies",
                "Accept", "I agree", "Agree", "Allow all", "Allow All", "Got it", "OK", "I Accept",
                "Accept and continue", "Agree and continue", "接受", "同意", "全部接受", "我知道了"]


async def dismiss_consent(page):
    for t in CONSENT_TEXT:
        for fr in page.frames:
            try:
                b = fr.get_by_role("button", name=t, exact=True)
                if await b.count() and await b.first.is_visible():
                    await b.first.click(timeout=1200)
                    await page.wait_for_timeout(600)
                    return t
            except Exception:
                pass
    return ""


async def shoot_regions(page, out, m, max_chunks=2):
    """按高亮区域切图：侧栏 / 顶栏 / 主栏（超长按视口切片）/ 表单。给模型做分块评审用。"""
    try:
        regions = await page.evaluate(REGION_JS)
    except Exception as e:
        m["regionError"] = str(e)[:160]
        return []
    os.makedirs(os.path.join(out, "regions"), exist_ok=True)
    shots = []
    for r in regions:
        b = r["box"]
        if b["h"] <= 900:
            chunks = [(b["y"], b["h"])]
        else:
            n = min(max_chunks, max(2, math.ceil(b["h"] / 1600)))
            step = b["h"] / n
            chunks = [(b["y"] + i * step, step) for i in range(n)]
        for i, (y, hh) in enumerate(chunks):
            top = max(0, int(y) - 10)
            try:
                await page.evaluate("y => window.scrollTo(0, y)", top)
                await page.wait_for_timeout(320)
                sy = await page.evaluate("() => window.scrollY")
                clip_y = max(0, int(y) - sy)
                clip_h = int(min(hh, 880 - clip_y))
                if clip_h < 80:
                    continue
                name = "regions/%s%s.png" % (r["key"], "" if len(chunks) == 1 else "-%d" % (i + 1))
                await page.screenshot(path=os.path.join(out, name), clip={
                    "x": max(0, b["x"]), "y": clip_y, "width": min(b["w"], 1440), "height": clip_h})
                shots.append({"key": r["key"], "label": r["label"] + ("" if len(chunks) == 1 else "·%d/%d" % (i + 1, len(chunks))),
                              "path": name, "box": {"x": b["x"], "y": int(y), "w": b["w"], "h": clip_h}})
            except Exception as e:
                m.setdefault("regionShootErrors", []).append("%s:%s" % (name if 'name' in dir() else r["key"], str(e)[:80]))
    await page.evaluate("() => window.scrollTo(0, 0)")
    await page.wait_for_timeout(200)
    return shots


async def capture_states(page, out, m):
    """交互态：hover 主 CTA、focus 首个输入框、展开导航。拿到"静态图看不到"的证据。"""
    os.makedirs(os.path.join(out, "states"), exist_ok=True)
    shots = []
    cta = m.get("cta") or {}
    if cta.get("selector"):
        try:
            el = page.locator(cta["selector"]).first
            if await el.count():
                await el.hover(timeout=2500)
                await page.wait_for_timeout(500)
                await page.screenshot(path=os.path.join(out, "states", "hover.png"))
                shots.append("states/hover.png")
                cs = await el.evaluate("e => { const s = getComputedStyle(e); return { bg: s.backgroundColor, color: s.color, cursor: s.cursor, transition: s.transitionDuration }; }")
                m["ctaHover"] = cs
                await page.mouse.move(0, 0)
        except Exception as e:
            m["ctaHoverError"] = str(e)[:120]
    fi = m.get("firstInput")
    if fi:
        try:
            el = page.locator(fi).first
            if await el.count():
                await el.focus()
                await page.wait_for_timeout(400)
                await page.screenshot(path=os.path.join(out, "states", "focus.png"))
                shots.append("states/focus.png")
                cs = await el.evaluate("e => { const s = getComputedStyle(e); return { outline: s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor, boxShadow: s.boxShadow }; }")
                m["inputFocus"] = cs
        except Exception as e:
            m["inputFocusError"] = str(e)[:120]
    toggle = page.locator("[aria-label*=menu i], [aria-label*=菜单], .hamburger, .menu-toggle, button[aria-expanded]").first
    try:
        if await toggle.count() and await toggle.is_visible():
            await toggle.click(timeout=2000)
            await page.wait_for_timeout(700)
            await page.screenshot(path=os.path.join(out, "states", "nav.png"))
            shots.append("states/nav.png")
    except Exception:
        pass
    return shots


async def capture(url, out, breakpoints, full_max, storage_state=None, states=True):
    result = {"images": [], "breakpointMetrics": {}, "stateShots": []}
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--disable-blink-features=AutomationControlled"])
        try:
            ctx_kwargs = {"viewport": {"width": W, "height": H}, "locale": "zh-CN", "user_agent": UA}
            if storage_state and os.path.exists(storage_state):
                ctx_kwargs["storage_state"] = storage_state
            ctx = await browser.new_context(**ctx_kwargs)
            page = await ctx.new_page()
            resp = await settle(page, url)
            consent = await dismiss_consent(page)
            for y in range(0, 7000, 900):
                await page.evaluate("window.scrollTo(0,%d)" % y)
                await page.wait_for_timeout(200)
            await page.evaluate("window.scrollTo(0,0)")
            await page.wait_for_timeout(1000)

            m = await page.evaluate(JS_COLLECT, [W, H])
            m["status"] = resp.status if resp else None
            m["consentClicked"] = consent
            m["url"] = url

            await page.screenshot(path=os.path.join(out, "fold.png"))
            result["images"].append("fold.png")
            try:
                box = await page.evaluate(JS_HERO, [W, H])
                if box:
                    await page.screenshot(path=os.path.join(out, "hero.png"), clip=box)
                    result["images"].append("hero.png")
                    m["heroImageBox"] = box
            except Exception as e:
                m["heroImageError"] = str(e)[:160]

            full_h = min(m["pageHeight"], full_max)
            await page.screenshot(path=os.path.join(out, "full.png"), full_page=True,
                                  clip={"x": 0, "y": 0, "width": W, "height": full_h})
            result["images"].append("full.png")
            m["fullHeight"] = full_h

            if states:
                result["stateShots"] = await capture_states(page, out, m)
            result["regionShots"] = await shoot_regions(page, out, m)
            await ctx.close()

            # 其他断点：只要截图 + 溢出检测
            for bp in breakpoints:
                if bp == W:
                    continue
                kw = {"viewport": {"width": bp, "height": 900 if bp >= 768 else 844}, "locale": "zh-CN"}
                if bp < 768:
                    kw.update({"device_scale_factor": 2, "is_mobile": True, "has_touch": True,
                               "user_agent": UA.replace("Macintosh; Intel Mac OS X 10_15_7",
                                                        "iPhone; CPU iPhone OS 17_0 like Mac OS X") + " Mobile"})
                if storage_state and os.path.exists(storage_state):
                    kw["storage_state"] = storage_state
                bctx = await browser.new_context(**kw)
                bp_page = await bctx.new_page()
                await settle(bp_page, url)
                await dismiss_consent(bp_page)
                name = "mobile.png" if bp < 768 else ("tablet.png" if bp < 1200 else "wide.png")
                await bp_page.screenshot(path=os.path.join(out, name))
                result["images"].append(name)
                ov = await bp_page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
                taps = await bp_page.evaluate(
                    "() => [...document.querySelectorAll('a,button,[role=button]')]"
                    ".filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44); }).length")
                result["breakpointMetrics"][str(bp)] = {"overflowX": ov, "smallTapTargets": taps, "shot": name}
                await bctx.close()
            m["breakpointMetrics"] = result["breakpointMetrics"]
            m["stateShots"] = result["stateShots"]
            m["regionShots"] = result.get("regionShots") or []
            m["images"] = result["images"]
            return m
        finally:
            await browser.close()


# ------------------------------------------------------------------ 报告骨架
def build_report(m, s, targets):
    t = s["pageTypeZh"]
    lines = ["# 网站设计评审：%s" % (m.get("title") or m.get("url")), "",
             "- URL：%s（最终：%s）" % (m.get("url"), m.get("finalUrl")),
             "- 页面类型判定：**%s**（阈值按此类型取：颜色 ≤%d、主标题 ≥%dpx、正文 ≥%dpx）"
             % (t, s["thresholds"]["colorMax"], s["thresholds"]["heroMin"], s["thresholds"]["bodyMin"]), "",
             "## 1. 指标", "", "| 指标 | 本站 | 目标 | 结论 |", "|---|---|---|---|"]
    for row in targets:
        v = row["value"]
        v = "-" if v is None else ("%.0f%%" % (v * 100) if isinstance(v, float) and row["key"] == "belowAAShare" else v)
        mark = "—" if row["ok"] is None else ("✅" if row["ok"] else "⚠️")
        lines.append("| %s | %s | %s | %s |" % (row["zh"], v, row["target"], mark))
    lines += ["", "子分：" + "｜".join(
        "%s %s" % ({"color": "色彩", "type": "字号体系", "consist": "一致性", "hier": "层级", "access": "可访问性"}[k],
                   "未测" if not d["measured"] else str(round(d["score"]))) for k, d in s["dimensions"].items()),
        "", "指标分：**%s**（未测维度已把权重让给已测维度，不再用默认分填充）" % s["metric_score"], "",
        "## 2. 视觉分", "", "由视觉模型看图后填写。", ""]
    return "\n".join(lines)


def load_bench(industry):
    for p in (os.path.join(HERE, "benchmarks.csv"),
              os.path.expanduser("~/.openclaw/workspace/skills/design-taste/scripts/benchmarks.csv")):
        if os.path.exists(p):
            rows = list(csv.DictReader(open(p, encoding="utf-8")))
            peers = [r for r in rows if industry and r.get("industry", "").lower() == industry.lower()]
            return rows, peers
    return None, None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url")
    ap.add_argument("--out", required=True)
    ap.add_argument("--industry")
    ap.add_argument("--breakpoints", default="390,768,1440,1920")
    ap.add_argument("--full-max", type=int, default=8000)
    ap.add_argument("--storage-state")
    ap.add_argument("--no-states", action="store_true")
    ap.add_argument("--mobile", action="store_true", help="保留兼容：等价于 breakpoints 含 390")
    a = ap.parse_args()

    url = a.url if "://" in a.url else "https://" + a.url
    os.makedirs(a.out, exist_ok=True)
    bps = [int(x) for x in a.breakpoints.split(",") if x.strip().isdigit()]
    if a.mobile and 390 not in bps:
        bps.append(390)

    m = asyncio.run(capture(url, a.out, bps, a.full_max, a.storage_state, not a.no_states))

    # 颜色聚类（v1 直接拿 Set.size 当颜色数）
    tc = cluster_colors(m.get("textColors") or [])
    bc = cluster_colors(m.get("bgColors") or [])
    boc = cluster_colors(m.get("borderColors") or [])
    m["colorsRaw"] = {"text": len(m.get("textColors") or []), "bg": len(m.get("bgColors") or []),
                      "border": len(m.get("borderColors") or [])}
    m["colorsRawTotal"] = sum(m["colorsRaw"].values())
    m["colorClusters"] = {"text": tc[:12], "bg": bc[:12], "border": boc[:10]}
    m["colorsTotal"] = len(tc) + len(bc) + len(boc)
    m["textColors"] = len(tc)
    m["bgColors"] = len(bc)
    m["borderColors"] = len(boc)
    m["fontSizesSig"] = len([x for x in (m.get("fontSizes") or []) if int(str(x).split("×")[-1]) >= 2])
    m["contrast"] = m.get("contrastP50")
    m["lowContrastShare"] = m.get("belowAAShare")
    m["topFontSizes"] = m.get("fontSizes") or []

    s = score_metrics(m)
    targets = build_targets(m, s)
    data = dict(m)
    data.update(s)
    data["targets"] = targets
    data["visual_score"] = None
    data["score"] = None
    data["bench"] = None
    rows, peers = load_bench(a.industry)
    if rows:
        data["bench"] = {"count": len(rows), "industryCount": len(peers or []),
                         "industryAvg": round(statistics.mean(float(r["score"]) for r in peers), 1) if peers else None}

    json.dump(data, open(os.path.join(a.out, "metrics.json"), "w"), ensure_ascii=False, indent=1)

    elements = {"viewport": {"w": W, "h": H}, "pageType": s["pageType"],
                "catalog": m.get("catalog") or [],
                "suspects": m.get("notable") or [],
                "breakpoints": data.get("breakpointMetrics") or {}}
    json.dump(elements, open(os.path.join(a.out, "elements.json"), "w"), ensure_ascii=False, indent=1)
    regions = {"items": m.get("regionShots") or [], "viewport": {"w": W, "h": H}}
    json.dump(regions, open(os.path.join(a.out, "regions.json"), "w"), ensure_ascii=False, indent=1)
    open(os.path.join(a.out, "report.md"), "w", encoding="utf-8").write(build_report(m, s, targets))

    print(json.dumps({k: data.get(k) for k in (
        "title", "status", "pageType", "pageTypeZh", "colorsRawTotal", "colorsTotal", "fontCount",
        "fontSizesSig", "radii", "shadows", "gradients", "heroSize", "bodySize", "contrastP50",
        "belowAAShare", "overflowX", "m_color", "m_type", "m_consist", "m_hier", "m_access",
        "metric_score")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
