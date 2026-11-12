"""Pair matched stills into one labelled sheet and say how much each pair differs.

  python compare.py sheet DIR_A DIR_B OUT.jpg --labels "before" "after" --match m_baseline_
  python compare.py grid  DIR_A DIR_B OUT.jpg --labels "before" "after" --set baseline [--cam stand]

sheet  every file present in both folders, one pair per row
grid   stills named m_<set>_<scene>_<moment>_<cam>.png: per scene, row A and row B; columns are
       rest, attack, crest, release (the same audio times in both rows)

The numbers are simple on purpose:
  diff     mean absolute difference of the 8-bit sRGB pixels (0 = identical frames)
  level    mean of the 8-bit pixels of each image (a rough brightness, not a perceptual measure)
A still shows appearance at one moment; it says nothing about motion or timing.
"""
import sys, os, json
import numpy as np
from PIL import Image, ImageDraw

MOMENT_ORDER = ['rest', 'attack', 'crest', 'release']

def stats(a, b):
    A = np.asarray(Image.open(a).convert('RGB')).astype(np.float32); B = np.asarray(Image.open(b).convert('RGB')).astype(np.float32)
    return {'meanAbsDiff8bit': round(float(np.abs(A - B).mean()), 3), 'levelA': round(float(A.mean()), 2), 'levelB': round(float(B.mean()), 2),
            'changedPixelsPct': round(float((np.abs(A - B).max(axis=2) > 2).mean() * 100), 2)}

def _label(d, x, y, text):
    d.rectangle((x, y, x + 10 + 6.1 * len(text), y + 17), fill=(0, 0, 0)); d.text((x + 5, y + 3), text, fill=(255, 255, 255))

def _save(img, out, payload):
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    img.save(out, quality=88)
    with open(os.path.splitext(out)[0] + '.json', 'w') as fh: json.dump(payload, fh, indent=2)

def sheet(dir_a, dir_b, out, labels=('A', 'B'), match='', tile=(640, 400)):
    names = sorted(f for f in os.listdir(dir_a) if f.endswith('.png') and f.startswith(match) and os.path.exists(os.path.join(dir_b, f)))
    tw, th = tile
    img = Image.new('RGB', (tw * 2, th * len(names))); d = ImageDraw.Draw(img); res = {}
    for r, f in enumerate(names):
        pa, pb = os.path.join(dir_a, f), os.path.join(dir_b, f); st = stats(pa, pb); res[f] = st
        for c, (p, lab) in enumerate(((pa, labels[0]), (pb, labels[1]))):
            img.paste(Image.open(p).convert('RGB').resize((tw, th), Image.LANCZOS), (c * tw, r * th))
            _label(d, c * tw, r * th, f"{lab} · {f[:-4].replace('m_', '').replace('_', ' · ')}" + (f"   diff {st['meanAbsDiff8bit']} / 255" if c else ''))
    _save(img, out, {'a': dir_a, 'b': dir_b, 'labels': list(labels), 'pairs': res})
    return res

def grid(dir_a, dir_b, out, labels=('A', 'B'), set_name='baseline', cam='stand', tile=(480, 300), scenes_a=None, scenes_b=None):
    """scenes_a / scenes_b: scene names per row pair. Default: the same scene in both folders.
    Pass different lists to put two scenes of one folder side by side (e.g. nocturne vs mineral)."""
    pre = f'm_{set_name}_'
    found = sorted({f[len(pre):].rsplit('_', 2)[0] for f in os.listdir(dir_a) if f.startswith(pre) and f.endswith(f'_{cam}.png')})
    scenes_a = scenes_a or found; scenes_b = scenes_b or scenes_a
    tw, th = tile
    img = Image.new('RGB', (tw * 4, th * 2 * len(scenes_a))); d = ImageDraw.Draw(img); res = {}
    for r, (sa, sb) in enumerate(zip(scenes_a, scenes_b)):
        for c, m in enumerate(MOMENT_ORDER):
            pa, pb = os.path.join(dir_a, f'{pre}{sa}_{m}_{cam}.png'), os.path.join(dir_b, f'{pre}{sb}_{m}_{cam}.png')
            st = stats(pa, pb); res[f'{sa}|{sb}|{m}'] = st
            img.paste(Image.open(pa).convert('RGB').resize((tw, th), Image.LANCZOS), (c * tw, (2 * r) * th))
            img.paste(Image.open(pb).convert('RGB').resize((tw, th), Image.LANCZOS), (c * tw, (2 * r + 1) * th))
            _label(d, c * tw, (2 * r) * th, f'{labels[0]} · {sa} · {m}')
            _label(d, c * tw, (2 * r + 1) * th, f"{labels[1]} · {sb} · {m} · diff {st['meanAbsDiff8bit']} / 255")
    _save(img, out, {'a': dir_a, 'b': dir_b, 'labels': list(labels), 'set': set_name, 'camera': cam, 'pairs': res})
    return res

if __name__ == '__main__':
    a = sys.argv[1:]
    def opt(name, n=1, default=None):
        if name not in a: return default
        i = a.index(name); v = a[i + 1:i + 1 + n]; del a[i:i + 1 + n]
        return v[0] if n == 1 else tuple(v)
    labels = opt('--labels', 2, ('A', 'B')); match = opt('--match', 1, ''); set_name = opt('--set', 1, 'baseline'); cam = opt('--cam', 1, 'stand')
    sa = opt('--scenes-a', 1); sb = opt('--scenes-b', 1)
    if a[:1] == ['sheet']: res = sheet(a[1], a[2], a[3], labels, match)
    elif a[:1] == ['grid']: res = grid(a[1], a[2], a[3], labels, set_name, cam, scenes_a=sa.split(',') if sa else None, scenes_b=sb.split(',') if sb else None)
    else: print(__doc__); sys.exit(0)
    for k, v in res.items(): print(k, v)
