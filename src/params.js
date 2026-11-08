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

export const P = {
  // SPAWN — capacity and arrangement. Changing these rebuilds the field.
  spawn: {
    rings: 52,             // field radius in hex rings, cut to a disc (52 → about 7,400 tiles)
    pattern: 'rings',      // rings | sectors | spiral | scatter — how voices are laid on the floor
    ringWidth: 2.5,        // width of one voice band, in tiles
    order: 'low-in',       // low-in: bass at the centre · high-in: air at the centre
    scatter: 0.18,         // share of tiles given a random voice instead (the scattered pops)
    density: 0.7,          // share of tiles that answer at all; the rest stay pure grid
    seed: 7,
  },

  // INITIALIZE — what every tile is born with.
  init: {
    spread: 0.7,           // threshold spread: 0 = a band's tiles move as one · 1 = they pop one by one as it gets louder
    gap: 0.06,             // empty margin around each tile, fraction of the cell
    base: 0.14,            // resting height
    jitter: 0.06,          // random extra resting height
  },

  // UPDATE — how the floor answers the voices.
  update: {
    travel: 22,            // how fast the music travels outward from the centre, units/s (0 = everywhere at once)
    extrude: 1.8,          // column height at full activation
    shape: 1.4,            // activation → height curve (1 linear, >1 snappier)
    floor: 0.22,           // presence curve: smoothstep(floor, ceil, level)
    ceil: 0.92,
    pulseVoice: 1,         // the voice the whole grid's rim breathes with (1 = bass)
    swell: 0.5,            // sub voice lifts the floor in broad, slow folds
  },

  // Voice analysis (the Signal side). Same model as Audio Geology 02.2.
  voices: {
    attack: 0.012,         // envelope attack half-life, s
    releaseLow: 0.24,      // release half-life of sub, s
    releaseHigh: 0.06,     // … of air (log-interpolated in between)
    onset: 1.8,            // onset when the rise beats this × the band's recent average rise
  },

  // The affector — the Living Particles idea: tiles answer the distance to a point you move.
  affector: {
    on: true,
    mode: 'pointer',       // pointer | orbit (a slow path, for when your hands are elsewhere)
    radius: 9,
    lift: 1.8,
    glow: 0.9,
    tint: 0.6,
    color: '#ffffff',
    speed: 0.25,           // orbit mode only
  },

  // Sparks — a second particle system with real lifetimes (Spawn → Initialize → Update → Output).
  sparks: {
    on: true,
    from: 'highs',         // highs (presence, brilliance, air) | mids+highs | all
    burst: 0.5,            // chance a flashing tile throws sparks on a given step
    shimmer: 0.0,          // steady emission from loud tiles, sparks/s per voice at full level
    speed: 5.5,
    life: 1.3,
    gravity: -4,
    turbulence: 1.1,
    size: 0.32,
    bright: 1.4,
  },

  // OUTPUT — Look A and Look B are full copies of this shape; what you see is mix(A, B, morph).
  looks: { a: 'av2p', b: 'av2', morph: 0, drive: 'hand', edit: 'a' },   // drive: hand | lfo | v0…v7

  camera: { drift: false, driftSpeed: 0.25, fov: 55 },
  render: { scale: 1, toneMapping: 'neutral' },

  // ── Transient: never saved in a scene ──────────────────────────────────────
  // Diagnostic view: normal | nobloom | bloom (bloom contribution only) | emission | surface
  diag: { view: 'normal' },
  // Manual test: inject a known level and single hits after the detector, so shader
  // behaviour can be checked separately from audio detection.
  manual: { on: false, voice: 1, level: 0.8 },
};

// The shape of a look lives in looks.js (LOOK_KEYS).
