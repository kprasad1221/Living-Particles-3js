# Shared modules

Small pieces written so another sketch (Audio Geology, the Stellar Tide Court study) can copy them. Each has no three.js import and reads no app state: everything it needs is passed in.

The boundary they sit on: **source → measured features → interpretation → authored score → world**. These modules cover colour and the authored score. Hex layout, camera, materials and control labels stay in the world that owns them.

| Module | Promises | Does not do |
|---|---|---|
| `score.js` | Gesture instances `{ id, kind, parent, n, route, start, travel, rise, crest, release, strength }` on a clock you set by hand (bpm, origin, beats per call). **One call, one answer**: a reply is created with its call, names it in `parent`, takes its strength × gain and starts `delay` later. **Loop clock**: the same time gives the same instances with the same ids after a seek, at any step size, and the whole score repeats every `commonPeriod()` seconds. **Free clock**: phase is integrated; a measured level may bend the rate within ± `rateDepth`; it never jumps. `reset()` drops everything pending; a long gap between steps makes only what can still be alive; `onStart` fires once per instance and never for instances filled in after a reset. `weighted(amount, share, level)` keeps the music's influence inside a bound. `envelope(τ, rise, crest, release)` is the local shape at one place on a route. | Know any geometry (a world maps `route` to its own path and evaluates the envelope along it), measure tempo or beats, or read audio. |
| `palette.js` | A palette is plain JSON (`schema`, `id`, `version`, `source`, `inputColorSpace: 'srgb'`, `ramps`). Stops keep their `id` and their order. `bakeStops` interpolates the sRGB-encoded stop colours and returns **linear** rgb; `toSRGB8` re-encodes for an 8-bit sRGB texture that the GPU decodes once. `sanitizePalette` repairs stops and refuses a newer schema or a non-sRGB file with a message. | Decide what a ramp position means, make textures, or choose colours. |

## Copying one into another repo

1. Copy the file as is and keep its header.
2. Note the commit it came from in the new repo (the header has a line for it) and anything you change.
3. Bring its test (`tools/palette.test.mjs`, `tools/score.test.mjs`) or the checks that apply. The last two score checks are about this world's routes; replace them with the new world's.
4. Write the adapter in the new world: what feeds the ramp position and which roles it uses; which routes the score's `route` numbers mean, what a call and a reply look like there, and which measured level (if any) may weigh on them. `src/world/gestures.js` is this world's adapter and a model for the next: about a hundred lines, all geometry.

## What a world has to do to use the score

```js
import { Score, SCORE_DEFAULTS } from './shared/score.js';
const params = structuredClone(SCORE_DEFAULTS);      // keep these in the world's saved scene
const score = new Score(params);

// on seek, restart or a new source
score.reset();
// once per analysis step (time in seconds, increasing), with the measured level that may add weight
score.advance(t, level, started => { /* one-shot things: a plume, a sound, a log line */ });
// every frame, for every live instance: where is its route here, and how lit is each place on it?
for (const g of score.instances) drawAlong(myRoutes[g.route], u => envelope(now - (g.start + u * g.travel), g.rise, g.crest, g.release) * g.strength);
const swell = score.foundation(now, bassLevel);      // 0 … foundation.amount
```

Nothing here is a package yet. That comes after a second world has used a module and shown what it needs.
