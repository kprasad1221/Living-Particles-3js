// Radix-2 complex FFT, in place, with cached tables per size. Pure JS: runs in the page,
// in the analysis worker and in Node (tools/fixtures.mjs).

const plans = new Map();

function plan(n) {
  let p = plans.get(n);
  if (p) return p;
  if (n & (n - 1)) throw new Error('FFT size must be a power of two');
  const bits = Math.log2(n), rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  p = { n, rev, cos, sin };
  plans.set(n, p);
  return p;
}

// Forward transform of (re, im), both Float64Array(n), in place.
export function fft(re, im) {
  const n = re.length, { rev, cos, sin } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const a = start + k, b = a + half;
        const tr = re[b] * cos[t] - im[b] * sin[t], ti = re[b] * sin[t] + im[b] * cos[t];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

// Periodic Hann window: w[n] = 0.5 − 0.5·cos(2πn/N). Σw² = 3N/8.
const windows = new Map();
export function hann(n) {
  let w = windows.get(n);
  if (!w) { w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); windows.set(n, w); }
  return w;
}
