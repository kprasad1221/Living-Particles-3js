"""Sample a palette from a reference clip, by role.

  python sample_palette.py SPEC.json CLIP.mp4 [--sheet out.jpg]

Follows the extraction steps in the colour article: pin the take and the frame times, sample useful
regions separately (not one histogram of the whole frame), keep a few deliberate stops per role, and
store the raw sample apart from the stop so a later edit stays traceable.

The spec (see palettes/sources/*.spec.json) names, for each ramp, its role and its stops; each stop says
which frame (seconds), which box (x0, y0, x1, y1 in source pixels), and how to read the box:

  median   the per-channel median of the box                    (a flat material)
  dark     the mean of the darkest tenth of its pixels          (the shadow inside it)
  upper    the mean of the pixels between the 75th and 90th percentile of brightness
  bright   the mean of the brightest tenth                      (a lit line or glint inside it)
  vivid    the mean of the most saturated tenth                 (the coloured edge of a light, which is
                                                                 what the eye calls its colour; the core is near white)

Writes the palette file named in the spec, in the format src/shared/palette.js reads: stop colours are
the samples as sRGB hex, and source.samples records each one (time, box, reading, rgb). Edit the stops
afterwards if the art direction wants it; the samples stay as the record of where they came from.

A sampled frame already includes the clip's lighting, exposure and grading. These are displayed colours
to match, not materials. The sheet shows every box on its frame and the ramps that result, so the
reading can be checked by eye.
"""
import json, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image, ImageDraw

def frame(clip, t, cache={}):
    if t not in cache:
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'f.png')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(t), '-i', clip, '-frames:v', '1', p], check=True)
            cache[t] = np.asarray(Image.open(p).convert('RGB')).astype(np.float32)
    return cache[t]

def read(px, pick):
    flat = px.reshape(-1, 3); luma = flat @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    if pick == 'median': return np.median(flat, axis=0)
    if pick == 'vivid':
        chroma = flat.max(axis=1) - flat.min(axis=1); sel = flat[chroma >= np.percentile(chroma, 90)]
        return sel.mean(axis=0)
    lo, hi = {'dark': (0, 10), 'upper': (75, 90), 'bright': (90, 100)}[pick]
    a, b = np.percentile(luma, lo), np.percentile(luma, hi)
    sel = flat[(luma >= a) & (luma <= b)]
    return sel.mean(axis=0) if len(sel) else np.median(flat, axis=0)

hexof = lambda rgb: '#' + ''.join(f'{int(round(float(v))):02x}' for v in np.clip(rgb, 0, 255))

def strip(stops, w, h):
    """The ramp as palette.js draws it: interpolate the sRGB values between stops."""
    out = np.zeros((h, w, 3), dtype=np.uint8); pos = [s['position'] for s in stops]; cols = [np.array([int(s['color'][i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32) for s in stops]
    for x in range(w):
        t = x / (w - 1); i = max(0, min(len(stops) - 2, int(np.searchsorted(pos, t, side='right')) - 1))
        f = 0 if pos[i + 1] == pos[i] else min(1, max(0, (t - pos[i]) / (pos[i + 1] - pos[i])))
        out[:, x] = np.round(cols[i] + (cols[i + 1] - cols[i]) * f)
    return Image.fromarray(out)

def main(spec_path, clip, sheet=None):
    spec = json.load(open(spec_path)); root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))      # the repository: spec['out'] is relative to it
    ramps, samples, times, boxes = {}, {}, set(), {}
    for name, r in spec['ramps'].items():
        stops = []; samples[name] = {}
        for s in r['stops']:
            x0, y0, x1, y1 = s['box']; rgb = read(frame(clip, s['t'])[y0:y1, x0:x1], s['pick']); times.add(s['t'])
            stops.append({'id': s['id'], 'position': s['position'], 'color': hexof(rgb)})
            samples[name][s['id']] = {'t': s['t'], 'box': s['box'], 'pick': s['pick'], 'rgb': [int(round(float(v))) for v in rgb], 'what': s['what']}
            boxes.setdefault(s['t'], []).append((s['box'], f"{name}/{s['id']}", hexof(rgb)))
        ramps[name] = {'role': r['role'], 'domain': r['domain'], 'curve': r.get('curve', 1), 'emissionScale': 1, 'stops': stops}
    h0, w0 = frame(clip, min(times)).shape[:2]
    palette = {'schema': 1, 'id': spec['id'], 'version': spec.get('version', 1), 'name': spec['name'],
               'source': {'kind': 'sampled', 'note': spec['note'], 'take': spec['take'], 'clip': spec['clip'], 'frameSize': [w0, h0], 'frameTimes': sorted(times),
                          'spec': os.path.relpath(os.path.abspath(spec_path), root).replace(os.sep, '/'), 'samples': samples},
               'inputColorSpace': 'srgb', 'ramps': ramps}
    out = os.path.join(root, spec['out'])
    with open(out, 'w') as f: f.write(json.dumps(palette, indent=2) + '\n')
    print('wrote', os.path.relpath(out, root))
    for name, r in ramps.items(): print(f'  {name:9s}', '  '.join(f"{s['id']} {s['color']}" for s in r['stops']))
    if sheet:
        ts = sorted(times); fw, fh = 688, int(688 * h0 / w0); sw = fw * len(ts)
        img = Image.new('RGB', (sw, fh + 34 + 46 * len(ramps)), (12, 14, 20)); d = ImageDraw.Draw(img)
        for i, t in enumerate(ts):
            im = Image.fromarray(frame(clip, t).astype(np.uint8)).resize((fw, fh), Image.LANCZOS); img.paste(im, (i * fw, 0)); k = fw / w0
            seen = {}                                                                                           # stops read from the same box stack their labels
            for (x0, y0, x1, y1), lab, col in boxes[t]:
                row = seen.get((x0, y0, x1, y1), 0); seen[(x0, y0, x1, y1)] = row + 1; ly = y1 * k + 1 + 14 * row
                d.rectangle((i * fw + x0 * k, y0 * k, i * fw + x1 * k, y1 * k), outline=(255, 255, 255)); d.rectangle((i * fw + x0 * k, ly, i * fw + x0 * k + 6.1 * len(lab) + 16, ly + 13), fill=(0, 0, 0))
                d.rectangle((i * fw + x0 * k + 2, ly + 2, i * fw + x0 * k + 11, ly + 11), fill=col); d.text((i * fw + x0 * k + 14, ly + 1), lab, fill=(255, 255, 255))
            head = f"{spec['take']} · {t:.1f} s".replace('×', 'x')                                              # the built-in font has no multiplication sign
            d.rectangle((i * fw, 0, i * fw + 6.1 * len(head) + 8, 15), fill=(0, 0, 0)); d.text((i * fw + 4, 2), head, fill=(255, 255, 255))
        y = fh + 12
        d.text((10, y), f"{spec['name']}: sampled stops (white boxes above), drawn as palette.js interpolates them. Displayed colours from a graded clip, not materials.", fill=(210, 214, 225)); y += 22
        for name, r in ramps.items():
            d.text((10, y + 8), f"{name} · {r['role']}", fill=(210, 214, 225)); img.paste(strip(r['stops'], sw - 420, 26), (170, y + 2))
            d.text((sw - 240, y + 8), ' '.join(s['color'] for s in r['stops'])[:38], fill=(150, 155, 170)); y += 46
        img.save(sheet, quality=90); print('saved', sheet)

if __name__ == '__main__':
    a = sys.argv[1:]; sheet = None
    if '--sheet' in a: i = a.index('--sheet'); sheet = a[i + 1]; del a[i:i + 2]
    if len(a) != 2: print(__doc__); sys.exit(0)
    main(a[0], a[1], sheet)
