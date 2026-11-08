// ─────────────────────────────────────────────────────────────────────────────
//  Library: a place to bring music in and keep it.
//
//  Drop Daydream sketches, stems or any audio file. Files are kept in this
//  browser's IndexedDB (per origin — so always open the study from the same
//  address, e.g. http://127.0.0.1:8080) and are never uploaded. Decoding happens
//  the first time a track is played. Each track can carry a saved scene.
// ─────────────────────────────────────────────────────────────────────────────

const DB = 'living-particles', STORE = 'tracks';

function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no IndexedDB'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const tx = (db, mode, fn) => new Promise((resolve, reject) => {
  const t = db.transaction(STORE, mode), s = t.objectStore(STORE);
  const out = fn(s);
  t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
  t.onerror = () => reject(t.error);
});

const fmt = s => (s == null || !isFinite(s)) ? '—' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export class Library {
  constructor({ list, empty, sources, onSelect, hasScene }) {
    this.list = list; this.empty = empty; this.sources = sources;
    this.onSelect = onSelect; this.hasScene = hasScene;
    this.tracks = [];            // { id, name, type, size, blob, buffer?, duration? }
    this.activeId = null;
    this.remember = true;
    this.db = null;
  }

  async init() {
    try {
      this.db = await openDB();
      const all = await tx(this.db, 'readonly', s => s.getAll());
      (all || []).sort((a, b) => a.added - b.added).forEach(t => this.tracks.push({ ...t }));
    } catch (e) { console.warn('[library] storage unavailable; tracks will last for this visit only', e); }
    this.render();
  }

  async add(files) {
    const audio = [...files].filter(f => f.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|ogg|oga|flac|aif|aiff|webm)$/i.test(f.name));
    let first = null;
    for (const f of audio) {
      const t = { id: uid(), name: f.name.replace(/\.[^.]+$/, ''), type: f.type, size: f.size, blob: f, added: Date.now() };
      this.tracks.push(t);
      first ||= t;
      if (this.remember && this.db) {
        try { await tx(this.db, 'readwrite', s => s.put({ id: t.id, name: t.name, type: t.type, size: t.size, blob: f, added: t.added })); }
        catch (e) { console.warn('[library] could not store', f.name, e); }
      }
    }
    this.render();
    return first;
  }

  async remove(id) {
    const i = this.tracks.findIndex(t => t.id === id);
    if (i < 0) return;
    this.tracks.splice(i, 1);
    if (this.db) { try { await tx(this.db, 'readwrite', s => s.delete(id)); } catch (e) {} }
    if (id === this.activeId) { this.activeId = null; this.onRemovedActive?.(); }
    this.render();
  }

  async select(id) {
    const t = this.tracks.find(x => x.id === id);
    if (!t) return null;
    if (!t.buffer) {
      try { t.buffer = await this.sources.decode(t.blob); t.duration = t.buffer.duration; }
      catch (e) { console.error('[library] could not decode', t.name, e); t.error = true; this.render(); return null; }
    }
    this.activeId = id;
    this.render();
    await this.onSelect(t);
    return t;
  }

  next() {
    if (!this.tracks.length) return null;
    const i = this.tracks.findIndex(t => t.id === this.activeId);
    return this.tracks[(i + 1) % this.tracks.length];
  }

  get active() { return this.tracks.find(t => t.id === this.activeId) || null; }

  render() {
    this.list.textContent = '';
    for (const t of this.tracks) {
      const li = document.createElement('li');
      if (t.id === this.activeId) li.classList.add('active');
      const pick = document.createElement('button');
      pick.type = 'button'; pick.className = 'pick';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = t.name;
      const meta = document.createElement('span'); meta.className = 'meta';
      meta.textContent = t.error ? 'could not decode' : `${fmt(t.duration)} · ${(t.size / 1048576).toFixed(1)} MB`;
      pick.append(name, meta);
      pick.addEventListener('click', () => this.select(t.id));
      const dot = document.createElement('span');
      dot.className = 'scene-dot' + (this.hasScene(t.name) ? ' on' : '');
      dot.title = this.hasScene(t.name) ? 'Has a saved scene' : 'No saved scene';
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'rm'; rm.textContent = '×'; rm.title = `Remove ${t.name}`;
      rm.setAttribute('aria-label', `Remove ${t.name}`);
      rm.addEventListener('click', () => this.remove(t.id));
      li.append(pick, dot, rm);
      this.list.append(li);
    }
    this.empty.hidden = this.tracks.length > 0;
  }
}

export { fmt };
