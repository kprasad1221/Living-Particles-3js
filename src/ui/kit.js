// ─────────────────────────────────────────────────────────────────────────────
//  A small control kit (plain DOM). Every continuous control has:
//    a slider (linear or logarithmic) · an editable number in real units · keyboard
//    steps (arrows; Shift ×10) · a per-control reset to its default · a one-line tooltip
//  and can show why it currently has no effect.
//
//  Units: ms (accepts "1.2 s") · s · dB · Hz (accepts "2.5k") · % (stored 0..1) ·
//         u (scene units) · u/s · ° · × · /s · "" (plain)
// ─────────────────────────────────────────────────────────────────────────────

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dp = (step) => { const s = String(step); return s.includes('.') ? s.split('.')[1].length : 0; };

export function formatValue(v, unit, decimals = 2) {
  if (!Number.isFinite(v)) return '—';
  switch (unit) {
    case 'ms': return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(0)} ms`;
    case 's': return `${v.toFixed(2)} s`;
    case 'dB': return `${v.toFixed(1)} dB`;
    case 'Hz': return v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${v.toFixed(0)} Hz`;
    case '%': return `${(v * 100).toFixed(0)} %`;
    case '°': return `${v.toFixed(0)}°`;
    case '×': return `${v.toFixed(2)}×`;
    case '': return v.toFixed(decimals);
    default: return `${v.toFixed(decimals)} ${unit}`;
  }
}
export function parseValue(text, unit) {
  const t = String(text).trim().toLowerCase().replace(',', '.');
  const m = t.match(/^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*([a-z%°×/]*)?/);
  if (!m) return NaN;
  let v = parseFloat(m[1]); const suf = m[2] || '';
  if (unit === 'ms' && (suf === 's' || suf === 'sec')) v *= 1000;
  if (unit === 'Hz' && (suf === 'k' || suf === 'khz')) v *= 1000;
  if (unit === '%') v /= 100;
  return v;
}

export class Kit {
  constructor(onChange) {
    this.onChange = onChange || (() => {});
    this.controls = []; this.readouts = [];
  }

  folder(parent, title, { open = false, note = '', onReset = null, cls = '' } = {}) {
    const d = el('details', 'k-folder ' + cls); d.open = open;
    const s = el('summary', 'k-summary'); s.append(el('span', 'k-title', title));
    if (onReset) {
      const r = el('button', 'k-greset', 'reset'); r.type = 'button'; r.title = `Reset ${title} to defaults (tracks and presets are not touched)`;
      r.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onReset(); });
      s.append(r);
    }
    d.append(s);
    const body = el('div', 'k-body'); d.append(body);
    if (note) body.append(el('p', 'k-note', note));
    parent.append(d);
    return body;
  }
  sub(parent, title, opts = {}) { return this.folder(parent, title, { ...opts, cls: 'k-sub' }); }

  _row(parent, label, tip) {
    const row = el('div', 'k-row'); const l = el('label', 'k-label', label);
    if (tip) { l.title = tip; row.title = tip; }
    row.append(l); parent.append(row);
    const why = el('div', 'k-why'); why.hidden = true;
    parent.append(why);
    return { row, label: l, why };
  }
  _register(c) {
    c.setInactive = reason => {
      c.row.classList.toggle('inactive', !!reason);
      c.why.hidden = !reason; c.why.textContent = reason ? `No effect now: ${reason}` : '';
    };
    this.controls.push(c);
    return c;
  }

  // Continuous value. opts: label, min, max, step, unit, log, tip, def, decimals, onChange
  slider(parent, obj, key, o) {
    const { row, label, why } = this._row(parent, o.label, o.tip);
    const range = el('input', 'k-range'); range.type = 'range';
    const num = el('input', 'k-num'); num.type = 'text'; num.inputMode = 'decimal'; num.spellcheck = false;
    const reset = el('button', 'k-reset', '↺'); reset.type = 'button'; reset.title = 'Reset to default';
    reset.setAttribute('aria-label', `Reset ${o.label}`);
    range.setAttribute('aria-label', o.label); num.setAttribute('aria-label', `${o.label} value`);
    row.append(range, num, reset);
    const lo = o.min, hi = o.max, log = !!o.log, step = o.step ?? (hi - lo) / 100, dec = o.decimals ?? dp(step);
    const def = o.def ?? obj[key];
    const N = 1000;
    if (log) { range.min = 0; range.max = N; range.step = 1; } else { range.min = lo; range.max = hi; range.step = step; }
    const toRange = v => log ? Math.round(N * Math.log(clamp(v, lo, hi) / lo) / Math.log(hi / lo)) : v;
    const fromRange = r => log ? lo * Math.pow(hi / lo, r / N) : r;
    const snap = v => log ? v : Math.round(v / step) * step;
    const set = (v, commit = true) => {
      if (!Number.isFinite(v)) { c.refresh(); return; }
      v = clamp(snap(v), lo, hi);
      obj[key] = +v.toFixed(Math.max(dec, log ? 3 : dec));
      c.refresh(); o.onChange?.(obj[key], commit); this.onChange(key, commit);
    };
    const c = { row, why, label, refresh() { if (document.activeElement !== num) num.value = formatValue(obj[key], o.unit ?? '', dec); range.value = toRange(obj[key]); } };
    range.addEventListener('input', () => set(fromRange(+range.value), false));
    range.addEventListener('change', () => set(fromRange(+range.value), true));
    num.addEventListener('change', () => set(parseValue(num.value, o.unit ?? '')));
    num.addEventListener('blur', () => c.refresh());
    num.addEventListener('keydown', e => {
      if (e.key === 'Enter') { num.blur(); return; }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 1 : -1, mul = e.shiftKey ? 10 : 1;
      set(log ? obj[key] * Math.pow(hi / lo, (dir * mul) / 100) : obj[key] + dir * step * mul);
      num.value = formatValue(obj[key], o.unit ?? '', dec);
    });
    reset.addEventListener('click', () => set(def));
    label.addEventListener('dblclick', () => set(def));
    c.refresh();
    return this._register(c);
  }

  select(parent, obj, key, o) {
    const { row, label, why } = this._row(parent, o.label, o.tip);
    const s = el('select', 'k-select'); s.setAttribute('aria-label', o.label);
    const opts = () => (typeof o.options === 'function' ? o.options() : o.options);
    const fill = () => { s.textContent = ''; for (const [lab, val] of opts()) { const op = el('option', null, lab); op.value = JSON.stringify(val); s.append(op); } };
    fill();
    const def = o.def ?? obj[key];
    const reset = el('button', 'k-reset', '↺'); reset.type = 'button'; reset.title = 'Reset to default';
    row.append(s, reset);
    const c = { row, why, label, refresh() { s.value = JSON.stringify(obj[key]); }, rebuild() { fill(); this.refresh(); } };
    const set = v => { obj[key] = v; c.refresh(); o.onChange?.(v, true); this.onChange(key, true); };
    s.addEventListener('change', () => set(JSON.parse(s.value)));
    reset.addEventListener('click', () => set(def));
    label.addEventListener('dblclick', () => set(def));
    c.refresh();
    return this._register(c);
  }

  segmented(parent, obj, key, o) {
    const { row, label, why } = this._row(parent, o.label, o.tip);
    const g = el('div', 'k-seg'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', o.label);
    const btns = o.options.map(([lab, val]) => { const b = el('button', null, lab); b.type = 'button'; b.addEventListener('click', () => set(val)); g.append(b); return [b, val]; });
    row.append(g);
    const c = { row, why, label, refresh() { for (const [b, v] of btns) b.setAttribute('aria-pressed', String(obj[key] === v)); } };
    const set = v => { obj[key] = v; c.refresh(); o.onChange?.(v, true); this.onChange(key, true); };
    c.refresh();
    return this._register(c);
  }

  toggle(parent, obj, key, o) {
    const { row, label, why } = this._row(parent, o.label, o.tip);
    const t = el('input', 'k-check'); t.type = 'checkbox'; t.setAttribute('aria-label', o.label);
    row.append(t);
    const c = { row, why, label, refresh() { t.checked = !!obj[key]; } };
    t.addEventListener('change', () => { obj[key] = t.checked; o.onChange?.(t.checked, true); this.onChange(key, true); });
    c.refresh();
    return this._register(c);
  }

  color(parent, obj, key, o) {
    const { row, label, why } = this._row(parent, o.label, o.tip);
    const i = el('input', 'k-color'); i.type = 'color'; i.setAttribute('aria-label', o.label);
    const hex = el('input', 'k-num'); hex.type = 'text'; hex.spellcheck = false; hex.setAttribute('aria-label', `${o.label} hex`);
    const def = o.def ?? obj[key];
    const reset = el('button', 'k-reset', '↺'); reset.type = 'button'; reset.title = 'Reset to default';
    row.append(i, hex, reset);
    const c = { row, why, label, refresh() { i.value = obj[key]; if (document.activeElement !== hex) hex.value = obj[key]; } };
    const set = (v, commit = true) => { if (!/^#[0-9a-f]{6}$/i.test(v)) { c.refresh(); return; } obj[key] = v.toLowerCase(); c.refresh(); o.onChange?.(v, commit); this.onChange(key, commit); };
    i.addEventListener('input', () => set(i.value, false));
    i.addEventListener('change', () => set(i.value, true));
    hex.addEventListener('change', () => set(hex.value.startsWith('#') ? hex.value : '#' + hex.value));
    reset.addEventListener('click', () => set(def));
    c.refresh();
    return this._register(c);
  }

  text(parent, obj, key, o) {
    const { row, label, why } = this._row(parent, o.label, o.tip);
    const i = el('input', 'k-text'); i.type = 'text'; i.setAttribute('aria-label', o.label);
    row.append(i);
    const c = { row, why, label, refresh() { if (document.activeElement !== i) i.value = obj[key]; } };
    i.addEventListener('change', () => { obj[key] = i.value; this.onChange(key, true); });
    c.refresh();
    return this._register(c);
  }

  button(parent, title, onClick, { tip = '', cls = '' } = {}) {
    const b = el('button', 'k-button ' + cls, title); b.type = 'button'; if (tip) b.title = tip;
    b.addEventListener('click', onClick); parent.append(b);
    return b;
  }

  readout(parent, label, fn, { tip = '' } = {}) {
    const row = el('div', 'k-row k-readout'); const l = el('span', 'k-label', label), v = el('span', 'k-value');
    if (tip) row.title = tip;
    row.append(l, v); parent.append(row);
    const r = { tick() { v.textContent = fn(); } }; r.tick();
    this.readouts.push(r);
    return r;
  }

  status(parent, fn) {
    const p = el('p', 'k-status'); parent.append(p);
    const r = { tick() { const s = fn(); p.textContent = s || ''; p.hidden = !s; } }; r.tick();
    this.readouts.push(r);
    return r;
  }

  tabs(parent, titles, onSelect, initial = 0) {
    const bar = el('div', 'k-tabs'); bar.setAttribute('role', 'tablist');
    const pages = titles.map(() => el('div', 'k-page'));
    const btns = titles.map((t, i) => {
      const b = el('button', 'k-tab', t); b.type = 'button'; b.setAttribute('role', 'tab');
      b.addEventListener('click', () => select(i)); bar.append(b); return b;
    });
    const select = i => {
      btns.forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
      pages.forEach((p, j) => { p.hidden = i !== j; });
      onSelect?.(i);
    };
    parent.append(bar, ...pages);
    select(initial);
    return { pages, select };
  }

  refresh() { for (const c of this.controls) c.refresh(); }
  tick() { for (const r of this.readouts) r.tick(); }
}
