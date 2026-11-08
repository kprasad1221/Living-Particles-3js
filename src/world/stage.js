// ─────────────────────────────────────────────────────────────────────────────
//  Stage: renderer, camera, sky, bloom, and the affector's position.
//
//  Post chain (TouchDesigner: Render TOP → Bloom/Glow TOPs → Out TOP; Unity: the
//  post-processing volume with Bloom):
//    RenderPass (half-float, 4× MSAA) → SavePass (keeps the scene before bloom)
//      → UnrealBloomPass → Diagnostic pass → OutputPass (tone map + sRGB, once)
//
//  Diagnostic views (Light → diagnostics, never saved):
//    normal    the composite
//    nobloom   bloom pass disabled
//    bloom     bloom contribution only: composite − saved scene (bloom adds onto the scene)
//    emission  only emitted light (rims, fills, flashes, sparks), no surfaces, sky or bloom
//    surface   only lit surfaces and fog, no emission or bloom
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SavePass } from 'three/addons/postprocessing/SavePass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
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

    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.save = new SavePass(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
    this.composer.addPass(this.save);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1, 0.4, 0.2);
    this.composer.addPass(this.bloom);
    this.diagPass = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, tScene: { value: this.save.renderTarget.texture }, uMode: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse, tScene; uniform float uMode; varying vec2 vUv;
        void main() { vec4 c = texture2D(tDiffuse, vUv);
          if (uMode > 0.5) c.rgb = max(c.rgb - texture2D(tScene, vUv).rgb, 0.0);
          gl_FragColor = c; }`,
    });
    this.diagPass.uniforms.tScene.value = this.save.renderTarget.texture;   // ShaderPass clones uniforms: re-link
    this.composer.addPass(this.diagPass);
    this.composer.addPass(new OutputPass());

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
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.save.renderTarget.setSize(Math.round(w * dpr), Math.round(h * dpr));
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
    this.bloom.enabled = view === 'normal' || view === 'bloom';
    this.diagPass.uniforms.uMode.value = view === 'bloom' ? 1 : 0;
    this.bloom.strength = look.bloom; this.bloom.radius = look.bloomRadius; this.bloom.threshold = look.bloomThreshold;
    const tm = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, none: THREE.NoToneMapping };
    this.renderer.toneMapping = tm[P.render.toneMapping] ?? THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = look.exposure;
  }

  render() { this.composer.render(); }
}
