"""Fixed-excerpt captures. Every shot: Restart, then N steps (default 300 = 5 s) of the
built-in polyrhythm test signal at the fixed 60 Hz clock, then render with the world
paused, so the same shot name always shows the same musical moment.

  python capture.py                        # the default set
  python capture.py av2:stand av3:low nocturne:survey
  python capture.py check                  # console errors, counts, timing, scene round trip
  python capture.py ui                     # the interface at 1440, 820 and 390 px wide
"""
import asyncio, sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import *

DEFAULT = ['av1:stand', 'av2:stand', 'av3:stand', 'nocturne:stand', 'av2:survey', 'av3:low']

async def shot(page, look, cam, steps=300, w=1440, h=900, extra='', name=None, clean=False):
    await page.evaluate(f"document.body.classList.toggle('perform', {'true' if clean else 'false'}); document.querySelector('.toggles').style.visibility = '{'hidden' if clean else ''}'")
    await page.evaluate(f"""() => {{ const lp = window.__lp; lp.state.running = false;
      lp.app.loadLook('a', '{look}'); lp.P.looks.morph = 0; lp.P.looks.drive = 'hand';
      lp.P.affector.on = false; {extra}
      lp.restart(); lp.stepSim({steps}); lp.goTo('{cam}'); }}""")
    await frames(page, 3)
    out = os.path.join(OUT, name or f'{look}_{cam}{"_clean" if clean else ""}_{w}x{h}.png')
    await page.screenshot(path=out)
    print('saved', out)
    return out

async def captures(names):
    async with async_playwright() as p:
        b = await launch(p)
        page, logs, ok = await open_app(b)
        print('app ok:', ok)
        if not ok:
            print('\n'.join(logs)); await b.close(); return
        for n in names:
            parts = n.split(':') + ['stand', '']
            await shot(page, parts[0], parts[1], clean=(parts[2] == 'clean'))
        errs = [l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')]
        print('console errors:', len(errs)); print('\n'.join(errs[:20]))
        await b.close()

async def check():
    res = {}
    async with async_playwright() as p:
        b = await launch(p)
        page, logs, ok = await open_app(b)
        res['app'] = ok
        # Timing: the voice history after 300 steps is identical however the frames are cut.
        hist = []
        await page.evaluate("window.__lp.state.skipDraw = true")
        for fps in (30, 60, 120):
            await page.evaluate("() => { const lp = window.__lp; lp.state.running = true; lp.restart(); }")
            ms = 1000 / fps
            for _ in range(int(5 * fps)):
                await page.evaluate(f'window.__fake.step({ms})')
            hist.append(await page.evaluate("() => { const lp = window.__lp; return [lp.state.simTime, Array.from(lp.bands.hist.slice(0, 64))]; }"))
        await page.evaluate("window.__lp.state.skipDraw = false")
        res['timing_simtime'] = [round(h[0], 4) for h in hist]
        res['timing_hist_maxdiff'] = max(max(abs(a - c) for a, c in zip(hist[0][1], h[1])) for h in hist)
        # Onsets per voice over 5 s of the test signal.
        res['onsets_5s'] = await page.evaluate("""() => { const lp = window.__lp; lp.state.running = false; lp.restart();
          const n = new Array(8).fill(0); for (let i = 0; i < 300; i++) { lp.stepSim(1); for (let k = 0; k < 8; k++) n[k] += lp.bands.hit[k]; } return n; }""")
        await frames(page, 2)
        res['counts'] = await page.evaluate("() => ({ tiles: window.__lp.app.stats.tiles, calls: window.__lp.app.stats.calls, tris: window.__lp.app.stats.tris, sparks: window.__lp.sparks.countAlive(window.__lp.state.simTime) })")
        # Scene round trip: snapshot → change → apply → equal.
        res['scene_roundtrip'] = await page.evaluate("""() => { const lp = window.__lp; const a = JSON.stringify(lp.snapshot().looks);
          lp.app.loadLook('a', 'nocturne'); lp.applyScene(JSON.parse(JSON.stringify({ ...lp.snapshot(), looks: JSON.parse(a) })), { fly: false });
          return JSON.stringify(lp.snapshot().looks) === a; }""")
        # Capacity rebuild.
        res['rebuild'] = await page.evaluate("() => { const lp = window.__lp; lp.P.spawn.rings = 30; lp.app.rebuild(); const n = lp.app.stats.tiles; lp.P.spawn.rings = 52; lp.app.rebuild(); return [n, lp.app.stats.tiles]; }")
        await frames(page, 2)
        res['errors'] = [l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')]
        await b.close()
    print(json.dumps(res, indent=2))
    with open(os.path.join(OUT, 'check.json'), 'w') as f: json.dump(res, f, indent=2)


async def ui_views():
    """The interface at desktop, tablet and phone widths."""
    async with async_playwright() as p:
        b = await launch(p)
        for (w, h) in [(1440, 900), (820, 1180), (390, 844)]:
            page, logs, ok = await open_app(b, w, h)
            await page.evaluate("() => { const lp = window.__lp; lp.state.running = false; lp.restart(); lp.stepSim(300); lp.goTo('stand'); }")
            await frames(page, 3)
            out = os.path.join(OUT, f'ui_{w}x{h}.png'); await page.screenshot(path=out); print('saved', out)
            errs = [l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')]
            if errs: print('\n'.join(errs[:10]))
            await page.close()
        await b.close()

if __name__ == '__main__':
    args = sys.argv[1:]
    if args == ['check']: asyncio.run(check())
    elif args == ['ui']: asyncio.run(ui_views())
    else: asyncio.run(captures(args or DEFAULT))
