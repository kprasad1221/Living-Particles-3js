// The mixed look's ramps as one small texture: RAMP_SIZE wide, one row per role (see RAMP_ROWS in
// looks.js). 8-bit sRGB: the GPU decodes to linear when sampling, so shaders use the value as is.
// Sample row r at v = (r + 0.5) / rows so rows never bleed into each other.
import * as THREE from 'three';
import { RAMP_SIZE, toSRGB8 } from '../shared/palette.js';

export class RampTexture {
  constructor(rows) {
    this.rows = rows;
    this.bytes = new Uint8Array(RAMP_SIZE * rows * 4);
    const t = this.texture = new THREE.DataTexture(this.bytes, RAMP_SIZE, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.generateMipmaps = false;
    t.needsUpdate = true;
    this.version = -1;
  }
  // `look` is a mixed look (mixLooks): rampLinear holds rows × RAMP_SIZE linear rgb triples.
  update(look) {
    if (!look.rampLinear || look.rampVersion === this.version) return;
    toSRGB8(look.rampLinear, this.bytes);
    this.texture.needsUpdate = true; this.version = look.rampVersion;
  }
}
