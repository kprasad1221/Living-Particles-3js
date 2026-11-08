# Living Particles 3JS

Particle studies for the browser, translated from Unity VFX Graph and TouchDesigner.

**Study 01 · Hex Field** rebuilds a Unity test from a few years ago: a floor of hex particles from SineVFX's [Living Particles](https://assetstore.unity.com/packages/vfx/particles/spells/living-particles-105817) pack, driven by an FFT script so each part of the floor answers its own frequency band (inspired by *Tetris Effect*). Here it is one instanced draw call of about 7,400 hex prisms, a second spark system with real lifetimes, two editable looks you can morph between, and a music library for bringing in Daydream sketches and stems.

![AV2 · Tropical, standing view](docs/study-01/01_av2_tropical_stand.jpg)

| Unity capture (AV3 · Funk) | This study (AV3 · Funk) |
|---|---|
| ![](docs/study-01/00_reference_unity_av3.jpg) | ![](docs/study-01/02_av3_funk_stand.jpg) |

## Run it

ES modules and the microphone need a local server:

```
npx http-server . -c-1
```

Then open http://127.0.0.1:8080. Use the same address every time: the music library lives in that origin's browser storage.

No build step. three.js 0.186.0 and Tweakpane 4.0.5 load from jsDelivr through the import map in `index.html`, the same versions as Audio Geology 3JS.

## Using it

- **Music** (L): Test signal, Track, or Mic. Drop audio files anywhere on the page or click the drop zone. Tracks stay in this browser (IndexedDB) until you remove them; nothing is uploaded. **Save scene to this track** stores every control, both looks and the camera with that track's name; with **Recall** on, the scene comes back when the track starts.
- **Controls** (P): folders follow VFX Graph's contexts (see below). Look A and Look B are each fully editable in their own tab; **morph** mixes them, by hand, with a 16 s LFO, or following one voice's level.
- **Floor**: move the pointer over it. That is the affector (the hands in the Unity capture).
- **Camera**: drag to orbit, scroll to zoom. **1** Stand (eye height, looking out), **2** Survey (from above, where the rings read as a mandala), **3** Low.
- **Space** play/pause · **R** restart · **H** perform mode (hides the interface).
- The working scene autosaves to this browser. **Camera · render · scenes** has Export / Import JSON and Reset.

## How it's built: Unity ↔ TouchDesigner ↔ here

| Idea | Unity (VFX Graph / Shuriken) | TouchDesigner | Here |
|---|---|---|---|
| Audio in | `AudioSource` + `GetSpectrumData` | Audio File In / Device In → Audio Spectrum CHOP | Web Audio `AnalyserNode`, 1024 and 4096 points (`src/audio.js`) |
| Bins → 8 bands | `AudioBands.cs`, 512 → 8 widening windows | Audio Spectrum → Resample / Analyze CHOP | `cookBands()`: band = mean of bins between edges (`src/bands.js`) |
| Smoothing | attack/release `Lerp` | Lag / Filter CHOP | envelope half-lives, per band |
| Normalising | running peak (only grows) | Limit / Math CHOP range | slow peak **and** floor per band, so quiet hats and loud kicks both use 0..1 |
| Hits | — | Trigger CHOP | onset pulse when the rise beats 1.8× the recent average |
| Memory | (would need a custom buffer) | Trail CHOP / Cache TOP | 8 × 512 float texture, newest row first: 8.5 s at 60 Hz |
| Exposed properties | Blackboard, *Exposed*, `SetFloat` | custom parameters | `P` in `src/params.js` → shader uniforms |
| Per-particle attributes | attributes written in Initialize | point attributes | `InstancedBufferAttribute`s `aTile`, `aSeed` |
| **Spawn** (capacity, arrangement) | Spawn context, capacity | Grid SOP / Copy SOP | `buildLayout()`: axial hex grid cut to a disc |
| **Initialize** | Initialize Particle | Point SOP | threshold, voice, seed per tile, written once |
| **Update**, stateless | Update Particle blocks | CHOP → instancing | vertex shader: reads history at the tile's delay → height, glow, flash |
| **Update**, stateful | Update with stored attributes | Feedback TOP on a position texture | not yet. Sparks evaluate motion in closed form from age instead |
| GPU events | GPU Event → spawn | Trigger → Particle SOP birth | onset flash on a tile → spark burst (`src/world/sparks.js`) |
| **Output** | Output Particle Mesh + Shader Graph | MAT + Render TOP | `ShaderMaterial` (rim, fill, sides, grain, fog); additive point sprites |
| Affector | Living Particles affector object | distance in a Point SOP / GLSL | pointer → ray → floor plane → `uAff` uniform |
| Bloom, tone map | post-processing volume | Bloom TOP, Level TOP | `UnrealBloomPass` → `OutputPass` (Neutral, ACES, AgX) |

The floor keeps no per-tile state between frames: everything a tile "remembers" comes from the shared history texture. That is why ten thousand tiles cost almost nothing to update, and why the next study that needs real per-particle motion (plumes, flocking, the Tetris Effect dust) will move to GPGPU ping-pong textures.

## Signal → Voices → Floor

```
SIGNAL   source → 1024-pt FFT (high voices) + 4096-pt FFT (low voices)
VOICES   8 bands → adaptive range → envelope → onset · 60 Hz fixed clock
MEMORY   one row per step into an 8 × 512 texture (row 0 = now)
FLOOR    tile at distance d reads the row d / travel seconds old → rings travel outward
SPARKS   tiles whose delayed onset is flashing throw sparks; motion = p0 + v·age + ½g·age² + turbulence
LOOK     mix(Look A, Look B, morph) → rim · fill · sides · sky · fog · bloom
```

### Voices

Same bands and analysis as Audio Geology 3JS 02.2, so a track reads the same in both studies.

| Voice | Hz | FFT | Release half-life |
|---|---|---|---|
| sub | 30–60 | 4096 | 0.24 s |
| bass | 60–150 | 4096 | 0.20 s |
| low mid | 150–400 | 4096 | 0.16 s |
| mid | 400–1k | 4096 | 0.13 s |
| upper mid | 1–2.5k | 1024 | 0.11 s |
| presence | 2.5–5k | 1024 | 0.09 s |
| brilliance | 5–10k | 1024 | 0.07 s |
| air | 10–16k | 1024 | 0.06 s |

Attack half-life 12 ms for all. Range: peak falls with a 3 s half-life, floor rises with 8 s; `norm = ((raw − floor) / max(peak − floor, 0.04))^1.35`.

### Exact mappings (per tile, in the vertex shader)

| Stage | Mapping |
|---|---|
| Delay | `row = d / travel × 60` (two rows interpolated) |
| Presence | `smoothstep(floor 0.22, ceil 0.92, level)` |
| Threshold spread | `thr = seed × spread × 0.9`; `act = smoothstep(thr, thr + mix(1, 0.12, spread), presence) × live` |
| Density | a tile is *live* with probability `density`; dead tiles stay pure grid |
| Height | `base + jitter × seed + extrude × act^shape + swell × sub × fold(x, z, t) + affector × lift` |
| Rim | `rimGlow × (0.55 + 0.45 × rimPulse × pulseVoice) + 0.45 × act × fillGlow + onset × flash` |
| Fill | voice colour × act × fillGlow, from the rim inward (`fill: edge → solid` makes it solid) |
| Sides | voice colour × act × sideGlow × `y^mix(9, 2.6, act)`, plus a lit top line and optional corner lines |
| Affector | `on × (1 − smoothstep(0, radius, distance))²` → lift, glow floor, tint |
| Fog | by ground distance from the viewer, starting 24 units out: `1 − exp(−((dist − 24) × fog)^1.5)` |

### Looks

| Look | From |
|---|---|
| AV1 · Violet | Unity capture, AudioVisualizer object AV1: magenta/purple rims, outline-only |
| AV2 · Tropical | AV2: red rim floor; blue, cyan, yellow and orange columns |
| AV3 · Funk | AV3: warm-white rims on dark stone, solid red columns with lit edges |
| Nocturne | new: a night version leaning toward *Tetris Effect*'s dark stages |

The AV looks keep the pale Unity daylight sky from the capture. Emission is HDR (lit rims run at roughly 1.5–2.5 before tone mapping) and bloom thresholds sit near 0.85, so the sky does not bloom and only the light does.

## Checks

`tools/` holds headless checks (Python + Playwright, software WebGL, a fake clock), adapted from Audio Geology 3JS:

```
cd tools
npm install                        # local three / tweakpane for the import map
python capture.py check            # timing invariance, onsets, counts, scene round trip, rebuild
python capture.py                  # fixed-excerpt captures of each look
python capture.py ui               # interface at 1440, 820 and 390 px
```

Every capture: Restart, 300 steps (5 s) of the built-in polyrhythm test signal, then render with the world paused. SwiftShader frame times say nothing about a real GPU.

## Built with

- [three.js](https://threejs.org) 0.186.0
- [Tweakpane](https://tweakpane.github.io/docs/) 4.0.5

## License

MIT. See [LICENSE](LICENSE).

---

Part of [Pixel Rhythms Labs](https://github.com/kprasad1221). Sibling study: [Audio Geology 3JS](https://github.com/kprasad1221/audio-geology-3js).
