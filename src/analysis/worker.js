// Analysis worker: runs the precise STFT analysis off the main thread and keeps a small
// cache of results so changing hit settings only re-runs detection, not the transforms.
import { analyzePCM, detectEvents } from './features.js';

const cache = new Map();          // key → features (most recent last)
const MAX = 4;

self.onmessage = e => {
  const m = e.data;
  try {
    if (m.type === 'analyze') {
      let f = cache.get(m.key);
      if (!f) {
        const t0 = performance.now();
        f = analyzePCM(m.channels, m.sampleRate, undefined, p => self.postMessage({ type: 'progress', key: m.key, p }));
        f.meta.analysisMs = performance.now() - t0;
        cache.set(m.key, f);
        while (cache.size > MAX) cache.delete(cache.keys().next().value);
      }
      const events = detectEvents(f, m.detect);
      self.postMessage({ type: 'result', key: m.key, features: f, events });
    } else if (m.type === 'detect') {
      const f = cache.get(m.key);
      if (f) self.postMessage({ type: 'events', key: m.key, events: detectEvents(f, m.detect) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', key: m.key, message: String(err && err.message || err) });
  }
};
