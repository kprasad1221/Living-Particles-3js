"""A composed 20-second excerpt for matched before/after captures (spec §8.3).

This is synthetic music, not a real track: it exists so quiet, attack, crest and
release happen at known times. Real-music assessment stays with a track you choose.

  0.0–4.0 s   rest: a soft A-minor pad, no drums
  4.0 s       attack: one kick + noise crash
  4.0–8.0 s   kick on every beat (120 BPM) + pad
  8.0–14.0 s  crest: kick, snare on 2 and 4, eighth hats, sixteenth hats from 11 s,
              bass line, brighter pad
  14.0–17.0 s release: drums stop, pad swells then decays
  17.0–20.0 s rest

  python phrase_excerpt.py [out.wav]     (44.1 kHz, 16-bit stereo)
"""
import sys, os, wave
import numpy as np

SR = 44100
DUR = 20.0
MOMENTS = {'rest': 2.5, 'attack': 4.45, 'crest': 11.06, 'release': 15.5}

def render():
    n = int(SR * DUR); t = np.arange(n) / SR
    rng = np.random.default_rng(7)
    L = np.zeros(n); R = np.zeros(n)

    def add(sig, start, pan=0.0):
        s0 = int(start * SR); e = min(n, s0 + len(sig))
        if e <= s0: return
        L[s0:e] += sig[:e - s0] * (1 - max(0, pan)); R[s0:e] += sig[:e - s0] * (1 + min(0, pan))

    def env_ad(length, a=0.002, d=0.1):
        tt = np.arange(int(length * SR)) / SR
        return np.minimum(1, tt / a) * np.exp(-tt / d), tt

    def kick(amp=0.9):
        e, tt = env_ad(0.5, 0.001, 0.12)
        f = 48 + 90 * np.exp(-tt * 35)
        return amp * e * np.sin(2 * np.pi * np.cumsum(f) / SR)

    def noise(length, d, amp, hp=False):
        e, tt = env_ad(length, 0.0008, d)
        x = rng.standard_normal(len(tt))
        if hp: x = np.diff(np.concatenate([[0], x]))          # crude high-pass for hats
        return amp * e * x

    # pad: A minor (A3 C4 E4), slow swell; brighter from 8 s, swell and decay over the release
    pad_env = np.interp(t, [0, 1.5, 8, 8.5, 14, 15, 17, 20], [0, 0.10, 0.10, 0.16, 0.16, 0.2, 0.05, 0.02])
    pad = sum(np.sin(2 * np.pi * f * t + i) for i, f in enumerate((220.0, 261.63, 329.63)))
    bright = np.interp(t, [0, 8, 8.5, 14, 17], [0, 0, 1, 1, 0])
    pad += bright * 0.4 * sum(np.sin(2 * np.pi * 2 * f * t) for f in (220.0, 329.63))
    L += pad_env * pad * 0.35; R += pad_env * pad * 0.35

    beat = 0.5
    add(kick(1.0) + noise(1.2, 0.35, 0.25, True)[:int(0.5 * SR)], 4.0)        # the attack
    for k in range(int((14 - 4.5) / beat)):
        tb = 4.5 + k * beat
        add(kick(0.85), tb)
        if tb >= 8 and (k % 2 == 1): add(noise(0.25, 0.06, 0.35), tb, 0.1)    # snare on 2 and 4
    for k in range(int((14 - 8) / (beat / 2))):                              # eighth hats
        add(noise(0.08, 0.012, 0.18, True), 8 + k * beat / 2 + beat / 4, -0.3)
    for k in range(int((14 - 11) / (beat / 4))):                             # sixteenths from 11 s
        add(noise(0.05, 0.008, 0.10, True), 11 + k * beat / 4, 0.3)
    bass_notes = [55.0, 55.0, 65.41, 49.0]                                   # A1 A1 C2 G1, one per bar
    for b in range(int((14 - 8) / (4 * beat))):
        f = bass_notes[b % 4]; e, tt = env_ad(4 * beat, 0.01, 1.2)
        add(0.35 * e * np.sin(2 * np.pi * f * tt), 8 + b * 4 * beat)
    peak = max(np.abs(L).max(), np.abs(R).max())
    return np.stack([L, R], 1) / peak * 0.89

def write(path):
    x = render()
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype('<i2').tobytes())
    return path

if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'captures', 'phrase_excerpt.wav')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    print(write(out))
