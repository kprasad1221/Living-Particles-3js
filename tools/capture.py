"""Checks and captures for the precision pass. The app runs on a fake display clock and a
virtual audio clock (sources.virtual), so every shot and check is repeatable.

  python capture.py check                  # §8.2 integration checks → captures/check.json
  python capture.py                        # look captures at the same musical moment
  python capture.py av2p:stand av2:survey  # look:camera[:clean]
  python capture.py diag av2p              # composite / no glow / glow only / emission / surfaces
  python capture.py motion av2 av2p        # orbiting-camera clips, side by side
  python capture.py ui                     # interface at 1440, 820 and 390 px
  python capture.py phrase                 # matched rest/attack/crest/release on the composed excerpt

Waveform fixtures (no browser): node tools/fixtures.mjs
"""
import asyncio, sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import *

DEFAULT = ['av2p:stand:clean', 'av2:stand:clean', 'av3:stand:clean', 'av1:stand:clean', 'nocturne:stand:clean', 'av2p:survey:clean']
MOMENT = 6.0          # seconds into the test pattern for every still

async def boot(b, w=1440, h=900):
    page, logs = await new_page(b, w, h)
    await page.goto(serve() + '/index.html'); await page.wait_for_timeout(2000)
    await wait_ready(page)
    return page, logs

async def wait_ready(page):
    for _ in range(120):
        if await page.evaluate('!!(window.__lp && window.__lp.ready())'): return True
        await page.evaluate('window.__fake.step(16.6667)'); await page.wait_for_timeout(50)
    return False

async def play_to(page, t_end, t_start=None, fps=60, draw=False):
    """Advance the virtual audio clock to t_end in display steps of 1/fps (drawing off unless asked)."""
    await page.evaluate("d => { window.__lp.state.skipDraw = d; }", not draw)
    if t_start is not None:
        await page.evaluate("([t, fps]) => { window.__lp.sources.virtual = t; window.__fake.step(1000 / fps); }", [t_start, fps])
    await page.evaluate("""([tEnd, fps]) => { const lp = window.__lp, t = lp.sources.virtual, n = Math.round((tEnd - t) * fps);
        for (let i = 1; i <= n; i++) { lp.sources.virtual = t + i / fps; window.__fake.step(1000 / fps); }
        lp.sources.virtual = tEnd; }""", [t_end, fps])
    await page.evaluate("() => { window.__lp.state.skipDraw = false; }")

async def shot(page, look, cam, name, clean=True, extra=''):
    await page.evaluate(f"""() => {{ document.body.classList.toggle('perform', {str(clean).lower()});
      document.querySelector('.toggles').style.visibility = '{'hidden' if clean else ''}';
      const lp = window.__lp; lp.app.loadLook('a', '{look}'); lp.P.looks.morph = 0; lp.P.looks.preview = 'a';
      lp.P.pointer.on = false; {extra} lp.goTo('{cam}'); }}""")
    await play_to(page, MOMENT, MOMENT - 2.0)
    for _ in range(2): await page.evaluate('window.__fake.step(16.6667)')
    await page.wait_for_timeout(150)
    out = os.path.join(OUT, name); await page.screenshot(path=out); print('saved', out)
    return out

async def captures(names):
    async with async_playwright() as p:
        b = await launch(p); page, logs = await boot(b)
        for n in names:
            look, cam, *rest = n.split(':') + ['stand']
            clean = 'clean' in rest
            await shot(page, look, cam, f'{look}_{cam}{"_clean" if clean else ""}.png', clean)
        errs = [l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')]
        print('console errors:', len(errs)); print('\n'.join(errs[:10])); await b.close()

async def diag_views(look='av2p'):
    async with async_playwright() as p:
        b = await launch(p); page, logs = await boot(b)
        for view in ['normal', 'nobloom', 'bloom', 'emission', 'surface']:
            await shot(page, look, 'stand', f'diag_{look}_{view}.png', True, f"lp.P.diag.view = '{view}';")
        await page.evaluate("window.__lp.P.diag.view = 'normal'"); await b.close()

async def motion(looks=('av2', 'av2p'), seconds=3.0, fps=30):
    import subprocess, shutil
    async with async_playwright() as p:
        b = await launch(p); page, logs = await boot(b, 960, 600)
        await page.evaluate("document.body.classList.add('perform'); document.querySelector('.toggles').style.visibility='hidden'")
        clips = []
        for look in looks:
            d = os.path.join(OUT, f'motion_{look}'); shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
            await page.evaluate(f"() => {{ const lp = window.__lp; lp.app.loadLook('a', '{look}'); lp.P.looks.preview = 'a'; lp.P.pointer.on = false; }}")
            await play_to(page, 4.0, 2.0)
            n = int(seconds * fps)
            for i in range(n):
                await page.evaluate(f"""() => {{ const lp = window.__lp; lp.sources.virtual = 4.0 + {i} / {fps};
                  const a = {i} / {n} * 0.6 - 0.3, r = 26; lp.stage.camera.position.set(Math.sin(a) * r, 6.2, Math.cos(a) * r - 2);
                  lp.stage.controls.target.set(0, 2.2, -14); lp.stage.controls.update(); window.__fake.step(1000 / {fps}); }}""")
                await page.screenshot(path=os.path.join(d, f'{i:04d}.png'))
            out = os.path.join(OUT, f'motion_{look}.mp4')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', str(fps), '-i', os.path.join(d, '%04d.png'), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', out], check=True)
            clips.append(out); print('saved', out)
        if len(clips) == 2:
            out = os.path.join(OUT, 'motion_' + '_vs_'.join(looks) + '.mp4')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', clips[0], '-i', clips[1], '-filter_complex', 'hstack=inputs=2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', out], check=True)
            print('saved', out)
        await b.close()

async def ui_views():
    async with async_playwright() as p:
        b = await launch(p)
        for (w, h) in [(1440, 900), (820, 1180), (390, 844)]:
            page, logs = await boot(b, w, h)
            await play_to(page, MOMENT, MOMENT - 1.0)
            for _ in range(2): await page.evaluate('window.__fake.step(16.6667)')
            out = os.path.join(OUT, f'ui_{w}x{h}.png'); await page.screenshot(path=out); print('saved', out)
            await page.close()
        await b.close()

HOOK = """() => { const lp = window.__lp; window.__events = []; const tl = lp.timeline;
  if (!tl.__hooked) { const orig = tl.onEvent; tl.onEvent = ev => { window.__events.push(ev.id + '@' + ev.time.toFixed(6)); orig(ev); }; tl.__hooked = true; } }"""
STATE = """() => { const lp = window.__lp; let h = 0, s = 0;
  for (let i = 0; i < lp.response.hist.length; i++) h += lp.response.hist[i] * ((i % 97) + 1);
  const st = lp.sparks.start.array; for (let i = 0; i < st.length; i++) s += st[i] * ((i % 89) + 1);
  return { histSum: h, sparkSum: s, events: window.__events.map(e => e.slice(e.indexOf(':') + 1)), emitted: lp.sparks.stats.emitted }; }"""

async def check():
    res = {}
    async with async_playwright() as p:
        b = await launch(p); page, logs = await boot(b)
        res['ready'] = await page.evaluate('window.__lp.ready()')
        await page.evaluate(HOOK)
        meta = await page.evaluate('window.__lp.timeline.f.meta')
        res['analysis'] = {k: meta.get(k) for k in ['analysisVersion', 'sampleRate', 'duration', 'bandWin', 'bandHop', 'fastWin', 'fastHop', 'timing', 'analysisMs']}
        dur = meta['duration']

        # 1 · Render-rate invariance: same audio time → same history rows, events, spark births.
        runs = {}
        for fps in (30, 60, 120):
            await page.evaluate("() => { window.__events = []; window.__lp.timeline.started = false; }")
            await play_to(page, 0.0, 0.0, fps)
            await play_to(page, 5.0, None, fps)
            runs[fps] = await page.evaluate(STATE)
        r30, r60, r120 = runs[30], runs[60], runs[120]
        rr = {'histDiff': [abs(r30['histSum'] - r60['histSum']), abs(r120['histSum'] - r60['histSum'])],
              'events': [len(r['events']) for r in (r30, r60, r120)],
              'sameEventIdsAndTimes': r30['events'] == r60['events'] == r120['events'],
              'sparkBirthsDiff': [abs(r30['sparkSum'] - r60['sparkSum']), abs(r120['sparkSum'] - r60['sparkSum'])],
              'emitted': [r['emitted'] for r in (r30, r60, r120)]}
        rr['pass'] = max(rr['histDiff']) < 1e-3 and rr['sameEventIdsAndTimes'] and max(rr['sparkBirthsDiff']) < 1e-2 and len(set(rr['emitted'])) == 1
        res['render_rate_invariance'] = rr

        # 2 · Two complete loops plus a second: every event once per loop, unique ids, first and last present.
        await page.evaluate("() => { window.__events = []; window.__lp.timeline.started = false; }")
        await play_to(page, 0.0, 0.0)
        await play_to(page, 2 * dur + 1.0)
        lp = await page.evaluate("""() => { const lp = window.__lp, n = lp.timeline.ev.time.length, ids = window.__events.map(e => e.split('@')[0]);
          const per = [0, 1, 2].map(L => ids.filter(id => id.split(':')[1] === String(L)).length);
          const idx = L => ids.filter(id => id.split(':')[1] === String(L)).map(id => +id.split(':')[2]);
          return { eventsInSource: n, eventsPerLoop: per, total: ids.length, unique: new Set(ids).size === ids.length,
                   loop0First: idx(0).includes(0), loop0Last: idx(0).includes(n - 1), loop1First: idx(1).includes(0), loop1Last: idx(1).includes(n - 1) }; }""")
        lp['pass'] = lp['unique'] and lp['eventsPerLoop'][0] == lp['eventsInSource'] == lp['eventsPerLoop'][1] and lp['loop0Last'] and lp['loop1First']
        res['two_loops'] = lp

        # 3 · Seek backwards: new epoch, history rebuilt, old sparks cleared.
        e0 = await page.evaluate("window.__lp.timeline.epoch")
        await play_to(page, 3.0, 3.0)
        sb = await page.evaluate(f"() => ({{ epochBefore: {e0}, epochAfter: window.__lp.timeline.epoch, aliveAfterSeek: window.__lp.sparks.countAlive(3.0), historyRows: window.__lp.response.rows }})")
        sb['pass'] = sb['epochAfter'] > e0 and sb['aliveAfterSeek'] == 0 and sb['historyRows'] > 0
        res['seek_back'] = sb

        # 4 · Manual step: time to 90 % matches the displayed rise time, within one update.
        await page.evaluate("() => { const lp = window.__lp; lp.P.manual.on = true; lp.P.manual.voice = 3; lp.P.manual.level = 0; lp.P.map.lift.rise = 200; }")
        await play_to(page, 5.0, 4.0)
        await page.evaluate("() => { const lp = window.__lp; lp.P.manual.level = 1; window.__t0 = lp.timeline.latest; }")
        t90 = None
        for i in range(1, 100):
            await play_to(page, 5.0 + i / 240, None, 240)
            if await page.evaluate("window.__lp.response.lift[3] >= 0.9"):
                t90 = await page.evaluate("window.__lp.timeline.latest - window.__t0"); break
        hop = meta['bandHop'] / meta['sampleRate']
        res['manual_step_rise'] = {'setMs': 200, 'measuredMs': None if t90 is None else round(t90 * 1000, 2), 'updateIntervalMs': round(hop * 1000, 2),
                                   'pass': t90 is not None and abs(t90 * 1000 - 200) <= hop * 1000 + 0.5}
        await page.evaluate("() => { const lp = window.__lp; lp.P.manual.on = false; lp.P.map.lift.rise = 40; }")

        # 5 · Silence after a busy section: events stop, envelopes decay. Then one manual hit = one budget.
        await page.evaluate("""async () => { const lp = window.__lp, ctx = lp.sources.ensureContext(), sr = ctx.sampleRate;
          const { renderPattern } = await import('./src/analysis/pattern.js');
          const busy = renderPattern(sr, 4), buf = ctx.createBuffer(1, sr * 12, sr); buf.copyToChannel(busy, 0);
          document.getElementById('loopChk').checked = false; lp.sources.setLoop(false);
          await lp.startBuffered('track', 'silence-test', 'silence test', buf); lp.timeline.setLoop(false); }""")
        await wait_ready(page)
        await page.evaluate("() => { window.__events = []; }")
        await play_to(page, 0.0, 0.0); await play_to(page, 4.0)
        busy = await page.evaluate("({ n: window.__events.length, lift: Array.from(window.__lp.response.lift).map(v => +v.toFixed(3)) })")
        await play_to(page, 4.3)                    # let the last decays finish
        await page.evaluate("() => { window.__events = []; }")
        await play_to(page, 9.5)
        sil = await page.evaluate("({ n: window.__events.length, lift: Array.from(window.__lp.response.lift).map(v => +v.toFixed(4)), gateOpen: Array.from(window.__lp.timeline.interp.open) })")
        res['silence_after_busy'] = {'eventsIn4sBusy': busy['n'], 'eventsFrom4_3to9_5s': sil['n'], 'liftAt4s': busy['lift'], 'liftAt9_5s': sil['lift'],
                                     'gatesOpenInSilence': sum(sil['gateOpen']), 'pass': sil['n'] == 0 and max(sil['lift']) < 0.01}
        await page.evaluate("() => { const lp = window.__lp; lp.P.sparks.from = 'all'; lp.P.sparks.continuous = 0; lp.P.manual.voice = 6; window.__e0 = lp.sparks.stats.emitted; lp.app.fireHit(); }")
        await play_to(page, 9.7)
        a = await page.evaluate("window.__lp.sparks.stats.emitted - window.__e0")
        await play_to(page, 11.0)
        b2 = await page.evaluate("window.__lp.sparks.stats.emitted - window.__e0")
        births = await page.evaluate("""() => { const lp = window.__lp, st = lp.sparks.start.array; let lo = 1e9, hi = -1e9;
          for (let i = 0; i < st.length / 4; i++) { const t = st[i * 4 + 3]; if (t > 9.4 && t < 20) { lo = Math.min(lo, t); hi = Math.max(hi, t); } }
          return { firstBirth: +lo.toFixed(4), lastBirth: +hi.toFixed(4), edgeDelayS: +(lp.field.layout.radius / lp.P.movement.travel).toFixed(3) }; }""")
        res['single_hit_budget'] = {'perHit': await page.evaluate('window.__lp.P.sparks.perHit'), 'emittedBy0_2s': a, 'emittedBy1_5s': b2, **births,
                                    'pass': a == b2 and a > 0}

        # 6 · Spark origins on the drawn surface, with pointer lift and sub swell active: run the real burst
        #     code for one event at the current moment and compare each origin with the tile-state height
        #     (the CPU copy of the vertex shader) and with a naive height that ignores swell and pointer.
        await page.evaluate("() => { const lp = window.__lp; lp.P.pointer.on = true; lp.P.pointer.mode = 'orbit'; lp.P.pointer.speed = 0; lp.P.pointer.lift = 2.5; lp.P.pointer.radius = 30; lp.P.movement.swell = 2.0; lp.P.movement.ripple = 'instant'; }")
        await play_to(page, 1.0, 1.0); await play_to(page, 1.5, None, 60, True)
        res['spark_origin_on_surface'] = await page.evaluate("""() => { const lp = window.__lp, L = lp.field.layout, sp = lp.sparks, st = sp.start.array, u = lp.field.uniforms;
          const t = lp.timeline.latest, c0 = sp.cursor;
          sp.burst({ id: '0:check:0', time: t, voice: 6, strength: 1 }, lp.field, lp.stage.affector, () => 0);
          const near = (x, z) => { let bi = -1, bd = 1e9; for (let i = 0; i < L.count; i++) { const d = (L.x[i] - x) ** 2 + (L.z[i] - z) ** 2; if (d < bd) { bd = d; bi = i; } } return bi; };
          let worst = 0, naiveGap = 0, n = 0;
          for (let s = c0; s !== sp.cursor; s = (s + 1) % (st.length / 4)) {
            const i = near(st[s * 4], st[s * 4 + 2]), ts = lp.field.tileState(i, lp.histAt, t, lp.stage.affector, 60, -1e9);
            const naive = u.uBase.value + L.jitter[i] * u.uJitter.value + u.uExtrude.value * Math.pow(ts.act, u.uShape.value);
            worst = Math.max(worst, Math.abs(st[s * 4 + 1] - 0.05 - ts.height)); naiveGap = Math.max(naiveGap, Math.abs(st[s * 4 + 1] - 0.05 - naive)); n++; }
          return { sparks: n, worstErrorUnits: +worst.toFixed(5), largestSwellPlusPointerUnits: +naiveGap.toFixed(3),
                   note: 'origins include sub swell and pointer lift; CPU tile state mirrors the vertex shader term for term (not a GPU read-back)' }; }""")
        res['spark_origin_on_surface']['pass'] = res['spark_origin_on_surface']['sparks'] > 0 and res['spark_origin_on_surface']['worstErrorUnits'] < 1e-3
        await page.evaluate("() => { const lp = window.__lp; lp.P.movement.ripple = 'outward'; lp.P.movement.swell = 0.5; lp.P.pointer.mode = 'pointer'; lp.P.pointer.lift = 1.8; lp.P.pointer.radius = 9; }")

        res['counts'] = await page.evaluate("() => ({ tiles: window.__lp.app.stats.tiles, calls: window.__lp.app.stats.calls, tris: window.__lp.app.stats.tris })")
        # 7 · A Study 01 save migrates; a malformed import cannot break relationships.
        res['migration_v1'] = await page.evaluate("""() => { const lp = window.__lp;
          const v1 = { version: 'study-01/0.1.0', spawn: { rings: 40, density: 0.5 }, init: { spread: 0.3 }, update: { extrude: 2.7, travel: 0, pulseVoice: 3 },
            voices: { attack: 0.012, releaseLow: 0.24, releaseHigh: 0.06, onset: 1.8 }, affector: { radius: 12 }, sparks: { burst: 0.5, shimmer: 5 },
            looks: { a: 'av2', b: 'av3', morph: 0.25, drive: 'hand', edit: 'a', lookA: { name: 'old', v0: '#123456', v1: '#1aa8ff', v2: '#22e3ff', v3: '#ffd23a', v4: '#ff9a1f', v5: '#ff5a1f', v6: '#5fd0ff', v7: '#fff1b0',
              rim: '#ff1f35', face: '#12040a', side: '#24070f', skyTop: '#3f6cc4', horizon: '#d5e1f2', rimWidth: 0.15, rimGlow: 1.5, rimPulse: 1.0, fillGlow: 0.85, fillCore: 0.12, sideGlow: 0.75, edgeLines: 0.15, grain: 0,
              flash: 1.8, fog: 0.006, horizonGlow: 0.35, bloom: 0.6, bloomRadius: 0.45, bloomThreshold: 0.85, exposure: 0.92 } } };
          lp.applyScene(v1, { fly: false }); const s = lp.snapshot();
          return { schema: s.schema, rings: s.floor.rings, active: s.floor.active, variation: s.floor.variation, lift: s.movement.lift, ripple: s.movement.ripple,
                   rimSource: s.map.rim.source, liftRiseMs: +s.map.lift.rise.toFixed(1), liftFallMs: +s.map.lift.fall.toFixed(1), pointerRadius: s.pointer.radius,
                   perHit: s.sparks.perHit, continuous: s.sparks.continuous, lookAv0: s.looks.lookA.v0, lookArestRim: +s.looks.lookA.restRim.toFixed(4), morph: s.looks.morph }; }""")
        res['import_validation'] = await page.evaluate("""() => { const lp = window.__lp; const s = lp.snapshot();
          s.movement.floor = 0.9; s.movement.ceil = 0.1; s.sparks.life = -3; s.floor.rings = 1e9; s.music.reference = null; s.sparks.perHit = 1e7; s.looks.lookA.restRim = 'x';
          lp.applyScene(s, { fly: false }); const P = lp.P;
          return { floor: P.movement.floor, ceil: P.movement.ceil, life: P.sparks.life, rings: P.floor.rings, reference: P.music.reference, perHit: P.sparks.perHit,
                   restRim: lp.app.lookA.restRim,
                   pass: P.movement.ceil > P.movement.floor && P.sparks.life > 0 && P.floor.rings <= 96 && Number.isFinite(P.music.reference) && P.sparks.perHit <= 400 && Number.isFinite(lp.app.lookA.restRim) }; }""")
        res['errors'] = [l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')]
        await b.close()
    print(json.dumps(res, indent=1))
    with open(os.path.join(OUT, 'check.json'), 'w') as f: json.dump(res, f, indent=2)

async def phrase():
    """Matched before/after on the composed 20 s excerpt (tools/phrase_excerpt.py): rest, attack,
    crest and release at the same audio times, Stand view (plus Survey at the crest).
    Baseline = Study 01 response with the AV2 look; revision = the Plume phrase scene."""
    from phrase_excerpt import write, MOMENTS
    wav = write(os.path.join(OUT, 'phrase_excerpt.wav'))
    async with async_playwright() as p:
        b = await launch(p); page, logs = await boot(b)
        await page.set_input_files('#fileInput', wav)
        for _ in range(240):
            if await page.evaluate("window.__lp.sources.mode === 'track' && window.__lp.ready()"): break
            await page.evaluate('window.__fake.step(16.6667)'); await page.wait_for_timeout(100)
        res = {'ready': await page.evaluate("window.__lp.ready()"), 'source': await page.evaluate("document.getElementById('nowPlaying').textContent")}
        await page.evaluate("document.body.classList.add('perform'); document.querySelector('.toggles').style.visibility='hidden'")
        configs = {
          'baseline': "lp.app.resetScene(); lp.app.loadLook('a', 'av2'); lp.P.looks.preview = 'a';",
          'revision': "lp.app.loadPlumeScene(); lp.P.looks.preview = 'a';",
        }
        shots = []
        for name, js in configs.items():
            await page.evaluate(f"() => {{ const lp = window.__lp; {js} lp.P.pointer.on = false; lp.sparks.seed = 1; }}")
            for label, t in MOMENTS.items():
                for cam in (['stand', 'survey'] if label == 'crest' else ['stand']):
                    await page.evaluate(f"window.__lp.goTo('{cam}')")
                    await play_to(page, t, max(0.0, t - 2.5))
                    for _ in range(2): await page.evaluate('window.__fake.step(16.6667)')
                    await page.wait_for_timeout(150)
                    out = os.path.join(OUT, f'phrase_{name}_{label}_{cam}.png'); await page.screenshot(path=out); shots.append(out)
                    res[f'{name}_{label}_{cam}'] = await page.evaluate("() => { const s = window.__lp.sparks.stats; return { plumes: s.plumes, plumesDropped: s.plumesDropped, alive: window.__lp.sparks.countAlive ? window.__lp.sparks.countAlive(window.__lp.sparks.now) : null }; }")
        # One plume, frame by frame: the attack at 4.0 s launches it; read its scheduled birth.
        # At most one plume at a time here, so the following kicks don't overlap the gesture.
        await page.evaluate("window.__lp.goTo('stand'); window.__lp.P.plume.maxConcurrent = 1")
        await play_to(page, 4.0, 3.0)
        await play_to(page, 4.05)
        birth = await page.evaluate("""() => { const sp = window.__lp.sparks, s = sp.start.array, m = sp.meta.array; let b = Infinity;
          for (let i = 0; i < s.length / 4; i++) if (m[i * 4 + 2] > 0.5 && s[i * 4 + 3] > 3.9 && s[i * 4 + 3] < b) b = s[i * 4 + 3]; return b; }""")
        res['plume_birth'] = birth
        strip = []
        from PIL import Image, ImageDraw
        for ms, phase in [(40, 'emerge'), (180, 'rise'), (450, 'curl'), (850, 'curl'), (1300, 'disperse'), (1750, 'rest')]:
            await play_to(page, birth + ms / 1000)
            for _ in range(2): await page.evaluate('window.__fake.step(16.6667)')
            await page.wait_for_timeout(120)
            f = os.path.join(OUT, f'plume_{ms:04d}.png'); await page.screenshot(path=f); strip.append((f, f'+{ms} ms · {phase}'))
        tw, th = 480, 300
        sheet = Image.new('RGB', (tw * 3, th * 2)); d = ImageDraw.Draw(sheet)
        for k, (f, label) in enumerate(strip):
            im = Image.open(f).convert('RGB').resize((tw, th)); x, y = (k % 3) * tw, (k // 3) * th
            sheet.paste(im, (x, y)); d.text((x + 8, y + 6), label, fill=(255, 255, 255))
        sheet.save(os.path.join(OUT, 'plume_phrase_strip.jpg'), quality=86)
        rows = ['rest_stand', 'attack_stand', 'crest_stand', 'crest_survey', 'release_stand']
        sheet = Image.new('RGB', (tw * 2, th * len(rows))); d = ImageDraw.Draw(sheet)
        for r, row in enumerate(rows):
            for c, cfg in enumerate(['baseline', 'revision']):
                im = Image.open(os.path.join(OUT, f'phrase_{cfg}_{row}.png')).convert('RGB').resize((tw, th))
                sheet.paste(im, (c * tw, r * th)); d.text((c * tw + 8, r * th + 6), f'{cfg} · {row.replace("_", " · ")} · {MOMENTS[row.split("_")[0]]:.2f} s', fill=(255, 255, 255))
        sheet.save(os.path.join(OUT, 'phrase_baseline_vs_revision.jpg'), quality=86)
        res['errors'] = [l for l in logs if l.startswith('[error]') or l.startswith('[pageerror]')]
        await b.close()
    print(json.dumps(res, indent=1))
    with open(os.path.join(OUT, 'phrase.json'), 'w') as f: json.dump(res, f, indent=2)

if __name__ == '__main__':
    args = sys.argv[1:]
    if args == ['check']: asyncio.run(check())
    elif args == ['phrase']: asyncio.run(phrase())
    elif args == ['ui']: asyncio.run(ui_views())
    elif args[:1] == ['diag']: asyncio.run(diag_views(*(args[1:2] or ['av2p'])))
    elif args[:1] == ['motion']: asyncio.run(motion(tuple(args[1:3]) if len(args) >= 3 else ('av2', 'av2p')))
    else: asyncio.run(captures(args or DEFAULT))
