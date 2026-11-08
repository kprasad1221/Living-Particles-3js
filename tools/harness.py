"""Shared Playwright harness (adapted from Audio Geology 3JS): serves the repo over
http, maps the import-map CDN URLs to local node_modules copies, and injects a fake
clock so frames are deterministic."""
import os, re, subprocess, time, socket
from playwright.async_api import async_playwright  # noqa: F401  (re-exported)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
OUT = os.environ.get('LP_OUT', os.path.join(HERE, 'captures'))
os.makedirs(OUT, exist_ok=True)
NM = os.environ.get('LP_NODE_MODULES', os.path.join(HERE, 'node_modules'))
CDN = {
  'https://cdn.jsdelivr.net/npm/three@0.186.0/': NM + '/three/',
  'https://cdn.jsdelivr.net/npm/tweakpane@4.0.5/': NM + '/tweakpane/',
}
FAKE_CLOCK = r"""
(() => {
  let now = 0; let q = [];
  window.__fake = {
    step(ms) { now += ms; const cbs = q; q = []; for (const cb of cbs) { try { cb(now); } catch (e) { console.error(e); } } },
    get now() { return now; }, pending() { return q.length; }
  };
  performance.now = () => now;
  window.requestAnimationFrame = cb => { q.push(cb); return q.length; };
})();
"""

def serve(port=int(os.environ.get('LP_PORT', 8790)), root=REPO):
    s = socket.socket(); r = s.connect_ex(('127.0.0.1', port)); s.close()
    if r != 0:
        subprocess.Popen(['python3', '-m', 'http.server', str(port), '--bind', '127.0.0.1'], cwd=root,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.0)
    return f'http://127.0.0.1:{port}'

async def route_cdn(page):
    async def handler(route):
        url = route.request.url
        for pre, local in CDN.items():
            if url.startswith(pre):
                path = local + url[len(pre):]
                if os.path.exists(path):
                    ct = 'application/javascript' if path.endswith('.js') else 'application/octet-stream'
                    return await route.fulfill(path=path, content_type=ct)
        if 'fonts.googleapis' in url or 'fonts.gstatic' in url:
            return await route.fulfill(body='', content_type='text/css')
        return await route.continue_()
    await page.route(re.compile(r'https://(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)/.*'), handler)

async def launch(p):
    exe = os.environ.get('LP_CHROME')
    return await p.chromium.launch(executable_path=exe, headless=True,
        args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
              '--autoplay-policy=no-user-gesture-required'])

async def new_page(browser, w, h, fake=True, dpr=1):
    ctx = await browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=dpr)
    page = await ctx.new_page()
    logs = []
    page.on('console', lambda m: logs.append(f'[{m.type}] {m.text}'))
    page.on('pageerror', lambda e: logs.append(f'[pageerror] {e}'))
    await route_cdn(page)
    if fake:
        await page.add_init_script(FAKE_CLOCK)
    return page, logs

async def open_app(browser, w=1440, h=900, dpr=1):
    page, logs = await new_page(browser, w, h, dpr=dpr)
    await page.goto(serve() + '/index.html')
    await page.wait_for_timeout(1500)
    await page.evaluate('window.__fake.step(16.6667)')
    await page.wait_for_timeout(200)
    ok = await page.evaluate('!!window.__lp')
    return page, logs, ok

async def frames(page, n=2):
    for _ in range(n):
        await page.evaluate('window.__fake.step(16.6667)')
    await page.wait_for_timeout(150)
