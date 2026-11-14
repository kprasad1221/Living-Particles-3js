"""Looks, ramps and the received light, in the page (v0.3 · P2).

  python looks_check.py          # checks → captures/looks_check.json, and the light study sheets
  python looks_check.py light    # only the light study sheets (captures/light_<look>.jpg)

Every comparison holds the audio time, camera, seed and viewport still and changes one thing.

  ramps_reach_the_screen     "Colour from" 0 % → 100 % changes the picture; a body-stop colour changes it at
                             100 % and changes nothing at 0 % (so the old looks cannot be touched by a ramp)
  accent_is_for_events       the accent ramp changes only frames that contain a hit
  light_is_received_not_emitted   light on/off changes the composite, leaves the emission-only render (the
                             glow's source) identical, and with the light off the light-only view is black
  light_moves_over_fixed_form     three light positions: the lit patch follows the light across the screen
                             while the emission-only render does not change at all
  light_follows_music_within_bounds   strength = amount × (1 − depth + depth × level): never above the amount
  light_position_ignores_frame_rate   same audio time → same light position at 30 and 120 Hz display rates
  scene_round_trip           ramps, light and the light path survive save → load; a v0.2 scene (schema 6) loads
                             with ramps and light off and its own colours
  palette_round_trip         export the look's ramps → import into another look → identical stops

Software-rendered: appearance and behaviour only.
"""
import asyncio, io, json, os, sys
import numpy as np
from PIL import Image, ImageDraw
from harness import *
from capture import boot, play_to, ui_js, load_excerpt
from phrase_excerpt import MOMENTS

CREST, ATTACK, REST = MOMENTS['crest'], MOMENTS['attack'], MOMENTS['rest']

async def grab(page, t, js='', pre=2.5):
    if js: await page.evaluate(f"() => {{ const lp = window.__lp, P = lp.P, app = lp.app; {js} }}")
    await play_to(page, t, max(0.0, t - pre))
    await frames(page, 2)
    return np.asarray(Image.open(io.BytesIO(await page.screenshot())).convert('RGB')).astype(np.float32)

diff = lambda a, b: round(float(np.abs(a - b).mean()), 4)
plain = lambda o: bool(o) if isinstance(o, np.bool_) else float(o)      # numpy scalars → JSON
SETUP = "lp.app.resetScene(); lp.app.loadLook('a', '%s'); P.looks.preview = 'a'; P.pointer.on = false; P.diag.view = 'normal'; lp.sparks.seed = 1; lp.goTo('stand');"

async def checks(b):
    page, logs = await boot(b, 960, 600)
    await load_excerpt(page); await page.evaluate(ui_js(True))
    r = {}
    S = lambda js: page.evaluate(f"() => {{ const lp = window.__lp, P = lp.P, app = lp.app; return ({js}); }}")

    # ramps
    v = await grab(page, CREST, SETUP % 'mineral' + " app.lookA.ramp = 0; app.lookA.lightAmount = 0;")
    v2 = await grab(page, CREST, "app.lookA.rampBody[1].color = '#ff00aa';")
    rp = await grab(page, CREST, "app.lookA.ramp = 1; app.lookA.rampBody[1].color = '#1438c8';")
    rp2 = await grab(page, CREST, "app.lookA.rampBody[1].color = '#ff00aa';")
    r['ramps_reach_the_screen'] = {'voices_vs_ramps': diff(v, rp), 'stop_edit_at_100pct': diff(rp, rp2), 'stop_edit_at_0pct': diff(v, v2),
                                   'pass': diff(v, rp) > 0.5 and diff(rp, rp2) > 0.5 and diff(v, v2) == 0}
    # accent: only frames with a hit change (sparks off so only the tiles' hit colour is compared)
    base = SETUP % 'mineral' + " app.lookA.lightAmount = 0; P.sparks.on = false; P.plume.on = false;"
    a_hit = await grab(page, ATTACK, base); a_rest = await grab(page, REST, '')
    b_hit = await grab(page, ATTACK, "app.lookA.rampAccent.forEach(s => { s.color = '#00ff00'; });"); b_rest = await grab(page, REST, '')
    onsets = await S("Array.from(lp.response.hit).some(x => x > 0.01)")
    r['accent_is_for_events'] = {'attack_frame': diff(a_hit, b_hit), 'rest_frame': diff(a_rest, b_rest), 'pass': diff(a_hit, b_hit) > 0.02 and diff(a_rest, b_rest) == 0}

    # light: received, not emitted
    lit = SETUP % 'daylight' + " P.light.path = 'still'; P.light.radius = 8; P.light.angle = 90; P.light.audio = 0;"
    on = await grab(page, CREST, lit); off = await grab(page, CREST, "app.lookA.lightAmount = 0;")
    em_off = await grab(page, CREST, "P.diag.view = 'emission';"); lo_off = await grab(page, CREST, "P.diag.view = 'light';")
    em_on = await grab(page, CREST, "app.lookA.lightAmount = 0.7; P.diag.view = 'emission';")
    r['light_is_received_not_emitted'] = {'composite_on_vs_off': diff(on, off), 'emission_on_vs_off': diff(em_on, em_off), 'light_only_when_off_max': float(lo_off.max()),
                                          'pass': diff(on, off) > 0.3 and diff(em_on, em_off) == 0 and lo_off.max() == 0}
    # light moves, form stays
    cx, em = [], []
    for ang in (150, 90, 30):
        lo = await grab(page, CREST, f"P.diag.view = 'light'; P.light.angle = {ang};")
        w = lo.sum(axis=2); cx.append(round(float((w.sum(axis=0) * np.arange(w.shape[1])).sum() / max(w.sum(), 1e-6)), 1))
        em.append(await grab(page, CREST, "P.diag.view = 'emission';"))
    r['light_moves_over_fixed_form'] = {'light_angles_deg': [150, 90, 30], 'lit_patch_centre_x_px': cx, 'emission_change_between_positions': [diff(em[0], em[1]), diff(em[1], em[2])],
                                        'pass': cx[0] < cx[1] < cx[2] and diff(em[0], em[1]) == 0 and diff(em[1], em[2]) == 0}
    # strength follows the music, bounded by the amount
    st = []
    await page.evaluate("() => { const lp = window.__lp, P = lp.P; P.diag.view = 'normal'; P.light.audio = 0.8; P.light.source = 8; lp.app.lookA.lightAmount = 0.7; }")
    for t in (REST, ATTACK, CREST):
        await play_to(page, t, t - 2.5); await frames(page, 2)
        st.append(await S("({ level: +lp.response.lift[8].toFixed(3), strength: +lp.field.light.strength.toFixed(4) })"))
    exp = [round(0.7 * (1 - 0.8 + 0.8 * s['level']), 4) for s in st]
    r['light_follows_music_within_bounds'] = {'amount': 0.7, 'depth': 0.8, 'rest_attack_crest': st, 'expected': exp,
        'pass': all(abs(s['strength'] - e) < 2e-3 for s, e in zip(st, exp)) and all(s['strength'] <= 0.7 + 1e-6 for s in st) and st[0]['strength'] < st[2]['strength']}
    # place ignores the display rate
    pos = []
    await page.evaluate("() => { const P = window.__lp.P; P.light.path = 'orbit'; P.light.angle = 40; P.light.radius = 16; }")
    for fps in (30, 120):
        await play_to(page, 7.3, 4.0, fps=fps); await frames(page, 1)
        pos.append(await S("[+lp.field.light.x.toFixed(5), +lp.field.light.z.toFixed(5)]"))
    r['light_position_ignores_frame_rate'] = {'at_30_and_120_hz': pos, 'pass': pos[0] == pos[1]}

    # scenes
    rt = await S("""(() => { lp.app.loadSceneRef('builtin:mineral', { fly: false }); P.light.path = 'still'; P.light.radius = 11; app.lookA.rampBody[2].position = 0.61; app.lookA.lightAmount = 2.1;
      const s = JSON.parse(JSON.stringify(lp.snapshot())); lp.app.resetScene(); const ok = lp.applyScene(s, { fly: false }); const t = lp.snapshot();
      return { ok, schema: s.schema, same: JSON.stringify(t.looks) === JSON.stringify(s.looks) && JSON.stringify(t.light) === JSON.stringify(s.light), body2: app.lookA.rampBody[2].position, light: app.lookA.lightAmount, path: P.light.path }; })()""")
    old = await S("""(() => { const strip = l => { const o = JSON.parse(JSON.stringify(l)); for (const k of ['ramp','rampCurve','rampSpread','accent','lightAmount','lightReach','lightHeight','lightColor','rampBody','rampAccent']) delete o[k]; return o; };
      const s = lp.snapshot(); s.schema = 6; delete s.light; delete s.macros.light; s.looks.lookA = strip(lp.app.builtinScenes.default.make().looks.lookA); s.looks.lookA.v0 = '#123456'; s.looks.lookB = strip(s.looks.lookB);
      lp.app.loadSceneRef('builtin:mineral', { fly: false }); const ok = lp.applyScene(s, { fly: false });
      return { ok, ramp: app.lookA.ramp, light: app.lookA.lightAmount, deepStop: app.lookA.rampBody[1].color, macroLight: P.macros.light, lightPath: P.light.path, schemaNow: lp.snapshot().schema }; })()""")
    r['scene_round_trip'] = {'v03': rt, 'v02_scene': old, 'pass': rt['ok'] and rt['same'] and rt['body2'] == 0.61 and rt['light'] == 2.1 and rt['path'] == 'still'
                             and old['ok'] and old['ramp'] == 0 and old['light'] == 0 and old['deepStop'] == '#123456' and old['macroLight'] == 1}
    pal = await S("""(() => { lp.app.resetScene(); lp.app.loadLook('a', 'mineral'); lp.app.loadLook('b', 'av2p'); P.looks.edit = 'b';
      const before = JSON.stringify(app.lookB.rampBody); let got = null; const blobs = [];
      const pal = { schema: 1, id: 'x', version: 1, name: 'From A', inputColorSpace: 'srgb', ramps: { body: { stops: app.lookA.rampBody, curve: app.lookA.rampCurve }, accent: { stops: app.lookA.rampAccent } } };
      const r = app.applyPalette(JSON.parse(JSON.stringify(pal))); const newer = app.applyPalette({ ...pal, schema: 9 });
      return { applied: r.ok, changed: JSON.stringify(app.lookB.rampBody) !== before, same: JSON.stringify(app.lookB.rampBody) === JSON.stringify(app.lookA.rampBody) && JSON.stringify(app.lookB.rampAccent) === JSON.stringify(app.lookA.rampAccent),
               voiceColoursKept: app.lookB.v0 === '#1f55ff', newerRefused: newer.ok === false, message: newer.message }; })()""")
    r['palette_round_trip'] = {**pal, 'pass': pal['applied'] and pal['changed'] and pal['same'] and pal['voiceColoursKept'] and pal['newerRefused']}
    r['errors'] = [l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')]
    await page.context.close()
    return r

async def light_study(b):
    """The receiving light at three places over the same frozen moment: the composite above, the received
    light alone below. Height reads because faces toward the light brighten and faces away do not."""
    for look, amount in (('daylight', None), ('mineral', None)):
        page, logs = await boot(b, 1440, 900)
        await load_excerpt(page); await page.evaluate(ui_js(True))
        tw, th = 640, 400; sheet = Image.new('RGB', (tw * 3, th * 2)); d = ImageDraw.Draw(sheet)
        await page.evaluate(f"() => {{ const lp = window.__lp, P = lp.P, app = lp.app; {SETUP % look} P.light.path = 'still'; P.light.radius = 14; P.light.audio = 0; }}")
        for c, ang in enumerate((150, 90, 30)):
            for rI, view in enumerate(('normal', 'light')):
                im = await grab(page, CREST, f"P.light.angle = {ang}; P.diag.view = '{view}';")
                sheet.paste(Image.fromarray(im.astype(np.uint8)).resize((tw, th), Image.LANCZOS), (c * tw, rI * th))
                lab = f"{look} · crest · light at {ang}°, 14 u from centre · {'composite' if view == 'normal' else 'received light only'}"
                d.rectangle((c * tw, rI * th, c * tw + 10 + 6.1 * len(lab), rI * th + 17), fill=(0, 0, 0)); d.text((c * tw + 5, rI * th + 3), lab, fill=(255, 255, 255))
        out = os.path.join(OUT, f'light_{look}.jpg'); sheet.save(out, quality=88); print('saved', out)
        await page.context.close()

async def main(only_light):
    async with async_playwright() as p:
        b = await launch(p)
        if not only_light:
            r = await checks(b)
            with open(os.path.join(OUT, 'looks_check.json'), 'w') as f: json.dump(r, f, indent=2, default=plain)
            ok = True
            for k, v in r.items():
                if isinstance(v, dict) and 'pass' in v: print('PASS' if v['pass'] else 'FAIL', k, json.dumps(v, default=plain)[:300]); ok = ok and v['pass']
            print('errors', r['errors'])
        await light_study(b)
        await b.close()
    if not only_light: sys.exit(0 if ok and not r['errors'] else 1)

if __name__ == '__main__':
    asyncio.run(main(sys.argv[1:] == ['light']))
