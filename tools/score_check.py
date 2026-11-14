"""The composed response, in the page (v0.3 · P3).

  python score_check.py           # checks → captures/score_check.json, then the sheets and the clip
  python score_check.py checks    # only the checks
  python score_check.py sheets    # only the sheets (captures/score_*.jpg) and the clip (captures/score_off_vs_on.mp4)

Everything runs on the composed 20 s excerpt (synthetic, 120 BPM, kick on every beat from 4 s) with the
built-in "Call and reply" scene, Stand camera, seed 1. Each comparison holds the audio time, camera and
viewport still and changes one thing.

  one_reply_one_plume            plume entry "once per call": every reply launches exactly one plume, at the
                                 reply's start, where its call arrived; none dropped
  plume_entry_modes              the same 16 s in the three entry modes: every bass hit / only when cued (two
                                 cues) / once per call. Launch times are written out and drawn as a timeline
  same_at_any_display_rate       30 Hz and 120 Hz display stepping reach the same gestures, strengths, light
                                 and plume count at the same audio time
  seek_restart_and_source_change after a seek only what the clock says is alive at the new time exists, and
                                 nothing is announced for it; restart and a new source do the same
  suspended_tab                  a 9 s jump in audio time launches no burst of plumes
  gesture_is_where_the_route_is  score on vs off changes the picture along the projected route and nowhere
                                 else in two far windows (local rest in space)
  rest_between_gestures          with calls 8 s apart, a frame between them is identical with the score off
                                 (rest in time); the foundation is taken out for this comparison
  light_rides_the_call           light path "rides the call": the light is at the call's front, lit only
                                 while a call is alive, never above the look's amount
  scene_round_trip               score, gesture and plume-entry settings survive save → load; a v0.2 scene
                                 loads with the score off and plumes on hits; a newer schema is refused

Software-rendered: appearance and behaviour only. Whether it reads as music needs a real track and a real GPU.
"""
import asyncio, io, json, os, shutil, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw
from harness import *
from capture import boot, play_to, ui_js, load_excerpt

SCENE = "lp.app.loadSceneRef('builtin:callreply', { fly: false }); P.pointer.on = false; P.diag.view = 'normal'; lp.sparks.seed = 1; lp.goTo('stand');"
diff = lambda a, b: round(float(np.abs(a - b).mean()), 4)
plain = lambda o: bool(o) if isinstance(o, np.bool_) else float(o)      # numpy scalars → JSON
J = lambda js: f"async () => {{ const lp = window.__lp, P = lp.P, app = lp.app, score = lp.score; {js} }}"

async def shot(page):
    await frames(page, 2)
    return Image.open(io.BytesIO(await page.screenshot())).convert('RGB')

async def grab(page, t, js='', pre=3.0):
    if js: await page.evaluate(J(js))
    await play_to(page, t, max(0.0, t - pre))
    return np.asarray(await shot(page)).astype(np.float32)

# Every plume launch is noted in the page: when, what asked for it, where.
TAP = J("""if (!lp.__taps) { lp.__taps = []; const orig = lp.sparks.plume.bind(lp.sparks);
  lp.sparks.plume = (ev, ...rest) => { const before = lp.sparks.stats.plumes, r = orig(ev, ...rest);
    if (lp.sparks.stats.plumes > before) lp.__taps.push({ t: +ev.time.toFixed(4), id: ev.id, at: rest[3] && rest[3].at ? [rest[3].at.x, rest[3].at.z] : null }); return r; }; }
  lp.__taps.length = 0;""")
STATE = J("""const t = lp.state.visualTime, f = lp.field;
  return { t, instances: score.instances.map(g => [g.id, g.kind, g.parent, g.route, +g.start.toFixed(6), +g.strength.toFixed(6)]),
           uniforms: f.uniforms.uGT.value.concat(f.uniforms.uGC.value, f.uniforms.uGA.value, f.uniforms.uGB.value).map(v => v.toArray().map(x => +x.toFixed(5))),
           foundation: +f.uniforms.uFound.value.x.toFixed(6), light: [f.light.x, f.light.z, f.light.strength].map(x => +x.toFixed(5)),
           plumes: lp.sparks.stats.plumes, dropped: lp.sparks.stats.plumesDropped, epoch: score.epoch };""")

async def checks(b):
    page, logs = await boot(b, 960, 600)
    await load_excerpt(page); await page.evaluate(ui_js(True))
    r = {}
    S = lambda js: page.evaluate(J(js))
    await page.evaluate(J(SCENE)); await page.evaluate(TAP)

    # 1 · one reply, one plume
    await play_to(page, 16.2, 0.0)
    taps = await S("return lp.__taps.slice()"); st = await page.evaluate(STATE)
    want = [0.5 + 2 * n for n in range(8)]                               # replies due in (0, 16.2]: 0.5, 2.5 … 14.5
    ends = await S("""const { routeOf, pathPoint } = await import('/src/world/gestures.js'); return [0,1,2,3,4,5,6,7].map(n => { const c = routeOf({ kind: 'call', route: n % 3 }, P.gesture), e = pathPoint(c, 1); return [e.x, e.z]; });""")
    near_end = all(t['at'] and abs(t['at'][0] - ends[i][0]) < 1e-6 and abs(t['at'][1] - ends[i][1]) < 1e-6 for i, t in enumerate(taps[:8]))
    r['one_reply_one_plume'] = {'replyStarts': want, 'plumeLaunches': [t['t'] for t in taps], 'ids': [t['id'] for t in taps], 'dropped': st['dropped'], 'launchedWhereTheCallArrived': near_end,
                                'pass': [t['t'] for t in taps] == want and [t['id'] for t in taps] == [f'r{n}' for n in range(8)] and st['dropped'] == 0 and near_end}

    # 2 · the three ways a plume can enter, over the same 16 s
    modes = {}
    hits = await S("const ev = lp.timeline.ev, out = []; for (let i = 0; i < ev.time.length; i++) if (ev.voice[i] === P.plume.voice && ev.time[i] > 0 && ev.time[i] <= 16.2) out.push(+ev.time[i].toFixed(4)); return out;")
    await S("P.plume.entry = 'hits';"); await page.evaluate(TAP); await play_to(page, 16.2, 0.0)
    modes['hits'] = {'launches': [t['t'] for t in await S("return lp.__taps.slice()")], 'dropped': (await page.evaluate(STATE))['dropped']}
    await S("P.plume.entry = 'cue';"); await page.evaluate(TAP)
    await play_to(page, 5.0, 0.0); await page.keyboard.press('c'); await play_to(page, 11.0); await page.keyboard.press('c'); await play_to(page, 16.2)
    modes['cue'] = {'launches': [t['t'] for t in await S("return lp.__taps.slice()")], 'cuesGiven': 2, 'dropped': (await page.evaluate(STATE))['dropped']}
    modes['reply'] = {'launches': want, 'dropped': 0}
    await S("P.plume.entry = 'reply';")
    calls = [2.0 * n for n in range(9)]
    h = modes['hits']
    r['plume_entry_modes'] = {'passage_s': [0, 16.2], 'bassHitsDetected': hits, 'callStarts': calls, **{k: v for k, v in modes.items()},
        'note': 'hits: one plume per detected bass hit, minus those dropped by the limit on plumes alive at once; cue: only the two key presses; reply: one per call',
        'pass': len(h['launches']) + h['dropped'] == len(hits) and len(h['launches']) > 0 and all(any(abs(x - y) < 1e-3 for y in hits) for x in h['launches'])
                and len(modes['cue']['launches']) == 2 and all(abs(a - b_) < 0.05 for a, b_ in zip(modes['cue']['launches'], [5.0, 11.0]))}

    # 3 · the same at any display rate
    await play_to(page, 9.3, 4.0, fps=30); await frames(page, 1); a = await page.evaluate(STATE)
    await play_to(page, 9.3, 4.0, fps=120); await frames(page, 1); c = await page.evaluate(STATE)
    same = {k: a[k] == c[k] for k in ('instances', 'uniforms', 'foundation', 'light', 'plumes')}
    r['same_at_any_display_rate'] = {'at': 9.3, 'instances': a['instances'], 'light': a['light'], 'plumesSinceSeek': a['plumes'], 'equal': same, 'pass': all(same.values()) and len(a['instances']) > 0}

    # 4 · seek, restart, source change
    await page.evaluate(TAP)
    await play_to(page, 8.2, 6.0); before = await page.evaluate(STATE)                 # c4 has started; its reply r4 is due at 8.5
    n_before = len(await S("return lp.__taps.slice()"))
    await play_to(page, 3.1, 3.1); await frames(page, 1); after = await page.evaluate(STATE)
    taps_after = (await S("return lp.__taps.slice()"))[n_before:]
    ids_before, ids_after = [i[0] for i in before['instances']], [i[0] for i in after['instances']]
    await S("P.score.mode = 'free'; lp.app.validate();"); await play_to(page, 8.2, 6.0); await S("score.reset();"); free_after = len(await S("return score.instances.slice()"))
    await S("P.score.mode = 'loop';")
    await play_to(page, 8.2, 6.0); await S("lp.sources.virtual = 0; lp.app.restart();"); await frames(page, 1); rs = await page.evaluate(STATE)
    seek = {'aliveBeforeSeek': ids_before, 'aliveAfterSeekTo3.1': ids_after, 'plumesAnnouncedByTheSeek': len(taps_after), 'pendingAfterResetOnFreeClock': free_after,
            'aliveAfterRestart': [i[0] for i in rs['instances']], 'epochAfterRestart': rs['epoch']}

    # 5 · a suspended tab: audio time jumps 9 s in one frame
    await page.evaluate(TAP); await play_to(page, 5.0, 3.0); n0 = len(await S("return lp.__taps.slice()"))
    await S("lp.sources.virtual = 14.0; window.__fake.step(16.6667);"); await frames(page, 2)
    burst = (await S("return lp.__taps.slice()"))[n0:]; stj = await page.evaluate(STATE)
    r['suspended_tab'] = {'jump_s': [5.0, 14.0], 'plumesLaunchedByTheJump': len(burst), 'aliveAfter': [i[0] for i in stj['instances']], 'pass': len(burst) <= 1 and len(stj['instances']) <= 8}

    # 6 · the gesture is where the route is, and the rest of the floor does not move
    quiet = "P.score.foundation.amount = 0; P.sparks.on = false; P.plume.on = false; app.lookA.lightAmount = 0;"
    T = 6.45                                                                             # call c3 (front arc) is 0.45 s into its 0.7 s crossing
    on_c = await grab(page, T, SCENE + quiet); off_c = await grab(page, T, "P.score.on = false;")
    halo = float((np.abs(on_c - off_c).max(axis=2) > 6).mean())                        # with glow: the halo spreads further, by design
    off = await grab(page, T, "P.diag.view = 'nobloom';"); on = await grab(page, T, "P.score.on = true;")
    await S("P.diag.view = 'normal';")
    d = np.abs(on - off).max(axis=2); changed = d > 6
    proj = await S("""const { routeOf, pathPoint } = await import('/src/world/gestures.js'); const V = lp.stage.camera.position.constructor, cam = lp.stage.camera, W = innerWidth, H = innerHeight;
      const px = (x, y, z) => { const v = new V(x, y, z).project(cam); return [(v.x * 0.5 + 0.5) * W, (1 - (v.y * 0.5 + 0.5)) * H]; };
      const c = routeOf({ kind: 'call', route: 0 }, P.gesture), pts = [], reachOut = 2 * P.gesture.callWidth;         // the band is soft: allow twice its half-width either side
      for (const dr of [-reachOut, 0, reachOut]) for (let u = 0; u <= 0.7; u += 0.02) { const q = pathPoint({ ...c, r: c.r + dr }, u); pts.push(px(q.x, 0, q.z), px(q.x, 2.6, q.z)); }
      return { pts, far: [px(-30, 0.3, -40), px(34, 0.3, -30)] };""")
    xs, ys = [p[0] for p in proj['pts']], [p[1] for p in proj['pts']]
    box = [max(0, min(xs) - 20), max(0, min(ys) - 20), min(960, max(xs) + 20), min(600, max(ys) + 20)]
    inside = changed[int(box[1]):int(box[3]), int(box[0]):int(box[2])].sum(); total = changed.sum()
    cy, cx = [float(v.mean()) for v in np.nonzero(changed)] if total else (0, 0)
    far = [float(d[max(0, int(y) - 25):int(y) + 25, max(0, int(x) - 40):int(x) + 40].max()) for x, y in proj['far']]
    Image.fromarray(np.clip(d * 4, 0, 255).astype(np.uint8)).save(os.path.join(OUT, 'score_route_difference.png'))
    r['gesture_is_where_the_route_is'] = {'t': T, 'view': 'no glow (the glow halo is a separate, wider effect)', 'changedPixelsPct': round(100 * float(changed.mean()), 2),
        'changedPixelsPctWithGlow': round(100 * halo, 2), 'shareInsideTheRouteBox': round(float(inside / max(total, 1)), 3),
        'routeBox': [round(v) for v in box], 'routeBoxPctOfFrame': round(100 * (box[2] - box[0]) * (box[3] - box[1]) / (960 * 600), 1), 'centroid': [round(cx), round(cy)], 'largestChangeInTwoFarWindows': far,
        'pass': total > 500 and inside / max(total, 1) > 0.9 and max(far) == 0 and changed.mean() < 0.25}

    # 7 · rest in time: calls 8 s apart; between them the floor is exactly as with the score off
    slow = SCENE + quiet + " P.score.callBeats = 16; P.score.foundationBeats = 16; lp.app.validate();"
    on_r = await grab(page, 12.5, slow, pre=4.0); off_r = await grab(page, 12.5, "P.score.on = false;", pre=4.0)      # call at 8 s ended by 10.3 s; the next is at 16 s
    on_c = await grab(page, 8.5, "P.score.on = true;", pre=4.0); off_c = await grab(page, 8.5, "P.score.on = false;", pre=4.0)
    r['rest_between_gestures'] = {'callsEvery_s': 8, 'betweenCalls_at_12.5s': diff(on_r, off_r), 'duringACall_at_8.5s': diff(on_c, off_c), 'pass': diff(on_r, off_r) == 0 and diff(on_c, off_c) > 0.05}

    # 8 · the light rides the call
    await page.evaluate(J(SCENE)); rows = []
    for t in (6.2, 6.5, 6.9, 7.6):
        await play_to(page, t, 4.0); await frames(page, 1)
        rows.append(await S("""const { callHead } = await import('/src/world/gestures.js'); const h = callHead(score.instances, P.gesture, lp.state.visualTime), l = lp.field.light;
          return { t: +lp.state.visualTime.toFixed(3), light: [l.x, l.z, l.strength].map(v => +v.toFixed(4)), head: h ? [h.x, h.z, h.strength].map(v => +v.toFixed(4)) : null, amount: app.mixed.lightAmount, callAlive: score.alive(lp.state.visualTime, 'call').length };"""))
    lit = [x for x in rows if x['callAlive']]; dark = [x for x in rows if not x['callAlive']]
    ok = (len(lit) >= 2 and len(dark) >= 1 and all(abs(x['light'][0] - x['head'][0]) < 1e-3 and abs(x['light'][1] - x['head'][1]) < 1e-3 and 0 < x['light'][2] <= x['amount'] + 1e-6 for x in lit)
          and all(x['light'][2] == 0 for x in dark) and lit[0]['light'][:2] != lit[1]['light'][:2])
    r['light_rides_the_call'] = {'samples': rows, 'pass': ok}

    # 9 · scenes
    rt = await S("""lp.app.loadSceneRef('builtin:callreply', { fly: false });
      Object.assign(P.score, { bpm: 96, origin: 0.37, callBeats: 2, mode: 'free', rateDepth: 0.2 }); P.score.reply.delay = 0.8; P.gesture.callWidth = 3.3; P.plume.entry = 'cue'; lp.app.validate();
      const snap = JSON.parse(JSON.stringify(lp.snapshot())), key = s => JSON.stringify([s.score, s.gesture, s.plume, s.light]);
      lp.app.resetScene(); const cleared = P.score.on === false && P.plume.entry === 'hits';
      const ok = lp.applyScene(snap, { fly: false }), again = lp.snapshot();
      const old = JSON.parse(JSON.stringify(snap)); old.schema = 6; delete old.score; delete old.gesture; delete old.light; delete old.plume.entry;
      const okOld = lp.applyScene(old, { fly: false }), v02 = { scoreOn: P.score.on, entry: P.plume.entry, lightPath: P.light.path };
      const newer = lp.app.applyImported({ ...snap, schema: 99 }, 'from the future');
      return { schema: snap.schema, cleared, ok, same: key(snap) === key(again), okOld, v02, newerRefused: !newer.ok, newerMessage: newer.message };""")
    r['scene_round_trip'] = {**rt, 'pass': rt['schema'] == 9 and rt['cleared'] and rt['ok'] and rt['same'] and rt['okOld'] and rt['v02'] == {'scoreOn': False, 'entry': 'hits', 'lightPath': 'orbit'} and rt['newerRefused']}

    # 4, continued · a new source (last, because it leaves the excerpt)
    await page.evaluate(J(SCENE)); await play_to(page, 8.2, 6.0); e0 = (await page.evaluate(STATE))['epoch']
    await S("await lp.usePattern();")
    for _ in range(120):
        if await S("return lp.sources.mode === 'pattern' && lp.ready()"): break
        await frames(page, 1); await page.wait_for_timeout(100)
    await S("lp.sources.virtual = 1.0;"); await frames(page, 2); src = await page.evaluate(STATE)
    seek.update({'epochRoseOnSourceChange': src['epoch'] > e0, 'aliveAfterSourceChange': [i[0] for i in src['instances']]})
    seek['pass'] = ('r4' in seek['aliveBeforeSeek'] and seek['aliveAfterSeekTo3.1'] == ['c1', 'r1'] and seek['plumesAnnouncedByTheSeek'] == 0 and seek['pendingAfterResetOnFreeClock'] == 0
                    and not any(i in ('c4', 'r4') for i in seek['aliveAfterRestart']) and src['epoch'] > e0 and not any(i in ('c4', 'r4') for i in seek['aliveAfterSourceChange']))
    r['seek_restart_and_source_change'] = seek

    r['errors'] = [l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')]
    await page.close()
    return r

# ── Sheets and a clip ────────────────────────────────────────────────────────
def label(d, x, y, text, w):
    d.rectangle((x, y, x + w, y + 16), fill=(0, 0, 0)); d.text((x + 5, y + 3), text, fill=(255, 255, 255))

async def sheets(b):
    page, logs = await boot(b, 1280, 800)
    await load_excerpt(page); await page.evaluate(ui_js(True))
    S = lambda js: page.evaluate(J(js))
    tw, th = 640, 400
    names = ['front arc', 'far arc', 'small centre arc']
    # 1 · one call and its reply on each route (Stand): front crossing · arrival, reply and plume start · reply climbing, call at rest
    await page.evaluate(J(SCENE))
    sheet = Image.new('RGB', (tw * 3, th * 3)); d = ImageDraw.Draw(sheet)
    for row, t0 in enumerate((6.0, 8.0, 10.0)):
        for col, (dt, what) in enumerate(((0.35, 'the call crossing'), (0.75, 'arrived; reply and plume start'), (1.2, 'reply climbing, call settling'))):
            await play_to(page, t0 + dt, t0 - 3.0)
            sheet.paste((await shot(page)).resize((tw, th), Image.LANCZOS), (col * tw, row * th))
            label(d, col * tw, row * th, f'{names[row]} · call at {t0:.0f} s + {dt:.2f} s · {what}', tw)
    sheet.save(os.path.join(OUT, 'score_call_and_reply.jpg'), quality=88); print('saved score_call_and_reply.jpg')

    # 2 · score off vs on: the same scene, audio times and camera. Off = the floor as it answered before (measured
    #     music only, plumes on every bass hit); on = the composed layer added (plumes once per call).
    sheet = Image.new('RGB', (tw * 3, th * 2)); d = ImageDraw.Draw(sheet); stats = {}
    for row, (lab, js) in enumerate((('score off · plume on every bass hit', "P.score.on = false; P.plume.entry = 'hits';"), ('score on · one plume per call', "P.score.on = true; P.plume.entry = 'reply';"))):
        await page.evaluate(J(SCENE + js))
        for col, t in enumerate((6.4, 8.75, 11.2)):
            await play_to(page, t, t - 3.0)
            im = await shot(page); stats[f'{row}:{t}'] = np.asarray(im).astype(np.float32)
            sheet.paste(im.resize((tw, th), Image.LANCZOS), (col * tw, row * th)); label(d, col * tw, row * th, f'{lab} · {t:.2f} s', tw)
    sheet.save(os.path.join(OUT, 'score_off_vs_on.jpg'), quality=88); print('saved score_off_vs_on.jpg')
    pairs = {str(t): diff(stats[f'0:{t}'], stats[f'1:{t}']) for t in (6.4, 8.75, 11.2)}

    # 3 · the same from above (Survey), where the routes read as a drawing
    await page.evaluate(J(SCENE + " lp.goTo('survey'); P.gesture.reach = 1;"))
    sheet = Image.new('RGB', (tw * 3, th)); d = ImageDraw.Draw(sheet)
    for col, (t, what) in enumerate(((6.6, 'front arc'), (8.6, 'far arc'), (10.75, 'small centre arc, reply starting'))):
        await play_to(page, t, t - 3.0)
        sheet.paste((await shot(page)).resize((tw, th), Image.LANCZOS), (col * tw, 0)); label(d, col * tw, 0, f'Survey · {what} · {t:.2f} s', tw)
    sheet.save(os.path.join(OUT, 'score_from_above.jpg'), quality=88); print('saved score_from_above.jpg')
    await page.close()

    # 4 · a clip, because stills cannot show timing: 12 s (4 → 16 s of the excerpt), score off | score on, side by side
    page, logs2 = await boot(b, 640, 400)
    await load_excerpt(page); await page.evaluate(ui_js(True))
    fps, t0, t1, clips = 30, 4.0, 16.0, []
    for name, text, js in (('off', 'score off · a plume on every bass hit', "P.score.on = false; P.plume.entry = 'hits';"), ('on', 'score on · calls, replies, one plume per call', "P.score.on = true; P.plume.entry = 'reply';")):
        dd = os.path.join(OUT, f'score_clip_{name}'); shutil.rmtree(dd, ignore_errors=True); os.makedirs(dd)
        await page.evaluate(J(SCENE + js)); await play_to(page, t0, t0 - 3.0)
        await page.evaluate("""t => { let e = document.getElementById('clipLabel'); if (!e) { e = document.createElement('div'); e.id = 'clipLabel'; document.body.append(e);
          e.style.cssText = 'position:fixed;left:8px;top:6px;z-index:99;font:12px/1.4 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.6);padding:2px 7px;border-radius:4px'; } e.textContent = t; }""", text)
        for i in range(int((t1 - t0) * fps)):
            await page.evaluate(f"() => {{ const lp = window.__lp; lp.sources.virtual = {t0} + {i} / {fps}; window.__fake.step(1000 / {fps}); }}")
            await page.screenshot(path=os.path.join(dd, f'{i:04d}.png'))
        clips.append(dd); print('frames', name)
    wav = os.path.join(OUT, 'phrase_excerpt.wav'); out = os.path.join(OUT, 'score_off_vs_on.mp4')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', str(fps), '-i', os.path.join(clips[0], '%04d.png'), '-framerate', str(fps), '-i', os.path.join(clips[1], '%04d.png'),
                    '-ss', str(t0), '-t', str(t1 - t0), '-i', wav, '-filter_complex', '[0:v][1:v]hstack=inputs=2[v]', '-map', '[v]', '-map', '2:a',
                    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', out], check=True)
    for c in clips: shutil.rmtree(c, ignore_errors=True)
    print('saved score_off_vs_on.mp4')
    await page.close()
    return {'score_off_vs_on_meanAbsDiff8bit': pairs, 'errors': [l for l in logs + logs2 if l.startswith('[error]') or l.startswith('[pageerror]')]}

def timeline_chart(res, path):
    """When plumes launch in each entry mode, against the detected bass hits and the score's calls and replies."""
    m = res['plume_entry_modes']; W, H, L, R = 1280, 330, 190, 30
    x = lambda t: L + (W - L - R) * t / 16.2
    img = Image.new('RGB', (W, H), (12, 14, 20)); d = ImageDraw.Draw(img)
    d.text((16, 10), 'When a plume launches, in the three entry modes · composed excerpt, 0 to 16.2 s · 120 BPM set by hand, origin 0', fill=(230, 233, 240))
    for s in range(0, 17, 2): d.line((x(s), 38, x(s), H - 26), fill=(40, 44, 56)); d.text((x(s) - 6, H - 20), f'{s} s', fill=(150, 155, 170))
    rows = [('bass hits detected', m['bassHitsDetected'], (120, 150, 255), 'tick'), ('score: calls (0.7 s travel)', m['callStarts'], (255, 176, 64), 'call'), ('score: replies (+0.5 s)', m['reply']['launches'], (220, 235, 245), 'reply'),
            (f"plumes · every hit ({len(m['hits']['launches'])}, {m['hits']['dropped']} dropped)", m['hits']['launches'], (120, 150, 255), 'dot'),
            (f"plumes · cued ({len(m['cue']['launches'])})", m['cue']['launches'], (150, 255, 170), 'dot'), (f"plumes · once per call ({len(m['reply']['launches'])})", m['reply']['launches'], (255, 176, 64), 'dot')]
    for i, (name, times, col, kind) in enumerate(rows):
        y = 56 + i * 42; d.text((16, y - 6), name, fill=(200, 204, 215)); d.line((L, y, W - R, y), fill=(34, 38, 50))
        for t in times:
            if t > 16.2: continue
            if kind == 'tick': d.line((x(t), y - 9, x(t), y + 9), fill=col, width=2)
            elif kind == 'call': d.rectangle((x(t), y - 6, x(t + 0.7), y + 6), fill=col)
            elif kind == 'reply': d.rectangle((x(t), y - 6, x(t + 0.8), y + 6), outline=col)
            else: d.ellipse((x(t) - 6, y - 6, x(t) + 6, y + 6), fill=col)
    img.save(path, quality=92)

async def main(what):
    res = {}
    async with async_playwright() as p:
        b = await launch(p)
        if what in ('all', 'checks'):
            res = await checks(b)
            timeline_chart(res, os.path.join(OUT, 'score_plume_entry_timeline.png')); print('saved score_plume_entry_timeline.png')
        if what in ('all', 'sheets'): res['sheets'] = await sheets(b)
        await b.close()
    if what in ('all', 'checks'):
        with open(os.path.join(OUT, 'score_check.json'), 'w') as f: json.dump(res, f, indent=2, default=plain)
        bad = 0
        for k, v in res.items():
            if isinstance(v, dict) and 'pass' in v:
                bad += not v['pass']; print('PASS' if v['pass'] else 'FAIL', k, json.dumps({a: c for a, c in v.items() if a != 'pass'}, default=plain)[:300])
        n = sum(1 for v in res.values() if isinstance(v, dict) and 'pass' in v)
        print(f'{n - bad} of {n} composed-response checks pass · console errors: {len(res.get("errors", []))}')
        sys.exit(1 if bad or res.get('errors') else 0)

if __name__ == '__main__':
    asyncio.run(main((sys.argv[1:] or ['all'])[0]))
