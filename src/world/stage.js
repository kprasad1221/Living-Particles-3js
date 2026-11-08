// ─────────────────────────────────────────────────────────────────────────────
//  Stage: renderer, camera, sky, bloom, and the pointer's position on the floor.
//
//  Render path (all intermediate targets linear half-float; tone mapping and sRGB
//  conversion happen once, in OutputPass):
//
//    1 scene        the full scene                                   → mainRT (4× MSAA)
//    2 emission     the same scene, emission terms only, sky hidden  → emRT   (same geometry,
//                   so rims hidden behind a column stay hidden)
//    3 bloom input  mix(emission, scene, look.bloomSky)               → inRT
//                   bloomSky 0: only emitted light can glow (the sky and fog never bloom)
//                   bloomSky 1: Study 01's behaviour, the whole scene above the cutoff glows
//    4 bloom        UnrealBloomPass on inRT; its own composite target holds the glow alone
//    5 combine      scene + glow                                      → finalRT
//    6 output       tone map + sRGB                                    → screen
//
//  Diagnostic views (never saved): normal · nobloom · bloom (glow alone) · emission · surface.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { P } from '../params.js';

const skyVertex = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;                 // always at the far plane
  }
`;
const skyFragment = /* glsl */`
  uniform vec3 uTop, uHorizon;
  uniform float uGlow;
  varying vec3 vDir;
  void main() {
    float y = vDir.y;
    float up = smoothstep(0.0, 0.55, y);
    vec3 col = mix(uHorizon, uTop, pow(up, 0.7));
    col += uHorizon * uGlow * exp(-abs(y) * 18.0);            // a bright seam where floor meets sky
    col = mix(col, uHorizon, step(y, 0.0));                    // below the horizon: the fog colour
    gl_FragColor = vec4(col, 1.0);
  }
`;

export const BOOKMARKS = {
  stand:  { pos: [0, 6.2, 24], target: [0, 2.2, -14], label: 'Stand' },      // VR eye height, looking out
  survey: { pos: [0, 78, 58], target: [0, 0, 0], label: 'Survey' },          // the scene view: rings read as a mandala
  low:    { pos: [17, 2.4, 17], target: [0, 1.4, 0], label: 'Low' },         // among the columns
};

export class Stage {
  constructor(canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 1);
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(P.camera.fov, 1, 0.1, 1500);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495; this.controls.minDistance = 2; this.controls.maxDistance = 260;

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), new THREE.ShaderMaterial({
      uniforms: { uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGlow: { value: 0.3 } },
      vertexShader: skyVertex, fragmentShader: skyFragment, side: THREE.BackSide, depthWrite: false,
    }));
    this.sky.frustumCulled = false; this.sky.renderOrder = -1;
    this.scene.add(this.sky);

    const rt = (samples = 0) => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples, depthBuffer: samples > 0 });
    this.mainRT = rt(4); this.emRT = rt(4); this.inRT = rt(); this.finalRT = rt();
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1, 0.4, 0.2);
    this.output = new OutputPass(); this.output.renderToScreen = true;
    const quad = (fragmentShader, uniforms) => new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms, fragmentShader, depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    }));
    this.mixQuad = quad(`uniform sampler2D tA, tB; uniform float k; varying vec2 vUv;
      void main() { gl_FragColor = vec4(mix(texture2D(tA, vUv).rgb, texture2D(tB, vUv).rgb, k), 1.0); }`,
      { tA: { value: this.emRT.texture }, tB: { value: this.mainRT.texture }, k: { value: 0 } });
    this.combineQuad = quad(`uniform sampler2D tScene, tGlow; uniform float sceneAmt, glowAmt; varying vec2 vUv;
      void main() { gl_FragColor = vec4(texture2D(tScene, vUv).rgb * sceneAmt + texture2D(tGlow, vUv).rgb * glowAmt, 1.0); }`,
      { tScene: { value: this.mainRT.texture }, tGlow: { value: null }, sceneAmt: { value: 1 }, glowAmt: { value: 0 } });
    this.emissionHook = null;          // (on: boolean) => void — set by main: switches the tile shader to emission-only
    this.look = null;
    this.size = { w: 1, h: 1, dpr: 1 };
    this.flight = null;
    this.goTo('stand', true);

    // Affector: pointer → ray → the plane at tile-top height.
    this.pointer = { x: 0, z: 0, inside: false, lastMove: -1e9 };
    this.affector = { x: 0, z: 0, on: 0 };
    this.ray = new THREE.Raycaster(); this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.6);
    const hit = new THREE.Vector3(), ndc = new THREE.Vector2();
    const onMove = e => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.ray.setFromCamera(ndc, this.camera);
      if (this.ray.ray.intersectPlane(this.plane, hit) && hit.distanceTo(this.camera.position) < 400) {
        this.pointer.x = hit.x; this.pointer.z = hit.z; this.pointer.inside = true;
        this.pointer.lastMove = performance.now();
      } else this.pointer.inside = false;
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onMove);
    canvas.addEventListener('pointerleave', () => { this.pointer.inside = false; });
  }

  resize(w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * P.render.scale;
    this.size = { w, h, dpr };
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    for (const t of [this.mainRT, this.emRT, this.inRT, this.finalRT]) t.setSize(W, H);
    this.bloom.setSize(W, H);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  // Pixels per scene unit at distance 1 — what point sprites need to size in world units.
  get pixelScale() { return (this.size.h * this.size.dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)); }

  goTo(name, instant = false) {
    const b = BOOKMARKS[name]; if (!b) return;
    const to = { pos: new THREE.Vector3(...b.pos), target: new THREE.Vector3(...b.target) };
    if (instant) { this.camera.position.copy(to.pos); this.controls.target.copy(to.target); this.controls.update(); this.flight = null; return; }
    this.flight = { from: { pos: this.camera.position.clone(), target: this.controls.target.clone() }, to, t: 0 };
  }

  update(dt, look, time) {
    if (this.flight) {
      const f = this.flight; f.t = Math.min(1, f.t + dt / 1.4);
      const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(f.from.pos, f.to.pos, e);
      this.controls.target.lerpVectors(f.from.target, f.to.target, e);
      if (f.t >= 1) this.flight = null;
    }
    this.controls.autoRotate = P.camera.drift; this.controls.autoRotateSpeed = P.camera.driftSpeed;
    if (this.camera.fov !== P.camera.fov) { this.camera.fov = P.camera.fov; this.camera.updateProjectionMatrix(); }
    this.controls.update(dt);
    this.sky.position.copy(this.camera.position);

    // Affector: follow the pointer while it moves; fade out after 2.5 s of stillness.
    const A = P.affector, a = this.affector;
    let want = 0;
    if (A.on && A.mode === 'orbit') {
      const s = time * A.speed;
      a.x = 26 * Math.sin(s * 1.0) * Math.cos(s * 0.37); a.z = 20 * Math.sin(s * 0.71 + 1.3);
      want = 1;
    } else if (A.on && this.pointer.inside && performance.now() - this.pointer.lastMove < 2500) {
      const k = 1 - Math.exp(-dt * 14);
      a.x += (this.pointer.x - a.x) * k; a.z += (this.pointer.z - a.z) * k;
      want = 1;
    }
    a.on += (want - a.on) * (1 - Math.exp(-dt * (want ? 8 : 2.5)));

    const s = this.sky.material.uniforms, view = P.diag.view;
    s.uTop.value.copy(look.skyTop); s.uHorizon.value.copy(look.horizon); s.uGlow.value = look.horizonGlow;
    this.sky.visible = view !== 'emission';
    this.look = look;
    this.bloom.strength = look.bloom; this.bloom.radius = look.bloomRadius; this.bloom.threshold = look.bloomThreshold;
    const tm = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, none: THREE.NoToneMapping };
    this.renderer.toneMapping = tm[P.render.toneMapping] ?? THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = look.exposure;
  }

  render() {
    const r = this.renderer, view = P.diag.view, look = this.look;
    r.setRenderTarget(this.mainRT); r.clear(); r.render(this.scene, this.camera);

    const glow = look && look.bloom > 0 && (view === 'normal' || view === 'bloom');
    if (glow) {
      if (look.bloomSky < 1) {
        const skyWas = this.sky.visible;
        this.sky.visible = false; this.emissionHook?.(true);
        r.setRenderTarget(this.emRT); r.clear(); r.render(this.scene, this.camera);
        this.sky.visible = skyWas; this.emissionHook?.(false);
      }
      this.mixQuad.material.uniforms.k.value = look.bloomSky;
      r.setRenderTarget(this.inRT); this.mixQuad.render(r);
      this.bloom.render(r, null, this.inRT, 0, false);
    }
    const c = this.combineQuad.material.uniforms;
    c.tGlow.value = this.bloom.renderTargetsHorizontal[0].texture;
    c.sceneAmt.value = view === 'bloom' ? 0 : 1;
    c.glowAmt.value = glow ? 1 : 0;
    r.setRenderTarget(this.finalRT); this.combineQuad.render(r);
    this.output.render(r, null, this.finalRT);
  }
}
