#!/usr/bin/env python3
"""爬同源页面清单，给整站 Lighthouse 扫描用。

只做一件事：从一个页面出发，收集同源链接，按「导航里出现 > 正文出现 > 路径更浅」排序，
输出前 N 个。不做渲染截图，不评分。

Usage:
  python3 crawl.py <url> [--max 6] [--json]
输出：
  {"pages": ["https://a/", "https://a/about", ...], "total": 42}
"""
import argparse
import json
import re
import sys
from urllib.parse import urlparse, urldefrag

try:
    from playwright.async_api import async_playwright
except ImportError:
    sys.exit("playwright missing")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")

# 这些链接扫了没意义：登出、购物车、文件、锚点、协议
SKIP_RE = re.compile(
    r"(logout|log-out|signout|sign-out|signin|login|register|cart|checkout|"
    r"tel:|mailto:|javascript:|\.(pdf|zip|rar|png|jpe?g|gif|svg|webp|mp4|mp3|docx?|xlsx?|pptx?)$)",
    re.I)

ANCHORS_JS = """() => {
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    if (!href || !/^https?:/i.test(href)) continue;
    const text = (a.textContent || '').trim().slice(0, 40);
    const inNav = !!a.closest('nav, header, aside, [role=navigation]');
    const r = a.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.push({ href, text, inNav });
  }
  return out;
}"""


def norm(url):
    u, _ = urldefrag(url)
    if u.endswith("/") and u.count("/") > 3:
        u = u[:-1]
    return u


async def crawl(start, max_pages, timeout, headers=None):
    host = urlparse(start).netloc
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--disable-blink-features=AutomationControlled"])
        try:
            ctx = await b.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN", user_agent=UA)
            if headers:
                await ctx.set_extra_http_headers(headers)
            page = await ctx.new_page()
            try:
                await page.goto(start, wait_until="load", timeout=timeout)
                await page.wait_for_timeout(1500)
            except Exception:
                pass
            # 后台站点的首页常 302 到 /login，导航过程中 evaluate 会被打断：
            # 等文档稳定 + 失败重试，别让一次跳转把整个爬虫弄崩
            anchors = []
            for attempt in range(3):
                try:
                    await page.wait_for_load_state("domcontentloaded", timeout=8000)
                    await page.wait_for_timeout(600)
                    anchors = await page.evaluate(ANCHORS_JS)
                    break
                except Exception as e:
                    if attempt == 2:
                        print(f"warn: evaluate failed after retry: {e}", file=sys.stderr, flush=True)
                    else:
                        await page.wait_for_timeout(1200)
            if not anchors:
                anchors = await _anchors_via_content(page, host)
            return anchors, host
        finally:
            await b.close()


async def _anchors_via_content(page, host):
    """evaluate 实在拿不到时的兜底：抓 HTML 里的 a[href] 正则提取（无导航标记）"""
    try:
        html = await page.content()
    except Exception:
        return []
    out = []
    for m in re.finditer(r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', html, re.S | re.I):
        href, inner = m.group(1), re.sub(r"<[^>]+>", "", m.group(2))
        if not re.match(r"^https?:", href, re.I):
            continue
        out.append({"href": href, "text": inner.strip()[:40], "inNav": False})
    return out


def score_link(a, idx, start_norm):
    href = norm(a["href"])
    s = 0
    if a.get("inNav"):
        s += 100
    if a.get("text"):
        s += 10
    depth = urlparse(href).path.strip("/").count("/")
    s -= depth * 5
    s -= idx * 0.05          # DOM 顺序：越靠前越像主入口
    if href == start_norm:
        s -= 500             # 首页已经在列表里，排最后
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--max", type=int, default=6)
    ap.add_argument("--timeout", type=int, default=45000)
    ap.add_argument("--cookie", default="", help="后台站点用：Cookie 串")
    ap.add_argument("--authorization", default="", help="后台站点用：Authorization 头")
    a = ap.parse_args()

    headers = {}
    if a.cookie:
        headers["Cookie"] = a.cookie
    if a.authorization:
        headers["Authorization"] = a.authorization

    start = a.url if "://" in a.url else "https://" + a.url
    anchors, host = __import__("asyncio").run(crawl(start, a.max, a.timeout, headers or None))
    start_norm = norm(start)

    seen = {start_norm}
    picks = []
    for i, an in enumerate(anchors):
        try:
            u = norm(an["href"])
            pu = urlparse(u)
        except Exception:
            continue
        if pu.netloc != host:
            continue
        if SKIP_RE.search(u):
            continue
        if u in seen:
            continue
        seen.add(u)
        picks.append({"url": u, "text": an.get("text") or "", "nav": bool(an.get("inNav")),
                      "score": round(score_link(an, i, start_norm), 2)})

    picks.sort(key=lambda x: -x["score"])
    chosen = [p["url"] for p in picks[: max(0, a.max - 1)]]
    print(json.dumps({"pages": [start] + chosen, "total": len(seen),
                      "candidates": picks[:40]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
