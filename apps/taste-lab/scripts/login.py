#!/usr/bin/env python3
"""交互式登录：用可见浏览器打开站点，人工登录后自动保存 storage_state。

后台类应用（管理后台、内部控制台）直接发网址只会停在登录页，
这个脚本开一个可见窗口让用户登录，检测到登录成功后把会话存成 JSON，
之后审查时用 --storage-state 带上。

Usage:
  python3 login.py <url> --out <state.json> [--timeout 300]
"""
import argparse, asyncio, json, os, sys

try:
    from playwright.async_api import async_playwright
except ImportError:
    sys.exit("playwright missing: pip install playwright && python3 -m playwright install chromium")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")

# 判断「还在登录页」的启发式：有可见的密码框，或标题/URL 含登录词且正文很短
LOGIN_JS = r"""
() => {
  const hasPassword = [...document.querySelectorAll('input[type=password]')]
      .some(e => e.offsetParent !== null || e.getClientRects().length > 0);
  const t = (document.title || '').toLowerCase();
  const u = location.href.toLowerCase();
  const word = /(登录|登陆|sign ?in|log ?in|login|auth|认证|授权|管理后台|控制台|后台)/i;
  const len = (document.body ? document.body.innerText : '').trim().length;
  return { hasPassword, stillLogin: hasPassword || (word.test(t + ' ' + u) && len < 1500), len, title: document.title };
}
"""


async def main(url, out, timeout):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, args=["--disable-blink-features=AutomationControlled"])
        try:
            ctx = await browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN", user_agent=UA)
            page = await ctx.new_page()
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=60000)
            except Exception as e:
                print(f"goto warn: {e}", flush=True)

            print("请在弹出的浏览器窗口里完成登录。检测到登录成功后会自动保存会话。", flush=True)
            waited = 0
            ok = False
            while waited < timeout:
                await page.wait_for_timeout(2000)
                waited += 2
                try:
                    st = await page.evaluate(LOGIN_JS)
                except Exception:
                    continue
                if not st["stillLogin"]:
                    ok = True
                    print(f"检测到已登录：{st['title']}", flush=True)
                    break
                if waited % 10 == 0:
                    print(f"等待登录中…（{waited}s）", flush=True)

            os.makedirs(os.path.dirname(out), exist_ok=True)
            await ctx.storage_state(path=out)
            print(json.dumps({"ok": ok, "out": out, "url": page.url}, ensure_ascii=False), flush=True)
            await browser.close()
            return 0 if ok else 2
        finally:
            try:
                await browser.close()
            except Exception:
                pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--out", required=True)
    ap.add_argument("--timeout", type=int, default=300)
    a = ap.parse_args()
    target = a.url if "://" in a.url else "https://" + a.url
    sys.exit(asyncio.run(main(target, a.out, a.timeout)))
