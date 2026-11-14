"""The first-use path, driven with real pointer and keyboard input (v0.3 · P1).

  python flow.py            # 1440 × 900 and 390 × 844 → captures/flow.json + ui_*.png
  python flow.py 1440x900   # one size

Each step acts the way a person would (clicks, key presses, typing) and then reads the app's
state to see whether the step did what the control says:

  layout          nothing off-screen; Perform shows the bar and the camera chips, nothing else
  source          the bar's source button opens Music; switching source updates the bar; Esc closes
  play            the Pause button, then Space (once per press, also when a button has focus)
  scene           choosing a scene in the bar loads it
  change          the Movement macro from the keyboard; the bar marks the scene as edited
  revert          Revert puts it back
  edit            E opens the editor on one family; typing a value with its unit; per-control reset;
                  the meters appear only with Music response and Inspect
  save            Save…, type a name (letters that are shortcuts must not fire), Enter
  escape          Esc closes the innermost open thing first
  round_trip      reload: same scene, not edited, same picture at the same audio time
  camera          wheel and drag over panels do not move the camera; over the floor they do (wide only)
  newer_scene     a scene from a newer schema is refused with a message and changes nothing

Software-rendered and on a virtual clock: this checks behaviour, not speed or feel.
"""
import asyncio, io, json, os, sys
import numpy as np
from PIL import Image
from harness import *
from capture import boot, wait_ready, play_to, ui_js

NAME = 'flow test h l e r 1'          # every letter here is also a shortcut key

async def flow_at(b, w, h):
    page, logs = await boot(b, w, h)
    wide = w > 900
    r = {'viewport': [w, h]}
    async def S(js): return await page.evaluate(f"() => {{ const lp = window.__lp, P = lp.P, app = lp.app, $ = id => document.getElementById(id); return ({js}); }}")
    # Software rendering makes a drawn frame slow, so interface time passes with drawing off, then one frame is drawn.
    async def tick(n=40):
        await page.evaluate("n => { const lp = window.__lp; lp.state.skipDraw = true; for (let i = 0; i < n; i++) window.__fake.step(16.6667); lp.state.skipDraw = false; window.__fake.step(16.6667); }", n)
        await page.wait_for_timeout(60)
    async def shot(name): await tick(8); await page.wait_for_timeout(120); await page.screenshot(path=os.path.join(OUT, f'ui_{name}_{w}x{h}.png'))

    # 0 · layout
    await tick()
    lay = await S("""(() => { const vis = id => !$(id).hidden, vw = innerWidth, vh = innerHeight;
      const out = [...document.querySelectorAll('#bar button, #bar select, #bar input, .cams button')].filter(e => e.offsetParent).map(e => e.getBoundingClientRect()).filter(q => q.left < -0.5 || q.right > vw + 0.5 || q.top < -0.5 || q.bottom > vh + 0.5).length;
      return { scrollW: document.documentElement.scrollWidth, vw, offscreenControls: out, editor: vis('paneWrap'), music: vis('library'), meters: vis('voices'),
               barHeight: $('bar').offsetHeight, barShareOfHeight: +($('bar').offsetHeight / vh).toFixed(3), transports: document.querySelectorAll('#playBtn').length,
               playButtons: [...document.querySelectorAll('button')].filter(e => /^(Play|Pause)$/.test(e.textContent.trim())).length,
               mixSegs: [...document.querySelectorAll('button')].filter(e => e.textContent.trim() === 'Mix').length }; })()""")
    print(f'[{w}x{h}] layout', flush=True)
    r['layout'] = {**lay, 'pass': lay['scrollW'] <= lay['vw'] and lay['offscreenControls'] == 0 and not lay['editor'] and not lay['music'] and not lay['meters']
                   and lay['playButtons'] == 1 and lay['mixSegs'] == 1}
    await shot('perform')

    # 1 · source
    await page.click('#sourceBtn'); await tick(4)
    opened = await S("!$('library').hidden && $('sourceBtn').getAttribute('aria-expanded') === 'true'")
    await page.click('[data-source="stress"]'); await tick()
    stress = await S("$('nowPlaying').textContent")
    await shot('music')
    await page.click('[data-source="pattern"]'); await wait_ready(page); await tick()
    pattern = await S("$('nowPlaying').textContent")
    await page.keyboard.press('Escape'); await tick(4)
    closed = await S("$('library').hidden && document.activeElement === $('sourceBtn')")
    print(f'[{w}x{h}] source', flush=True)
    r['source'] = {'opened': opened, 'stress': stress, 'pattern': pattern, 'closedAndFocusReturned': closed,
                   'pass': opened and stress.startswith('Stress test') and pattern.startswith('Test pattern') and 'precise' in pattern and closed}

    # 2 · play
    await page.click('#playBtn'); await tick(4)
    paused = await S("({ running: lp.state.running, label: $('playBtn').textContent })")
    await page.focus('#playBtn'); await page.keyboard.press('Space'); await tick(4)       # the button's own activation, exactly once
    resumed = await S("lp.state.running")
    await S("document.activeElement.blur()")
    await page.keyboard.press('Space'); await tick(4); viaKey = await S("lp.state.running")
    await page.keyboard.press('Space'); await tick(4); again = await S("lp.state.running")
    print(f'[{w}x{h}] play', flush=True)
    r['play'] = {'afterClick': paused, 'spaceOnFocusedButton': resumed, 'spaceNoFocus': [viaKey, again],
                 'pass': paused == {'running': False, 'label': 'Play'} and resumed is True and viaKey is False and again is True}

    # 3 · scene
    await page.select_option('#sceneSel', 'builtin:plume'); await tick()
    sc = await S("({ ref: lp.scene.ref, plume: P.plume.on, lookA: app.lookA.name, modified: lp.scene.modified, revertDisabled: $('revertBtn').disabled })")
    print(f'[{w}x{h}] scene', flush=True)
    r['scene'] = {**sc, 'pass': sc['ref'] == 'builtin:plume' and sc['plume'] and not sc['modified'] and sc['revertDisabled']}

    # 4 · change one behaviour from the keyboard
    before = await S("P.macros.movement")
    await page.focus('#macroMovement')
    for _ in range(10): await page.keyboard.press('ArrowRight')
    await tick()
    ch = await S("({ movement: P.macros.movement, modified: lp.scene.modified, revertDisabled: $('revertBtn').disabled })")
    print(f'[{w}x{h}] change', flush=True)
    r['change'] = {'before': before, **ch, 'pass': abs(ch['movement'] - before - 0.1) < 1e-6 and ch['modified'] and not ch['revertDisabled']}

    # 5 · revert
    await page.click('#revertBtn'); await tick()
    rv = await S("({ movement: P.macros.movement, modified: lp.scene.modified, ref: lp.scene.ref })")
    print(f'[{w}x{h}] revert', flush=True)
    r['revert'] = {**rv, 'pass': rv['movement'] == before and not rv['modified'] and rv['ref'] == 'builtin:plume'}

    # 6 · edit
    await S("document.activeElement.blur()")
    await page.keyboard.press('e'); await tick(4)
    ed = {'opened': await S("!$('paneWrap').hidden && app.ui.mode === 'edit'")}
    await page.click('#fam-motion'); await tick(4)
    ed['oneFamilyVisible'] = await S("[...document.querySelectorAll('.k-family')].filter(f => !f.hidden).map(f => f.id)")
    row = page.locator('#family-motion .k-row', has_text='Maximum lift').first
    num = row.locator('.k-num')
    await num.fill('2.5 u'); await num.press('Enter'); await tick(4)
    ed['typedValue'] = await S("P.movement.lift")
    await row.locator('.k-reset').click(); await tick(4)
    ed['afterControlReset'] = await S("P.movement.lift"); ed['factoryDefault'] = await S("app.defaults.movement.lift")
    await num.fill('2.2'); await num.press('Enter'); await tick(4)
    await shot('edit_motion')
    await page.click('#fam-light'); await tick(4)
    ed['lightShowsWhichLook'] = await S("!document.querySelector('.k-editing').hidden && document.querySelector('.k-editname').textContent")
    ed['metersWithLight'] = await S("!$('voices').hidden")
    await shot('edit_light')
    await page.click('#fam-music'); await tick(4)
    ed['metersWithMusic'] = await S("!$('voices').hidden")
    await shot('edit_music')
    await page.focus('#fam-music'); await page.keyboard.press('ArrowRight'); await tick(4)
    ed['arrowKeyMovesFamily'] = await S("app.ui.family")
    print(f'[{w}x{h}] edit', flush=True)
    r['edit'] = {**ed, 'pass': ed['opened'] and ed['oneFamilyVisible'] == ['family-motion'] and ed['typedValue'] == 2.5 and ed['afterControlReset'] == ed['factoryDefault']
                 and bool(ed['lightShowsWhichLook']) and not ed['metersWithLight'] and ed['metersWithMusic'] and ed['arrowKeyMovesFamily'] == 'inspect'}

    # 7 · save (the name is typed with real key presses; none of them may act as a shortcut)
    await page.click('#saveBtn'); await tick(4)
    await page.fill('#sceneName', '')
    await page.type('#sceneName', NAME)
    during = await S("({ hidden: app.ui.hidden, mode: app.ui.mode, music: app.ui.library, running: lp.state.running })")
    await page.keyboard.press('Enter'); await tick()
    sv = await S(f"({{ stored: !!app.userScenes[{json.dumps(NAME)}], ref: lp.scene.ref, modified: lp.scene.modified, status: $('sceneStatus').textContent, listed: [...$('sceneSel').options].some(o => o.value === 'user:' + {json.dumps(NAME)}), selected: $('sceneSel').value }})")
    await shot('save')
    print(f'[{w}x{h}] save', flush=True)
    r['save'] = {'whileTyping': during, **sv, 'pass': during == {'hidden': False, 'mode': 'edit', 'music': False, 'running': True} and sv['stored'] and sv['ref'] == 'user:' + NAME
                 and not sv['modified'] and sv['status'].startswith('Saved') and sv['listed'] and sv['selected'] == 'user:' + NAME}

    # 8 · escape closes the innermost thing first
    await page.keyboard.press('Escape'); await tick(4)
    e1 = await S("({ pop: !$('savePop').hidden, editor: app.ui.mode })")
    await S("document.activeElement.blur()")
    await page.keyboard.press('Escape'); await tick(4)
    e2 = await S("({ pop: !$('savePop').hidden, editor: app.ui.mode })")
    print(f'[{w}x{h}] escape', flush=True)
    r['escape'] = {'first': e1, 'second': e2, 'pass': e1 == {'pop': False, 'editor': 'edit'} and e2 == {'pop': False, 'editor': 'perform'}}

    # 9 · round trip through a reload: same scene, not edited, same picture at the same audio time
    async def picture():
        await page.evaluate(ui_js(True)); await S("(P.pointer.on = false, lp.goTo('stand'), 0)")
        await play_to(page, 6.0, 3.5)
        await frames(page, 2)
        return np.asarray(Image.open(io.BytesIO(await page.screenshot())).convert('RGB')).astype(np.float32)
    key1 = await S("lp.scene.baseKey"); pointer1 = await S("P.pointer.on")
    im1 = await picture()
    await S("(P.pointer.on = " + ('true' if pointer1 else 'false') + ", 0)")
    await page.evaluate(ui_js(False)); await page.wait_for_timeout(700)          # let the autosave land
    await page.reload(); await page.wait_for_timeout(2000); await wait_ready(page); await tick()
    rt = await S("({ ref: lp.scene.ref, modified: lp.scene.modified, sameKey: null, lift: P.movement.lift, plume: P.plume.on, selected: $('sceneSel').value })")
    rt['sameKey'] = (await S("lp.scene.baseKey")) == key1
    im2 = await picture()
    rt['pictureMeanAbsDiff8bit'] = round(float(np.abs(im1 - im2).mean()), 4)
    await page.evaluate(ui_js(False)); await S("(lp.sources.virtual = null, 0)")
    print(f'[{w}x{h}] round_trip', flush=True)
    r['round_trip'] = {**rt, 'pass': rt['ref'] == 'user:' + NAME and not rt['modified'] and rt['sameKey'] and rt['lift'] == 2.2 and rt['plume'] and rt['pictureMeanAbsDiff8bit'] < 0.05}

    # 10 · camera gestures stay on the floor (wide layout: there is floor beside the panels)
    if wide:
        await S("(app.setFamily('motion'), app.setMode('edit'), lp.goTo('stand'), 0)"); await tick(4)
        cam = "lp.stage.camera.position.toArray().map(v => +v.toFixed(4))"
        c0 = await S(cam)
        box = await page.locator('#paneWrap').bounding_box()
        await page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2); await page.mouse.wheel(0, 400); await tick(8)
        c1 = await S(cam)
        kb = await page.locator('#macroLight').bounding_box()
        await page.mouse.move(kb['x'] + 10, kb['y'] + kb['height'] / 2); await page.mouse.down(); await page.mouse.move(kb['x'] + 60, kb['y'] + 80, steps=5); await page.mouse.up(); await tick(8)
        c2 = await S(cam); light = await S("P.macros.light")
        await page.mouse.move(w * 0.35, h * 0.6); await page.mouse.wheel(0, 400); await tick(8)
        c3 = await S(cam)
        await S("(P.macros.light = 1, lp.goTo('stand'), app.setMode('perform'), 0)")
        r['camera'] = {'start': c0, 'afterWheelOverEditor': c1, 'afterDragOnBarFader': c2, 'faderMoved': light != 1, 'afterWheelOverFloor': c3,
                       'pass': c1 == c0 and c2 == c0 and light != 1 and c3 != c0}

    # 11 · a scene saved by a newer version is refused, with a message, and changes nothing
    k0 = await S("JSON.stringify(lp.snapshot().movement)")
    nv = await S("app.applyImported({ schema: 99, movement: { lift: 11 } }, 'from the future')")
    print(f'[{w}x{h}] newer_scene', flush=True)
    r['newer_scene'] = {**nv, 'unchanged': (await S("JSON.stringify(lp.snapshot().movement)")) == k0, 'pass': nv['ok'] is False and 'newer version' in nv['message'] and (await S("JSON.stringify(lp.snapshot().movement)")) == k0}

    await S(f"(delete app.userScenes[{json.dumps(NAME)}], 0)")
    r['errors'] = [l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')]
    r['pass'] = all(v.get('pass', True) for v in r.values() if isinstance(v, dict)) and not r['errors']
    await page.context.close()
    return r

async def main(sizes):
    res = {}
    async with async_playwright() as p:
        b = await launch(p)
        for (w, h) in sizes: res[f'{w}x{h}'] = await flow_at(b, w, h)
        await b.close()
    with open(os.path.join(OUT, 'flow.json'), 'w') as f: json.dump(res, f, indent=2)
    ok = True
    for size, r in res.items():
        for k, v in r.items():
            if isinstance(v, dict) and 'pass' in v:
                print('PASS' if v['pass'] else 'FAIL', size, k, '' if v['pass'] else json.dumps(v))
                ok = ok and v['pass']
        print('errors', size, r['errors'])
        ok = ok and not r['errors']
    sys.exit(0 if ok else 1)

if __name__ == '__main__':
    args = sys.argv[1:]
    sizes = [tuple(map(int, a.split('x'))) for a in args] or [(1440, 900), (390, 844)]
    asyncio.run(main(sizes))
