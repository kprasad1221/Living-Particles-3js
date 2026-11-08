// ─────────────────────────────────────────────────────────────────────────────
//  Parameters: the blackboard.
//
//  In VFX Graph these would be the exposed properties on the Blackboard; in
//  TouchDesigner, the custom parameters on the container. Everything a scene can
//  save lives in P. The groups follow VFX Graph's contexts, because that is the
//  vocabulary this study is translating from:
//
//    spawn   what exists: capacity and arrangement           (Spawn + capacity · Grid SOP)
//    init    what each tile is born with                       (Initialize Particle · per-point attribs)
//    update  how tiles answer the music, every frame           (Update Particle · CHOP → SOP)
//    look    how it is drawn: colour, glow, sky, bloom         (Output Particle · MAT + post TOPs)
//
//  Per-tile values (voice, threshold, seed) are attributes, not parameters: they
//  are written once into instanced buffers when the field is built.
// ─────────────────────────────────────────────────────────────────────────────

export const VERSION = 'study-01/0.2.0';

export const SIM_HZ = 60;          // fixed simulation clock (analysis + history), as in Audio Geology
export const NB = 8;               // voices
export const HIST = 512;           // voice history rows: 512 / 60 Hz = 8.5 s of memory
export const BINS = 512;           // analyser bins (fftSize 1024)
export const FFT_SIZE = 1024;
export const LOW_FFT_SIZE = 4096;  // second analysis for the four low voices (11.7 Hz bins at 48 kHz)
export const SQ3 = Math.sqrt(3);

// Band edges in Hz — identical to Audio Geology 02.2, so a track reads the same in both studies.
export const BAND_EDGES = [30, 60, 150, 400, 1000, 2500, 5000, 10000, 16000];
export const VOICE_NAMES = ['sub', 'bass', 'low mid', 'mid', 'upper mid', 'presence', 'brilliance', 'air'];

// Timing convention for every rise/fall shown in the interface: milliseconds to cover 90 %
// of a step (rise) or to decay by 90 % (fall). One-pole coefficient per update of dt seconds:
//   c = 1 − exp(−ln(10) · dt / t90)      (t90 = half-life × log2(10) ≈ 3.32 × half-life)
export const t90coef = (ms, dt) => ms <= 0 ? 1 : 1 - Math.exp(-Math.LN10 * dt / (ms / 1000));
export const GLOBAL = 8;           // history column 8 holds the global (whole-spectrum) level

export const P = {
  // FLOOR — what exists. Field size, layout and seed rebuild the tiles; the rest do not.
  floor: {
    rings: 52,             // field radius in hex rings, cut to a disc (52 → 7,471 tiles)
    pattern: 'rings',      // rings | sectors | spiral | scatter — how voices are laid on the floor
    ringWidth: 2.5,        // width of one voice band, in tiles
    order: 'low-in',       // low-in: bass at the centre · high-in: air at the centre
    scatter: 0.18,         // share of tiles given a random voice instead
    active: 0.7,           // share of tiles eligible to respond; the rest stay pure grid
    seed: 7,
    variation: 0.7,        // activation variation: 0 = a voice's tiles respond together, 1 = spread through the population
    gap: 0.06,             // empty margin around each tile, fraction of the cell
    rest: 0.14,            // resting height, scene units
    jitter: 0.06,          // random extra resting height
  },

  // MOVEMENT — how far and how the floor moves.
  movement: {
    lift: 1.8,             // maximum lift: extra height at full activation, scene units
    curve: 1.4,            // activation → height (1 linear, >1 snappier)
    floor: 0.22,           // activation threshold: below this a tile is at rest
    ceil: 0.92,            // … at or above this it is fully active
    ripple: 'outward',     // instant | outward
    travel: 22,            // outward ripple speed, scene units/s (edge arrival = radius / travel)
    swell: 0.5,            // sub lifts the floor in broad, slow folds
  },

  // MUSIC — how sound becomes control signals. Measurement → gate → level (dB) → normalised.
  music: {
    normalize: 'preserve', // preserve: fixed reference, quiet stays quiet · adaptive: bounded slow reference
    gain: 0,               // input gain, dB
    noiseFloor: -60,       // gate closes below this (dB re full-scale sine)
    gateHyst: 6,           // gate opens this many dB above the floor
    gateOpen: 10,          // ms to 90 % open
    gateClose: 150,        // ms to 90 % closed
    reference: -6,         // the level that reads as full scale, dB
    tilt: 2.5,             // dB per octave added above 500 Hz (music usually falls with frequency)
    curve: 1.6,            // transfer curve exponent, dB-normalised → output
    adapt: 0.5,            // adaptive mode only: how much of the ±12 dB adaptation applies
    hitSensitivity: 5,     // 0–10, higher triggers more easily
    cooldownLow: 80,       // ms before a low voice (sub … mid) can trigger again
    cooldownHigh: 40,      // ms for the high voices
    syncOffset: 0,         // ms, visual delay added after output latency (device-specific alignment)
  },

  // MAPPINGS — musical source → visual destination, each with its own sensitivity and timing.
  map: {
    lift:   { sensitivity: 1, curve: 1, rise: 40, fall: 797, fallHigh: 199, amount: 1 },  // each tile's own voice
    rim:    { source: 1, sensitivity: 1, curve: 1, rise: 40, fall: 600, amount: 1 },      // source: voice 0–7 or 8 = global
    hits:   { rise: 0, hold: 0, fall: 332, amount: 1 },                                   // event envelope (accent + flash)
    colour: { source: 0, sensitivity: 1, curve: 1, rise: 1500, fall: 4000, amount: 0 },   // slow hue migration toward the next voice colour
  },

  // POINTER — the Living Particles affector: tiles answer the distance to a point you move.
  pointer: {
    on: true,
    mode: 'pointer',       // pointer | orbit (a slow path, for when your hands are elsewhere)
    radius: 9,
    lift: 1.8,             // may be negative: presses tiles down, never through the floor
    glow: 0.9,
    tint: 0.6,
    color: '#ffffff',
    speed: 0.25,           // orbit mode only
  },

  // SPARKS — a second particle system with real lifetimes.
  sparks: {
    on: true,
    from: 'highs',         // highs (presence, brilliance, air) | mids+highs | all
    perHit: 40,            // particles per hit event (a finite budget, spread over the ripple)
    continuous: 0,         // particles per second per voice at full level
    speed: 5.5,            // launch speed, units/s
    cone: 35,              // launch cone half-angle from vertical, degrees
    life: 1.3,             // lifetime, s
    gravity: -4,
    turbulence: 1.1,
    turbScale: 1.0,
    size: 0.32,
    bright: 1.4,
  },

  // PLUME — one authored gesture per hit on a chosen voice: emerge, rise, curl, disperse, rest.
  // Starting timings (at length 1.6 s): 0–80 ms emerge · 80–250 ms rise · 250–900 ms curl · 900–1600 ms fade.
  plume: {
    on: false,
    voice: 1,              // which voice's hits launch a plume (1 = bass)
    area: 14,              // launch from a tile of that voice within this radius of the centre (scene units);
                           // while the pointer is on the floor, from the tile nearest the pointer
    perHit: 160,           // particles per plume (× hit strength, within 0.6–1)
    maxConcurrent: 4,      // plumes alive at once; a hit beyond this is dropped and counted
    length: 1.6,           // whole gesture, s
    height: 10,            // rise, scene units (× 0.7–1 with hit strength)
    curl: 1.1,             // turns around the plume axis during the curl phase
    spread: 3.2,           // radius reached by the end, scene units
    drift: 1.5,            // sideways travel over the gesture, scene units
    trail: 3,              // ghost copies following each particle (0 = none)
    trailGap: 40,          // ms between ghosts
    size: 0.5,             // particle size, scene units (independent of spark size)
  },

  // PERFORMANCE MACROS — each scales exactly one thing, nothing else.
  macros: {
    movement: 1,           // × maximum lift
    sparks: 1,             // × particles per hit and continuous emission
    glow: 1,               // × glow amount (bloom strength)
  },

  // OUTPUT — Look A and Look B are full copies of a look; what you see is mix(A, B, morph).
  looks: { a: 'av2p', b: 'av2', morph: 0, drive: 'hand', edit: 'a', preview: 'mix' },   // drive: hand | lfo | v0…v7

  camera: { drift: false, driftSpeed: 0.25, fov: 55 },
  render: { scale: 1, toneMapping: 'neutral' },

  // ── Transient: never saved in a scene ──────────────────────────────────────
  diag: { view: 'normal' },                    // normal | nobloom | bloom | emission | surface
  manual: { on: false, voice: 1, level: 0.8 }, // a known level and single hits, injected after the detector
  solo: { dest: 'none' },                      // none | lift | rim | hits | colour | sparks
  inspect: { dest: 'lift', voice: 1 },         // which mapping the meters show
};

// The shape of a look lives in looks.js (LOOK_KEYS).
