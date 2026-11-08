// The built-in test pattern as real audio: eight voices on their own cycles at 120 BPM,
// rendered to PCM so it goes through the same precise analysis as a track (and you can
// hear it). The second half adds a soft open fifth (220 + 330 Hz) for the harmony test.
//   sub 45 Hz swell, 8 s · kick every beat · low mid 280 Hz, 4 against 3 · mid 650 Hz, 3 against 2
//   clap on 2 and 4 · presence 3.8 kHz, 5 against 4 · hats 7.5 kHz sixteenths · air 13 kHz, 7 against 4
export const PATTERN_SECONDS = 16;
export const PATTERN_VOICES = [
  { name: 'sub', period: 8, swell: true },
  { name: 'kick', period: 0.5, offset: 0 },
  { name: 'low mid', period: 0.375, offset: 0, f: 280, decay: 0.12, amp: 0.30 },
  { name: 'mid', period: 1 / 3, offset: 0.02, f: 650, decay: 0.10, amp: 0.22 },
  { name: 'clap', period: 1, offset: 0.5 },
  { name: 'presence', period: 0.4, offset: 0.05, f: 3800, decay: 0.06, amp: 0.12 },
  { name: 'hats', period: 0.125, offset: 0 },
  { name: 'air', period: 2 / 7, offset: 0.1, f: 13000, decay: 0.03, amp: 0.06 },
];

export function renderPattern(sr, seconds = PATTERN_SECONDS) {
  const n = Math.round(sr * seconds), x = new Float32Array(n);
  let seed = 99;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  const add = (t0, len, fn) => { const s0 = Math.round(t0 * sr); for (let i = 0; i < len * sr && s0 + i < n; i++) x[s0 + i] += fn(i / sr); };
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    x[i] += 0.30 * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 8)) * Math.sin(2 * Math.PI * 45 * t);
    if (t >= seconds / 2) x[i] += 0.05 * Math.min(1, (t - seconds / 2) / 0.5) * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 330 * t));
  }
  for (const v of PATTERN_VOICES) {
    if (v.swell) continue;
    for (let k = 0, t0 = v.offset || 0; t0 < seconds; k++, t0 = (v.offset || 0) + k * v.period) {
      if (v.name === 'kick') {
        let ph = 0;
        add(t0, 0.45, t => { ph += 2 * Math.PI * (48 + 90 * Math.exp(-t * 30)) / sr; return 0.7 * Math.min(1, t / 0.002) * Math.exp(-t / 0.12) * Math.sin(ph); });
      } else if (v.name === 'clap') {
        add(t0, 0.25, t => 0.22 * Math.min(1, t / 0.001) * Math.exp(-t / 0.04) * rnd() * (0.6 + 0.4 * Math.sin(2 * Math.PI * 1700 * t)));
      } else if (v.name === 'hats') {
        const a = k % 4 === 0 ? 0.14 : 0.08;
        add(t0, 0.12, t => a * Math.min(1, t / 0.0005) * Math.exp(-t / 0.02) * (0.5 * rnd() + Math.sin(2 * Math.PI * 7500 * t)));
      } else {
        add(t0, v.decay * 6, t => v.amp * Math.min(1, t / 0.002) * Math.exp(-t / v.decay) * Math.sin(2 * Math.PI * v.f * t));
      }
    }
  }
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  const g = 0.9 / Math.max(peak, 1e-6); for (let i = 0; i < n; i++) x[i] *= g;
  return x;
}
