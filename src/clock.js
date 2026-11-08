// ─────────────────────────────────────────────────────────────────────────────
//  Fixed-step simulation clock (from Audio Geology 3JS, unchanged).
//
//  Web study 01 cooked the field once per display frame, so on a 120 Hz screen the
//  terrain evolved twice as fast (and its history window was half as long) as on a
//  60 Hz screen. Here the field steps at a fixed 60 Hz whatever the display does.
//
//  Overload policy: at most MAX_STEPS steps per display frame. If a frame arrives
//  later than that, the extra steps are dropped (counted in `dropped`), not queued:
//  the world briefly runs slower than real time instead of bursting to catch up.
//  Frame gaps longer than MAX_FRAME_DT (a hidden tab, a debugger pause) are clamped.
//  A fixed timestep cannot recover audio spectra that were never analysed between
//  two slow frames; successive steps in one frame read the same analyser snapshot.
// ─────────────────────────────────────────────────────────────────────────────
import { SIM_HZ } from './params.js';

export const SIM_DT = 1 / SIM_HZ;
export const MAX_STEPS = 4;
export const MAX_FRAME_DT = 0.1;

export class FixedClock {
  constructor() { this.acc = 0; this.steps = 0; this.dropped = 0; }

  // Returns how many simulation steps to run for a display frame of `frameDt` seconds.
  advance(frameDt) {
    this.acc += Math.min(Math.max(frameDt, 0), MAX_FRAME_DT);
    let n = Math.floor(this.acc / SIM_DT + 1e-6);
    if (n > MAX_STEPS) {
      this.dropped += n - MAX_STEPS;
      n = MAX_STEPS;
      this.acc %= SIM_DT;              // drop the backlog, keep the phase
    } else {
      this.acc -= n * SIM_DT;
    }
    this.steps += n;
    return n;
  }

  // Discard any accumulated time (used on resume, release of Hold, tab return).
  reset() { this.acc = 0; }
}
