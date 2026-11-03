import * as THREE from 'three';
import { GLTFLoader } from '../vendor/addons/loaders/GLTFLoader.js';
import { OrbitControls } from '../vendor/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from '../vendor/addons/libs/meshopt_decoder.module.js';
import { ClawRig } from './claw-rig.js';
import { initAudio, prewarmAudio, duckAudio, sfx, setMusicMode, audioState } from './arcade-audio.js';
window.__audio = audioState;
import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/addons/postprocessing/RenderPass.js';
import { ShaderPass } from '../vendor/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';

// ---------- renderer / scene ----------
const canvas = document.getElementById('c');
// ?nofx renders straight to screen: no bloom, no composer passes
const noPostFx = new URLSearchParams(location.search).has('nofx');
// With post-FX the scene renders into the composer's own MSAA target; canvas MSAA would be wasted
const renderer = new THREE.WebGLRenderer({ canvas, antialias: noPostFx, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
// The shadow map is refreshed once per frame (before the beauty pass), not again for the bloom mask
renderer.shadowMap.autoUpdate = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.transmissionResolutionScale = 0.5; // half-res refraction buffer for the glass balls

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0714);

// 360° equirectangular arcade sphere + PMREM reflection environment
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const skyCfg = {
  repeatX: 4.75,
  repeatY: 3.12,
  centerU: 0.183,
  offsetY: -0.01,
  radius: 18,
  posY: 0.92,
  blur: 0.18,          // soften pixel-art detail -> abstract, mysterious backdrop
  brightness: 0.48,    // the room dims; the machine becomes the light
  envIntensity: 0.9,
  camDistMul: 2.18,
};
const envSphereGeo = new THREE.SphereGeometry(1, 72, 40);
const envSphereMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    uMap: { value: null },
    uTexSize: { value: new THREE.Vector2(2048, 1012) },
    uRepeat: { value: new THREE.Vector2(skyCfg.repeatX, skyCfg.repeatY) },
    uCenterU: { value: skyCfg.centerU },
    uOffsetY: { value: skyCfg.offsetY },
    uBlur: { value: skyCfg.blur },
    uBrightness: { value: skyCfg.brightness },
    uZoomK: { value: 0.5 },
  },
  vertexShader: `varying vec3 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4( position, 1.0 );
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: `uniform sampler2D uMap;
    uniform vec2 uTexSize;
    uniform vec2 uRepeat;
    uniform float uCenterU;
    uniform float uOffsetY;
    uniform float uBlur;
    uniform float uBrightness;
    varying vec3 vWorldPos;
    const float PI = 3.14159265359;

    // Smooth Catmull-Rom / Quintic texel interpolation + optional soft blur
    vec3 sampleSmooth(vec2 uv) {
      vec2 p = uv * uTexSize - 0.5;
      vec2 i = floor(p);
      vec2 f = p - i;
      f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
      vec2 uvSmooth = (i + f + 0.5) / uTexSize;
      vec3 c = texture2D(uMap, uvSmooth).rgb;
      if (uBlur > 0.001) {
        vec2 d = (uBlur * 1.6) / uTexSize;
        vec3 b = 0.25 * (
          texture2D(uMap, uvSmooth + vec2( d.x,  d.y)).rgb +
          texture2D(uMap, uvSmooth + vec2(-d.x,  d.y)).rgb +
          texture2D(uMap, uvSmooth + vec2( d.x, -d.y)).rgb +
          texture2D(uMap, uvSmooth + vec2(-d.x, -d.y)).rgb
        );
        c = mix(c, b, min(1.0, uBlur));
      }
      return c;
    }

    uniform float uZoomK;
    void main() {
      // View direction from the camera so portrait FOV maps cleanly to the 360° panorama
      vec3 d = normalize(vWorldPos - cameraPosition);
      float yaw = atan(d.x, -d.z); // 0 straight ahead (-Z), negative left, positive right
      // Dolly parallax: zooming in magnifies the room like walking toward it
      vec2 rep = uRepeat * mix(1.14, 0.88, uZoomK);
      float u = fract(uCenterU + (yaw / (2.0 * PI)) * rep.x);
      float lat = asin(clamp(d.y, -1.0, 1.0)) / PI; // -0.5 (floor) .. +0.5 (ceiling)
      float v = clamp(0.5 + (lat - uOffsetY) * rep.y, 0.004, 0.996);
      vec3 col = sampleSmooth(vec2(u, v)) * uBrightness;
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`,
});
const envSphere = new THREE.Mesh(envSphereGeo, envSphereMat);
envSphere.scale.setScalar(skyCfg.radius);
envSphere.position.set(0, skyCfg.posY, 0);
envSphere.renderOrder = -10;
scene.add(envSphere);
window.__sky = { cfg: skyCfg, mesh: envSphere, mat: envSphereMat };

new THREE.TextureLoader().load('./assets/arcade-env-360.jpg', (tex) => {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.MirroredRepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.mapping = THREE.EquirectangularReflectionMapping;
  envSphereMat.uniforms.uMap.value = tex;
  if (tex.image && tex.image.width) {
    envSphereMat.uniforms.uTexSize.value.set(tex.image.width, tex.image.height);
  }
  scene.environment = pmrem.fromEquirectangular(tex).texture;
  scene.environmentIntensity = skyCfg.envIntensity;
  pmrem.dispose();
});

// ---------- camera ----------
const portraitFov = () => (innerHeight > innerWidth ? 52 : 40);
const camera = new THREE.PerspectiveCamera(portraitFov(), innerWidth / innerHeight, 0.01, 60);

// ---------- post-processing: SELECTIVE UnrealBloom ----------
// (webgl_postprocessing_unreal_bloom_selective): only BLOOM_LAYER objects glow.
// Pass 1 renders the scene with every non-bloom mesh blackened, blurs it;
// Pass 2 renders the scene normally and adds the bloom texture on top.
const BLOOM_LAYER = 1;
const bloomLayer = new THREE.Layers();
bloomLayer.set(BLOOM_LAYER);
const darkMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
const _dark = new Map();
// Cached bloom masks — the scene is traversed ONCE after everything loads
// instead of walking ~350 nodes every single frame
const _darkTargets = [];
const _hideTargets = [];
const _wasVisible = [];
function rebuildBloomMask() {
  _darkTargets.length = 0;
  _hideTargets.length = 0;
  scene.traverse((obj) => {
    if ((!obj.isMesh && !obj.isSprite && !obj.isPoints) || bloomLayer.test(obj.layers)) return;
    if (obj === revealRig.meshA || obj === revealRig.meshB) {
      _darkTargets.push(obj);
      return;
    }
    // Transparent meshes/points (glass panes, blob shadow, particles) get hidden so neon
    // strips inside the vitrine still reach the bloom buffer
    const isTrans = Array.isArray(obj.material)
      ? obj.material.some((m) => m && m.transparent)
      : Boolean(obj.material && obj.material.transparent);
    if (obj.isPoints || isTrans) _hideTargets.push(obj);
    else _darkTargets.push(obj);
  });
}
function darkenNonBloomed() {
  for (const o of _darkTargets) { _dark.set(o, o.material); o.material = darkMaterial; }
  for (let i = 0; i < _hideTargets.length; i++) {
    const o = _hideTargets[i];
    _wasVisible[i] = o.visible;
    o.visible = false;
  }
}
function restoreMaterials() {
  for (const [o, m] of _dark) o.material = m;
  _dark.clear();
  for (let i = 0; i < _hideTargets.length; i++) _hideTargets[i].visible = _wasVisible[i];
}

const bloomComposer = new EffectComposer(renderer);
bloomComposer.renderToScreen = false;
bloomComposer.setPixelRatio(Math.min(devicePixelRatio, 2));
// Half-res bloom isolation pass — it's a multi-mip blur anyway, so the
// downsampled isolation render looks identical at ~4x less GPU cost
bloomComposer.setSize(innerWidth * 0.5, innerHeight * 0.5);
bloomComposer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.35, 0.55);
bloomComposer.addPass(bloomPass);

const mixPass = new ShaderPass(new THREE.ShaderMaterial({
  uniforms: {
    baseTexture: { value: null },
    bloomTexture: { value: bloomComposer.renderTarget2.texture }
  },
  vertexShader: `varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
  fragmentShader: `uniform sampler2D baseTexture; uniform sampler2D bloomTexture; varying vec2 vUv;
    void main() { gl_FragColor = texture2D( baseTexture, vUv ) + texture2D( bloomTexture, vUv ); }`
}), 'baseTexture');
mixPass.needsSwap = true;

const finalComposer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
  type: THREE.HalfFloatType, samples: 4
}));
finalComposer.setPixelRatio(Math.min(devicePixelRatio, 2));
finalComposer.setSize(innerWidth, innerHeight);
finalComposer.addPass(new RenderPass(scene, camera));
finalComposer.addPass(mixPass);
finalComposer.addPass(new OutputPass());
window.__fx = { bloomPass, renderer, glassMats: () => claw?._glassMats };

// ---------- FX & Skybox tuning panel ----------
// Base values the flicker modulates around (sliders own the bases, not the frame values)
let bloomBase = 0.55, flickAmp = 1.0, pitCyanBase = 2.1, pitMagBase = 2.1, glow2Base = 0.62;
const fxPanel = document.getElementById('fx-panel');
const fxToggleBtn = document.getElementById('fx-toggle');
const skyToggleBtn = document.getElementById('sky-toggle');
// Dev tuning panel only with ?dev — players see the machine, not the machinery
if (fxToggleBtn && location.search.includes('dev')) fxToggleBtn.style.display = '';
if (fxToggleBtn && fxPanel) {
  fxToggleBtn.addEventListener('click', (e) => { e.stopPropagation(); fxPanel.classList.toggle('open'); });
  if (skyToggleBtn) {
    skyToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fxPanel.classList.toggle('open');
      fxPanel.scrollTop = 0;
    });
  }
  const addSec = (txt) => { const h = document.createElement('div'); h.className = 'fx-sec'; h.textContent = txt; fxPanel.appendChild(h); };
  const addSep = () => { const d = document.createElement('div'); d.className = 'fx-sep'; fxPanel.appendChild(d); };
  const addSlider = (title, min, max, step, get, set) => {
    const row = document.createElement('div'); row.className = 'fx-row';
    const lab = document.createElement('label');
    const name = document.createElement('span'); name.textContent = title;
    const val = document.createElement('span');
    const fmt = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2));
    val.textContent = fmt(get());
    lab.append(name, val);
    const inp = document.createElement('input');
    Object.assign(inp, { type: 'range', min, max, step, value: get() });
    inp.addEventListener('input', () => { set(parseFloat(inp.value)); val.textContent = fmt(get()); });
    row.append(lab, inp);
    fxPanel.appendChild(row);
  };

  addSec('360° Skybox');
  addSlider('Sky escala H', 1.0, 7.0, 0.05, () => skyCfg.repeatX, (v) => {
    skyCfg.repeatX = v;
    envSphereMat.uniforms.uRepeat.value.x = v;
  });
  addSlider('Sky escala V', 1.0, 5.0, 0.05, () => skyCfg.repeatY, (v) => {
    skyCfg.repeatY = v;
    envSphereMat.uniforms.uRepeat.value.y = v;
  });
  addSlider('Sky giro U', 0, 1, 0.005, () => skyCfg.centerU, (v) => {
    skyCfg.centerU = v;
    envSphereMat.uniforms.uCenterU.value = v;
  });
  addSlider('Sky horizonte Y', -0.45, 0.45, 0.005, () => skyCfg.offsetY, (v) => {
    skyCfg.offsetY = v;
    envSphereMat.uniforms.uOffsetY.value = v;
  });
  addSlider('Cam distancia', 1.1, 2.6, 0.02, () => skyCfg.camDistMul, (v) => {
    skyCfg.camDistMul = v;
    if (window.__reframeCabinet) window.__reframeCabinet();
  });
  addSlider('Sky radio esfera', 4, 30, 0.5, () => skyCfg.radius, (v) => {
    skyCfg.radius = v;
    envSphere.scale.setScalar(v);
  });
  addSlider('Sky altura esfera', -1.0, 3.0, 0.05, () => skyCfg.posY, (v) => {
    skyCfg.posY = v;
    envSphere.position.y = v;
  });
  addSlider('Sky suavizado', 0, 1.5, 0.02, () => skyCfg.blur, (v) => {
    skyCfg.blur = v;
    envSphereMat.uniforms.uBlur.value = v;
  });
  addSlider('Sky brillo', 0.2, 1.8, 0.02, () => skyCfg.brightness, (v) => {
    skyCfg.brightness = v;
    envSphereMat.uniforms.uBrightness.value = v;
  });
  addSlider('Reflejo 360°', 0, 2.5, 0.05, () => skyCfg.envIntensity, (v) => {
    skyCfg.envIntensity = v;
    scene.environmentIntensity = v;
  });
  addSep();
  addSec('Post & Luces');
  addSlider('Bloom strength', 0, 2, 0.01, () => bloomBase, (v) => bloomBase = v);
  addSlider('Bloom radius', 0, 1.2, 0.01, () => bloomPass.radius, (v) => bloomPass.radius = v);
  addSlider('Bloom threshold', 0, 1, 0.005, () => bloomPass.threshold, (v) => bloomPass.threshold = v);
  addSlider('Neon flicker', 0, 2, 0.05, () => flickAmp, (v) => flickAmp = v);
  addSep();
  addSlider('Exposure', 0.4, 2.2, 0.01, () => renderer.toneMappingExposure, (v) => renderer.toneMappingExposure = v);
  addSlider('Ball glass', 0, 1, 0.01,
    () => (claw && claw._glassMats ? claw._glassMats[0].transmission : 0.92),
    (v) => { if (!claw) return; claw._glassMats.forEach((m) => { m.transmission = v; m.color.setHex(v > 0.05 ? 0xffffff : m.userData.hex); m.needsUpdate = true; }); });
  addSlider('Floor ring glow', 0, 1.2, 0.02, () => glow2Base, (v) => glow2Base = v);
}

// ---------- lights ----------
scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x241a30, 0.85));

const key = new THREE.DirectionalLight(0xffe8c8, 2.6);
key.position.set(3.5, 6, 4.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 20;
key.shadow.camera.left = key.shadow.camera.bottom = -4;
key.shadow.camera.right = key.shadow.camera.top = 4;
key.shadow.bias = -0.0004;
scene.add(key, key.target);

const rim = new THREE.DirectionalLight(0x9fb8ff, 0.9);
rim.position.set(-4, 3.5, -5);
scene.add(rim);

// ---------- ground shadow catcher ----------
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(6, 48),
  new THREE.ShadowMaterial({ opacity: 0.35 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Visible floor: not a pad — a soft darkening pool that grounds the machine and
// lets the panorama's sparkle floor peek through near the feet before sinking
// into darkness. No hard edge, no color plate.
const floorTex = new THREE.TextureLoader().load('./assets/floor-terrazzo.jpg');
floorTex.colorSpace = THREE.SRGBColorSpace;
floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
floorTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
const floorMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: {
    uMap: { value: floorTex },
    uTiles: { value: 15.0 },
  },
  vertexShader: `varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform sampler2D uMap;
    uniform float uTiles;
    varying vec2 vUv;
    void main(){
      float r = length(vUv - 0.5) * 2.0; // 0 center .. 1 edge
      vec3 tex = texture2D(uMap, vUv * uTiles).rgb;
      // Edge must meet the panorama's own floor brightness or the disc reads as
      // a hole — gentle dim, fine chips, dissolve only at the last stretch
      float dim = 1.0 - smoothstep(0.0, 0.85, r) * 0.38;
      float a = (1.0 - smoothstep(0.55, 0.98, r)) * 0.9;
      gl_FragColor = vec4(tex * dim * 0.78, a);
      #include <colorspace_fragment>
    }`,
});
const floor = new THREE.Mesh(new THREE.CircleGeometry(5.2, 64), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.004;
floor.renderOrder = -5;
scene.add(floor);

// Neon-ish floor glow ring for arcade flavor
const glowMat = new THREE.MeshBasicMaterial({ color: 0x7a4dff, transparent: true, opacity: 0.55 });
glowMat.color.multiplyScalar(1.7); // HDR so bloom catches it
const glow = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.22, 64), glowMat);
glow.rotation.x = -Math.PI / 2;
glow.position.y = 0.002;
scene.add(glow);

const glow2Mat = new THREE.MeshBasicMaterial({ color: 0xff2ec4, transparent: true, opacity: 0.5 });
glow2Mat.color.multiplyScalar(1.7);
const glow2 = new THREE.Mesh(new THREE.RingGeometry(0.88, 0.93, 64), glow2Mat);
glow2.rotation.x = -Math.PI / 2;
glow2.position.y = 0.003;
scene.add(glow2);

// ---------- neon arcade dressing ----------
const NEON = { magenta: 0xff2ec4, cyan: 0x22d3ee, violet: 0x8b5cf6, warm: 0xffe08a };

// HDR neon material: color >1.0 so UnrealBloom actually blooms it
const bloomObjs = [glow, glow2];
function neonMat(hex, boost = 2.4) {
  const m = new THREE.MeshBasicMaterial({ color: hex });
  m.color.multiplyScalar(boost);
  return m;
}

// Top vitrine LED strips — kept OFF during normal play and only lit for a few seconds on prize win
const neonLights = [];
const topStrips = [];
const stripDefs = [
  { w: 0.74, d: 0.024, x: 0, z: 0.315, hex: NEON.magenta },
  { w: 0.74, d: 0.024, x: 0, z: -0.395, hex: NEON.cyan },
  { w: 0.024, d: 0.72, x: -0.353, z: -0.04, hex: NEON.violet },
  { w: 0.024, d: 0.72, x: 0.353, z: -0.04, hex: NEON.violet }
];
for (const s of stripDefs) {
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(s.w, 0.022, s.d),
    neonMat(s.hex)
  );
  strip.position.set(s.x, 1.5, s.z);
  strip.visible = false;
  scene.add(strip);
  topStrips.push(strip);
  bloomObjs.push(strip);
}
// Vertical corner light columns inside the vitrine (arcade claw machines have these)
const cornerDefs = [
  { x: -0.345, z: 0.3, hex: NEON.cyan },
  { x: 0.345, z: 0.3, hex: NEON.magenta },
  { x: -0.345, z: -0.38, hex: NEON.violet },
  { x: 0.345, z: -0.38, hex: NEON.cyan }
];
for (const c of cornerDefs) {
  const col = new THREE.Mesh(
    new THREE.CylinderGeometry(0.009, 0.009, 0.76, 8),
    neonMat(c.hex, 1.8)
  );
  col.position.set(c.x, 1.11, c.z);
  scene.add(col);
  bloomObjs.push(col);
}
// Mark everything neon onto the selective bloom layer
for (const o of bloomObjs) o.traverse((c) => c.layers.enable(BLOOM_LAYER));
// Top interior washes — off until a prize drops
const pitCyan = new THREE.PointLight(NEON.cyan, 0, 2.0, 1.8);
pitCyan.position.set(-0.28, 1.42, 0.16);
const pitMag = new THREE.PointLight(NEON.magenta, 0, 2.0, 1.8);
pitMag.position.set(0.3, 1.42, -0.28);
const pitWarm = new THREE.PointLight(0xffe2b8, 0, 2.2, 1.8);
pitWarm.position.set(0, 1.5, 0.1);
scene.add(pitCyan, pitMag, pitWarm);
neonLights.push(pitCyan, pitMag);

// Warm marquee light so the CLAW sign glows like the real thing
const marqueeLight = new THREE.PointLight(NEON.warm, 1.5, 2.6, 1.6);
marqueeLight.position.set(0, 1.58, 1.0);
scene.add(marqueeLight);

// ---------- arcade polish: volumetric shaft, dust motes, blob shadow, confetti ----------
// Fake volumetric light shaft falling from the vitrine LED strips onto the pile
const shaftMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  uniforms: {
    uColor: { value: new THREE.Color(0xffc4f2) },
    uTime: { value: 0 },
    uOp: { value: 0.13 },
  },
  vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
    void main() { vUv = uv; vN = normalize( normalMatrix * normal );
      vec4 mv = modelViewMatrix * vec4( position, 1.0 ); vV = normalize( -mv.xyz );
      gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform vec3 uColor; uniform float uTime; uniform float uOp;
    varying vec2 vUv; varying vec3 vN; varying vec3 vV;
    void main() {
      float vert = smoothstep( 0.05, 1.0, vUv.y );                    // bright at the LEDs, fades downward
      float fr = pow( abs( dot( normalize( vN ), normalize( vV ) ) ), 1.6 ); // fade at silhouette edges
      float shimmer = 0.82 + 0.18 * sin( uTime * 2.1 + vUv.y * 8.0 );
      gl_FragColor = vec4( uColor, uOp * vert * fr * shimmer );
    }`,
});
const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.56, 0.85, 28, 1, true), shaftMat);
shaft.position.set(0, 1.32, 0.05);
shaft.layers.enable(BLOOM_LAYER);
shaft.visible = false;
scene.add(shaft);

// Sparkle particles inside the vitrine — hidden permanently during normal play,
// only appear together with the top light for a few seconds when a prize drops
const DUST_N = 46;
const dustPos = new Float32Array(DUST_N * 3);
const dustSeed = new Float32Array(DUST_N);
for (let i = 0; i < DUST_N; i++) {
  dustPos[i * 3] = (Math.random() - 0.5) * 0.85;
  dustPos[i * 3 + 1] = 0.8 + Math.random() * 0.75;
  dustPos[i * 3 + 2] = (Math.random() - 0.5) * 0.85;
  dustSeed[i] = Math.random() * 100;
}
const dustCv = document.createElement('canvas');
dustCv.width = dustCv.height = 32;
const dcx = dustCv.getContext('2d');
const dgr = dcx.createRadialGradient(16, 16, 1, 16, 16, 15);
dgr.addColorStop(0, 'rgba(255,255,255,1)');
dgr.addColorStop(0.45, 'rgba(216,236,255,0.65)');
dgr.addColorStop(1, 'rgba(216,236,255,0)');
dcx.fillStyle = dgr;
dcx.fillRect(0, 0, 32, 32);
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
  color: 0xd8ecff, size: 0.024, map: new THREE.CanvasTexture(dustCv), transparent: true, opacity: 0,
  blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
}));
dust.visible = false;
scene.add(dust);
let winLightLife = 0;
const WIN_LIGHT_DUR = 3.2;
function triggerWinLight() {
  winLightLife = WIN_LIGHT_DUR;
  shaft.visible = true;
  dust.visible = true;
  for (const s of topStrips) s.visible = true;
}

// Soft blob shadow grounding the claw over the prize pile
const blobCv = document.createElement('canvas');
blobCv.width = blobCv.height = 128;
const bcx = blobCv.getContext('2d');
const bgr = bcx.createRadialGradient(64, 64, 4, 64, 64, 62);
bgr.addColorStop(0, 'rgba(0,0,0,0.85)');
bgr.addColorStop(1, 'rgba(0,0,0,0)');
bcx.fillStyle = bgr;
bcx.fillRect(0, 0, 128, 128);
const blobShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(0.52, 0.52),
  new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(blobCv), transparent: true, depthWrite: false, opacity: 0 })
);
blobShadow.rotation.x = -Math.PI / 2;
scene.add(blobShadow);

// Neon confetti burst when a prize physically lands in the chute
const CONF_N = 120;
const confPos = new Float32Array(CONF_N * 3);
const confCol = new Float32Array(CONF_N * 3);
const confVel = new Float32Array(CONF_N * 3);
const confGeo = new THREE.BufferGeometry();
confGeo.setAttribute('position', new THREE.BufferAttribute(confPos, 3));
confGeo.setAttribute('color', new THREE.BufferAttribute(confCol, 3));
const confetti = new THREE.Points(confGeo, new THREE.PointsMaterial({
  size: 0.02, vertexColors: true, transparent: true, opacity: 0,
  depthWrite: false, sizeAttenuation: true,
}));
confetti.visible = false;
scene.add(confetti);
let confettiLife = 0;
const _vConf = new THREE.Vector3();
const CONF_COLORS = [NEON.magenta, NEON.cyan, NEON.warm, 0xffffff, NEON.violet].map((h) => new THREE.Color(h));
function spawnConfetti(at) {
  for (let i = 0; i < CONF_N; i++) {
    confPos[i * 3] = at.x; confPos[i * 3 + 1] = at.y; confPos[i * 3 + 2] = at.z;
    const a = Math.random() * Math.PI * 2, r = 0.3 + Math.random() * 0.9;
    confVel[i * 3] = Math.cos(a) * r;
    confVel[i * 3 + 1] = 0.8 + Math.random() * 1.4;
    confVel[i * 3 + 2] = Math.sin(a) * r;
    const c = CONF_COLORS[(Math.random() * CONF_COLORS.length) | 0];
    confCol[i * 3] = c.r; confCol[i * 3 + 1] = c.g; confCol[i * 3 + 2] = c.b;
  }
  confGeo.attributes.position.needsUpdate = true;
  confGeo.attributes.color.needsUpdate = true;
  confetti.visible = true;
  confetti.material.opacity = 1;
  confettiLife = 1.6;
}

// ---------- controls ----------
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minPolarAngle = 0.35;
controls.maxPolarAngle = Math.PI * 0.52;
controls.rotateSpeed = 0.9;
controls.zoomSpeed = 0.8;

// ---------- load the claw machine ----------
const perfMark = (n) => window.__perf && window.__perf.push([n, Math.round(performance.now())]);
perfMark('bundle-eval');
const loader = new GLTFLoader();
// Decode meshopt buffers off the main thread — the flag stays smooth during parse.
try { MeshoptDecoder.useWorkers(Math.min(4, navigator.hardwareConcurrency || 2)); } catch (_) {}
loader.setMeshoptDecoder(MeshoptDecoder);

const loadBar = document.querySelector('#bar i');
const loadingEl = document.getElementById('loading');
const scoreEl = document.getElementById('prize-score');
let machine = null;
let claw = null;

// Keyboard + 3D cabinet hardware controls for moving gantry & triggering grab cycle
const keys = new Set();
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
const _vWorldA = new THREE.Vector3();
const _vWorldB = new THREE.Vector3();
const _vScreenA = new THREE.Vector3();
const _vScreenB = new THREE.Vector3();
const _panelNormal = new THREE.Vector3(0.0, 0.919, 0.394).normalize();
const _unitZ = new THREE.Vector3(0, 0, 1);
const deckCtrl = {
  stickMesh: null,
  stickBaseMesh: null,
  stickPivot: null,
  stickCollider: null,
  btnMesh: null,
  btnBezelMesh: null,
  btnPivot: null,
  btnCollider: null,
  btnHalo: null,
  btnHaloOuter: null,
  btnLight: null,
  stickX: 0,
  stickZ: 0,
  stickVX: 0,
  stickVZ: 0,
  targetX: 0,
  targetZ: 0,
  draggingStick: false,
  pressingBtn: false,
  pointerId: null,
  grabOriginX: 0,
  grabOriginY: 0,
  startStickX: 0,
  startStickZ: 0,
  btnDepress: 0,
  btnVel: 0,
  lastTickStep: 0,
};

function rubberband(v, limit = 1, k = 0.55) {
  const abs = Math.abs(v);
  if (abs <= limit) return v;
  const over = abs - limit;
  return Math.sign(v) * (limit + (over * limit * k) / (limit + k * over));
}

function projectToScreen(worldPos, out) {
  out.copy(worldPos).project(camera);
  out.x = (out.x + 1) * 0.5 * innerWidth;
  out.y = (1 - out.y) * 0.5 * innerHeight;
  return out;
}

function hitDeckTarget(clientX, clientY) {
  if (!deckCtrl.stickPivot || !deckCtrl.btnPivot) return null;
  pointerNDC.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointerNDC, camera);
  const hits = raycaster.intersectObjects(
    [deckCtrl.stickCollider, deckCtrl.btnCollider, deckCtrl.stickMesh, deckCtrl.stickBaseMesh, deckCtrl.btnMesh, deckCtrl.btnBezelMesh].filter(Boolean),
    true
  );
  if (hits.length) {
    const obj = hits[0].object;
    if (obj === deckCtrl.btnCollider || obj === deckCtrl.btnMesh || obj === deckCtrl.btnBezelMesh) return 'button';
    return 'stick';
  }
  deckCtrl.stickPivot.getWorldPosition(_vWorldA);
  _vWorldA.y += 0.038;
  projectToScreen(_vWorldA, _vScreenA);
  if (Math.hypot(clientX - _vScreenA.x, clientY - _vScreenA.y) <= 52) return 'stick';

  deckCtrl.btnPivot.getWorldPosition(_vWorldB);
  projectToScreen(_vWorldB, _vScreenB);
  if (Math.hypot(clientX - _vScreenB.x, clientY - _vScreenB.y) <= 48) return 'button';
  return null;
}

function isRevealOrChuteBusy() {
  if (revealState || revealQueue.length) return true;
  if (verseUI.wrap && verseUI.wrap.classList.contains('on')) return true;
  if (verseUI.sheet && verseUI.sheet.classList.contains('on')) return true;
  if (claw && claw.prizes) {
    for (let i = 0; i < claw.prizes.length; i++) {
      if (claw.prizes[i].droppingInChute) return true;
    }
  }
  return false;
}

function triggerPhysicalButton() {
  if (!claw || isRevealOrChuteBusy()) return;
  sfx.press();
  deckCtrl.btnVel = -3.8;
  deckCtrl.btnDepress = Math.max(deckCtrl.btnDepress, 0.72);
  claw.triggerGrabCycle();
}

addEventListener('keydown', (e) => {
  if (isRevealOrChuteBusy()) return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'KeyW', 'KeyS'].includes(e.code)) {
    keys.add(e.code);
    if (claw) claw.takeManualControl();
  } else if (e.code === 'Space' && claw) {
    e.preventDefault();
    triggerPhysicalButton();
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));

// WebAudio unlocks on the first user gesture (Snap webview requirement)
addEventListener('pointerdown', () => prewarmAudio(), { capture: true });
addEventListener('touchend', () => prewarmAudio(), { capture: true });
addEventListener('keydown', () => prewarmAudio(), { capture: true });

canvas.addEventListener('pointerdown', (e) => {
  if (!claw || !deckCtrl.stickPivot || isRevealOrChuteBusy()) return;
  const hit = hitDeckTarget(e.clientX, e.clientY);
  if (!hit) return;
  e.stopPropagation();
  e.preventDefault();
  controls.enabled = false;
  deckCtrl.pointerId = e.pointerId;
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  if (hit === 'stick') {
    claw.takeManualControl();
    deckCtrl.draggingStick = true;
    deckCtrl.grabOriginX = e.clientX;
    deckCtrl.grabOriginY = e.clientY;
    deckCtrl.startStickX = deckCtrl.stickX;
    deckCtrl.startStickZ = deckCtrl.stickZ;
    deckCtrl.targetX = deckCtrl.stickX;
    deckCtrl.targetZ = deckCtrl.stickZ;
    sfx.press();
  } else if (hit === 'button') {
    deckCtrl.pressingBtn = true;
    triggerPhysicalButton();
  }
}, { capture: true });

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== deckCtrl.pointerId || !deckCtrl.draggingStick) return;
  e.stopPropagation();
  e.preventDefault();
  const span = Math.max(38, Math.min(innerWidth, innerHeight) * 0.105);
  const rawX = deckCtrl.startStickX + (e.clientX - deckCtrl.grabOriginX) / span;
  const rawZ = deckCtrl.startStickZ + (e.clientY - deckCtrl.grabOriginY) / span;
  const mag = Math.hypot(rawX, rawZ);
  if (mag > 0.001) {
    const rb = rubberband(mag, 1, 0.45);
    deckCtrl.targetX = (rawX / mag) * rb;
    deckCtrl.targetZ = (rawZ / mag) * rb;
  } else {
    deckCtrl.targetX = 0;
    deckCtrl.targetZ = 0;
  }
  const tickStep = Math.round(Math.hypot(deckCtrl.targetX, deckCtrl.targetZ) * 4);
  if (tickStep !== deckCtrl.lastTickStep) {
    deckCtrl.lastTickStep = tickStep;
    sfx.press();
  }
}, { capture: true });

function endDeckPointer(e) {
  if (e.pointerId !== deckCtrl.pointerId) return;
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
  deckCtrl.draggingStick = false;
  deckCtrl.pressingBtn = false;
  deckCtrl.pointerId = null;
  deckCtrl.targetX = 0;
  deckCtrl.targetZ = 0;
  deckCtrl.lastTickStep = 0;
  controls.enabled = true;
}
canvas.addEventListener('pointerup', endDeckPointer, { capture: true });
canvas.addEventListener('pointercancel', endDeckPointer, { capture: true });

// Floating feedback toast (¡CASI! / ¡PREMIO!)
const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(text, isWin) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.className = isWin ? 'show win' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ''; }, 1300);
}

// Game-feel state: phase-change sfx, hitstop slow-mo, camera shake, near-miss
let lastPhase = 'idle';
let shakeAmp = 0;
let hitstop = 0;
let nearMissDone = false;
const cageWatch = new Set();
const _vTmp = new THREE.Vector3();

function setupCabinetControls(root) {
  const stickMesh = root.getObjectByName('tripo_part_30');
  const stickBaseMesh = root.getObjectByName('tripo_part_62');
  const btnMesh = root.getObjectByName('tripo_part_61');
  const btnBezelMesh = root.getObjectByName('tripo_part_64');
  if (!stickMesh || !btnMesh) return;

  root.updateMatrixWorld(true);
  const wrapAtWorldPivot = (mesh, worldPivot) => {
    const parent = mesh.parent;
    const pivot = new THREE.Group();
    pivot.position.copy(parent.worldToLocal(worldPivot.clone()));
    parent.add(pivot);
    pivot.updateMatrixWorld(true);
    pivot.attach(mesh);
    return pivot;
  };

  if (!stickMesh.geometry.boundingBox) stickMesh.geometry.computeBoundingBox();
  const sBox = stickMesh.geometry.boundingBox.clone().applyMatrix4(stickMesh.matrixWorld);
  const baseBox = stickBaseMesh
    ? (stickBaseMesh.geometry.boundingBox || (stickBaseMesh.geometry.computeBoundingBox(), stickBaseMesh.geometry.boundingBox)).clone().applyMatrix4(stickBaseMesh.matrixWorld)
    : sBox;
  const baseCenterWorld = baseBox.getCenter(new THREE.Vector3());

  // Hide the lumpy AI-scanned stick + base and build a crisp Japanese Sanwa JLF ball-top
  // arcade joystick centered dead-on the control deck
  stickMesh.visible = false;
  if (stickBaseMesh) stickBaseMesh.visible = false;

  const capCenterWorld = new THREE.Vector3(
    baseCenterWorld.x,
    baseBox.min.y + (baseBox.max.y - baseBox.min.y) * 0.58,
    baseCenterWorld.z
  );
  const capGroup = new THREE.Group();
  capGroup.position.copy(capCenterWorld);
  capGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _panelNormal);
  const capMat = new THREE.MeshStandardMaterial({
    color: 0x101217, roughness: 0.28, metalness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.2,
  });
  const capRimMat = new THREE.MeshStandardMaterial({
    color: 0x2c3240, roughness: 0.2, metalness: 0.65,
  });
  const capDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.039, 0.0425, 0.0055, 64), capMat);
  const capLip = new THREE.Mesh(new THREE.TorusGeometry(0.0395, 0.0022, 16, 64), capRimMat);
  capLip.rotation.x = Math.PI / 2;
  capLip.position.y = 0.0026;
  const capWell = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0135, 0.0135, 0.0062, 36),
    new THREE.MeshBasicMaterial({ color: 0x050608 })
  );
  capWell.position.y = 0.0005;
  const pivotDome = new THREE.Mesh(
    new THREE.SphereGeometry(0.0125, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.55),
    capMat
  );
  pivotDome.position.y = 0.001;
  capGroup.add(capDisc, capLip, capWell, pivotDome);
  scene.add(capGroup);

  // World-space joystick assembly: base frame aligned somewhat with panel, stick upright at rest
  const stickPivotWorld = capCenterWorld.clone().addScaledVector(_panelNormal, 0.003);
  const stickPivot = new THREE.Group();
  stickPivot.position.copy(stickPivotWorld);
  scene.add(stickPivot);

  const sleeveMat = new THREE.MeshStandardMaterial({
    color: 0x161922, roughness: 0.32, metalness: 0.4, clearcoat: 0.5,
  });
  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0, roughness: 0.12, metalness: 0.92,
  });
  const ballMat = new THREE.MeshPhysicalMaterial({
    color: 0xd93829,
    roughness: 0.12,
    metalness: 0.04,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    specularIntensity: 1.0,
    emissive: new THREE.Color(0x000000),
  });

  // Lower black shaft sleeve + polished chrome upper shaft + bevel ferrule + glossy ball-top
  const shaftSleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.0068, 0.0082, 0.028, 32), sleeveMat);
  shaftSleeve.position.y = 0.014;
  shaftSleeve.castShadow = true;

  const chromeShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0052, 0.0056, 0.022, 32), chromeMat);
  chromeShaft.position.y = 0.033;
  chromeShaft.castShadow = true;

  const neckFerrule = new THREE.Mesh(new THREE.CylinderGeometry(0.0088, 0.0062, 0.0055, 32), chromeMat);
  neckFerrule.position.y = 0.0435;

  const ballTop = new THREE.Mesh(new THREE.SphereGeometry(0.0265, 48, 36), ballMat);
  ballTop.position.y = 0.066;
  ballTop.castShadow = true;

  // subtle creamy specular ring around the neck base like classic Japanese arcade sticks
  const collarRing = new THREE.Mesh(new THREE.TorusGeometry(0.0072, 0.0012, 12, 32), chromeMat);
  collarRing.rotation.x = Math.PI / 2;
  collarRing.position.y = 0.028;

  stickPivot.add(shaftSleeve, collarRing, chromeShaft, neckFerrule, ballTop);

  if (!btnMesh.geometry.boundingBox) btnMesh.geometry.boundingBox = new THREE.Box3().setFromBufferAttribute(btnMesh.geometry.attributes.position);
  const bBox = btnMesh.geometry.boundingBox.clone().applyMatrix4(btnMesh.matrixWorld);
  const btnCenterWorld = bBox.getCenter(new THREE.Vector3());
  const bezelBox = btnBezelMesh
    ? (btnBezelMesh.geometry.boundingBox || (btnBezelMesh.geometry.computeBoundingBox(), btnBezelMesh.geometry.boundingBox)).clone().applyMatrix4(btnBezelMesh.matrixWorld)
    : bBox;
  const bezelCenterWorld = bezelBox.getCenter(new THREE.Vector3());
  const btnPivot = wrapAtWorldPivot(btnMesh, btnCenterWorld);
  deckCtrl.btnRestY = btnPivot.position.y;
  deckCtrl.btnRestZ = btnPivot.position.z;

  btnMesh.material = btnMesh.material.clone();
  btnMesh.material.roughness = 0.22;
  btnMesh.material.clearcoat = 1.0;
  btnMesh.material.clearcoatRoughness = 0.08;
  btnMesh.material.emissive = new THREE.Color(0x000000);
  if (btnBezelMesh && btnBezelMesh.material) {
    btnBezelMesh.material = btnBezelMesh.material.clone();
    btnBezelMesh.material.emissive = new THREE.Color(0x000000);
  }

  // Dark socket floor recessed well underneath tripo_part_61 so the red cap stays 100% visible when pressed
  const wellMat = new THREE.MeshBasicMaterial({ color: 0x16090d });
  const btnWell = new THREE.Mesh(new THREE.CircleGeometry(0.044, 32), wellMat);
  btnWell.position.copy(bezelCenterWorld).addScaledVector(_panelNormal, -0.012);
  btnWell.quaternion.setFromUnitVectors(_unitZ, _panelNormal);
  scene.add(btnWell);

  // Crisp yellow outline ring hugging tripo_part_61 around the bezel rim when ready,
  // seated directly on the measured bezel crest plane so all 360deg sit flush
  const ringGroup = new THREE.Group();
  const ringCenter = new THREE.Vector3(
    bezelCenterWorld.x,
    bezelBox.min.y + (bezelBox.max.y - bezelBox.min.y) * 0.68,
    bezelCenterWorld.z
  ).addScaledVector(_panelNormal, 0.0025);
  ringGroup.position.copy(ringCenter);
  ringGroup.quaternion.setFromUnitVectors(_unitZ, _panelNormal);
  const haloMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.42, 1.04, 0.04),
    transparent: true,
    opacity: 0.96,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const haloInner = new THREE.Mesh(new THREE.RingGeometry(0.0438, 0.0495, 64), haloMat);
  haloInner.layers.enable(BLOOM_LAYER);
  const haloOuterMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.08, 0.74, 0.02),
    transparent: true,
    opacity: 0.28,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const haloOuter = new THREE.Mesh(new THREE.RingGeometry(0.0492, 0.0548, 64), haloOuterMat);
  haloOuter.position.z = -0.0005;
  haloOuter.layers.enable(BLOOM_LAYER);
  ringGroup.add(haloInner, haloOuter);
  scene.add(ringGroup);

  // Invisible fat touch colliders so thumb grabs are forgiving on mobile
  const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
  const stickCollider = new THREE.Mesh(new THREE.SphereGeometry(0.078, 12, 10), hitMat);
  stickCollider.position.copy(stickPivotWorld).y += 0.038;
  const btnCollider = new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.078, 0.065, 16), hitMat);
  btnCollider.position.copy(btnCenterWorld);
  btnCollider.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _panelNormal);
  scene.add(stickCollider, btnCollider);

  Object.assign(deckCtrl, {
    stickMesh: ballTop,
    stickBaseMesh: capDisc,
    stickPivot,
    stickCollider,
    btnMesh,
    btnBezelMesh,
    btnPivot,
    btnCollider,
    btnHalo: haloInner,
    btnHaloOuter: haloOuter,
    btnLight: null,
  });
  window.__deck = deckCtrl;
}

function updateCabinetControls(dt) {
  if (!deckCtrl.stickPivot || !deckCtrl.btnPivot || !claw) return;

  let keyX = 0, keyZ = 0;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) keyX -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) keyX += 1;
  if (keys.has('ArrowUp') || keys.has('KeyW')) keyZ -= 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) keyZ += 1;
  if (keyX || keyZ) {
    const l = Math.hypot(keyX, keyZ);
    keyX /= l;
    keyZ /= l;
  }

  let goalX = deckCtrl.draggingStick ? deckCtrl.targetX : keyX;
  let goalZ = deckCtrl.draggingStick ? deckCtrl.targetZ : keyZ;
  if (!deckCtrl.draggingStick && !keyX && !keyZ && claw.autoDemo && claw.phase === 'idle') {
    const errX = THREE.MathUtils.clamp((claw.targetTX - claw.anim.smoothTX) * 1.9, -0.75, 0.75);
    const errZ = THREE.MathUtils.clamp((claw.targetTZ - claw.anim.smoothTZ) * 1.9, -0.75, 0.75);
    goalX = errX;
    goalZ = errZ;
  }

  // Under-damped spring on release so the ball-top stick snaps back like an arcade microswitch lever
  const k = deckCtrl.draggingStick ? 190 : 150;
  const damp = deckCtrl.draggingStick ? 24 : 15;
  deckCtrl.stickVX += (goalX - deckCtrl.stickX) * k * dt;
  deckCtrl.stickVZ += (goalZ - deckCtrl.stickZ) * k * dt;
  const decay = Math.exp(-damp * dt);
  deckCtrl.stickVX *= decay;
  deckCtrl.stickVZ *= decay;
  deckCtrl.stickX += deckCtrl.stickVX * dt;
  deckCtrl.stickZ += deckCtrl.stickVZ * dt;

  const maxAngle = 0.42;
  deckCtrl.stickPivot.rotation.set(deckCtrl.stickZ * maxAngle, 0, -deckCtrl.stickX * maxAngle);
  const busyReveal = isRevealOrChuteBusy();
  const canPress = claw.phase === 'idle' && !busyReveal;
  if (deckCtrl.stickMesh.material && deckCtrl.stickMesh.material.emissive) {
    const tiltGlow = busyReveal ? 0 : Math.min(1, Math.hypot(deckCtrl.stickX, deckCtrl.stickZ));
    // Invite the thumb without a word: the ball-top breathes a faint gold ember while the claw waits
    const idle = (canPress && !deckCtrl.draggingStick)
      ? (0.5 + 0.5 * Math.sin(neonT * 1.6)) * 0.09 : 0;
    deckCtrl.stickMesh.material.emissive.setRGB(0.32 * tiltGlow + idle, 0.05 * tiltGlow + idle * 0.72, 0.14 * tiltGlow + idle * 0.10);
  }

  // Drive gantry continuously while player tilts the 3D stick or holds keys
  const driveX = deckCtrl.draggingStick ? THREE.MathUtils.clamp(deckCtrl.stickX, -1, 1) : keyX;
  const driveZ = deckCtrl.draggingStick ? THREE.MathUtils.clamp(deckCtrl.stickZ, -1, 1) : keyZ;
  if (!busyReveal && (Math.abs(driveX) > 0.04 || Math.abs(driveZ) > 0.04) && claw.phase === 'idle') {
    claw.nudgeGantry(driveX * 1.18 * dt, driveZ * 1.18 * dt);
  }

  // Button spring & yellow readiness highlight around tripo_part_61
  const targetDepress = deckCtrl.pressingBtn || (claw.phase === 'descending' && claw.phaseTimer < 0.25) ? 1 : 0;
  deckCtrl.btnVel += (targetDepress - deckCtrl.btnDepress) * 210 * dt;
  deckCtrl.btnVel *= Math.exp(-18 * dt);
  deckCtrl.btnDepress = THREE.MathUtils.clamp(deckCtrl.btnDepress + deckCtrl.btnVel * dt, 0, 1.15);

  const pressWorld = 0.0046 * deckCtrl.btnDepress;
  const parentScale = deckCtrl.btnPivot.parent ? deckCtrl.btnPivot.parent.scale.y || 1.832 : 1.832;
  const localShift = pressWorld / parentScale;
  deckCtrl.btnPivot.position.y = deckCtrl.btnRestY - localShift * _panelNormal.y;
  deckCtrl.btnPivot.position.z = deckCtrl.btnRestZ - localShift * _panelNormal.z;

  const pulse = 0.5 + 0.5 * Math.sin(neonT * 6.2);
  if (canPress) {
    deckCtrl.btnHalo.visible = true;
    deckCtrl.btnHaloOuter.visible = true;
    deckCtrl.btnHalo.material.opacity = 0.84 + pulse * 0.16;
    deckCtrl.btnHaloOuter.material.opacity = 0.20 + pulse * 0.16;
    const s = 1 + pulse * 0.04;
    deckCtrl.btnHaloOuter.scale.setScalar(s);
    deckCtrl.btnMesh.material.emissive.setRGB(0, 0, 0);
    if (deckCtrl.btnBezelMesh && deckCtrl.btnBezelMesh.material.emissive) {
      deckCtrl.btnBezelMesh.material.emissive.setRGB(0.22 + pulse * 0.18, 0.15 + pulse * 0.12, 0.01);
    }
  } else {
    deckCtrl.btnHalo.visible = false;
    deckCtrl.btnHaloOuter.visible = false;
    deckCtrl.btnMesh.material.emissive.setRGB(0, 0, 0);
    if (deckCtrl.btnBezelMesh && deckCtrl.btnBezelMesh.material.emissive) {
      deckCtrl.btnBezelMesh.material.emissive.setRGB(0, 0, 0);
    }
  }
}

// ---------- Verse reveal: the ball flies out, splits, a folded paper opens ----------
const verseUI = {
  wrap: document.getElementById('verse-reveal'),
  text: document.getElementById('verse-text'),
  ref: document.getElementById('verse-ref'),
  share: document.getElementById('verse-share'),
  read: document.getElementById('verse-read'),
  close: document.getElementById('verse-close'),
  sheet: document.getElementById('chapter-sheet'),
  sheetTitle: document.getElementById('chapter-title'),
  sheetBody: document.getElementById('chapter-body'),
  sheetBack: document.getElementById('chapter-back'),
};
let versePool = null;          // [{ i, r, t }] ranked-by-substance pool
let revealState = null;        // active ball→paper sequence
const revealQueue = [];        // wins queue up; they reveal one at a time
let giftHalvesProto = null;    // { leftGeo, rightGeo } loaded from sphereLeft.glb + sphereRight.glb
let machineBuilt = false;
let sceneCompiled = false;

// Pre-allocated reveal capsule rig — kept in scene from boot so winning or splitting
// the sphere allocates 0 materials/geometries/lights and triggers 0 shader recompiles.
const revealRig = (() => {
  const r = 0.16;
  const fallbackGeo = new THREE.SphereGeometry(1, 28, 16, 0, Math.PI, 0, Math.PI);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xfbbf24, roughness: 0.22, metalness: 0.12, side: THREE.DoubleSide, transparent: true, opacity: 1,
  });
  const innerMat = new THREE.MeshStandardMaterial({
    color: 0xffe4a3, emissive: 0xffb347, emissiveIntensity: 0.08,
    roughness: 0.32, metalness: 0.05, side: THREE.DoubleSide, transparent: true, opacity: 1,
  });
  const coreGeo = new THREE.SphereGeometry(r * 0.52, 20, 16);
  const coreMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(2.4, 1.85, 0.82),
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const grp = new THREE.Group();
  grp.visible = false;
  const ballRig = new THREE.Group();
  grp.add(ballRig);

  const hA = new THREE.Group();
  const meshA = new THREE.Mesh(fallbackGeo, [mat, innerMat]);
  meshA.scale.setScalar(r);
  meshA.rotation.y = -Math.PI / 2;
  meshA.frustumCulled = false;
  meshA.renderOrder = 6;
  hA.add(meshA);

  const hB = new THREE.Group();
  const meshB = new THREE.Mesh(fallbackGeo, [mat, innerMat]);
  meshB.scale.setScalar(r);
  meshB.rotation.y = Math.PI / 2;
  meshB.frustumCulled = false;
  meshB.renderOrder = 6;
  hB.add(meshB);

  ballRig.add(hA, hB);

  const coreMesh = new THREE.Mesh(coreGeo, coreMat);
  coreMesh.layers.enable(BLOOM_LAYER);
  coreMesh.visible = false;
  coreMesh.frustumCulled = false;
  grp.add(coreMesh);

  scene.add(grp);
  return { r, grp, ballRig, hA, hB, meshA, meshB, coreMesh, mat, innerMat, coreMat, fallbackGeo };
})();

// Split a solidified hemisphere BufferGeometry into two material groups:
// group 0 = outer shell + rim (rAvg >= 0.955), group 1 = concave inner wall (rAvg < 0.955),
// and smooth normals across curved faces while keeping the ~90deg lip edge crisp.
function splitShellGroups(srcGeo) {
  const geo = srcGeo.index ? srcGeo.clone() : srcGeo;
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  // Crease-aware normal smoothing: average normals of coincident vertices whose face
  // normals agree within ~50deg (cos > 0.64), so the spherical dome and concave bowl
  // become silky smooth while the flat lip rim stays sharp.
  if (nrm) {
    const buckets = new Map();
    for (let i = 0; i < pos.count; i++) {
      const k = `${Math.round(pos.getX(i) * 2000)},${Math.round(pos.getY(i) * 2000)},${Math.round(pos.getZ(i) * 2000)}`;
      let b = buckets.get(k);
      if (!b) { b = []; buckets.set(k, b); }
      b.push(i);
    }
    const out = new Float32Array(nrm.array.length);
    for (const b of buckets.values()) {
      for (const i of b) {
        const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
        let sx = 0, sy = 0, sz = 0;
        for (const j of b) {
          const jx = nrm.getX(j), jy = nrm.getY(j), jz = nrm.getZ(j);
          if (nx * jx + ny * jy + nz * jz > 0.64) { sx += jx; sy += jy; sz += jz; }
        }
        const len = Math.hypot(sx, sy, sz) || 1;
        out[i * 3] = sx / len; out[i * 3 + 1] = sy / len; out[i * 3 + 2] = sz / len;
      }
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  }
  const idx = geo.index.array;
  const outerTris = [];
  const innerTris = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    const ra = Math.hypot(pos.getX(a), pos.getY(a), pos.getZ(a));
    const rb = Math.hypot(pos.getX(b), pos.getY(b), pos.getZ(b));
    const rc = Math.hypot(pos.getX(c), pos.getY(c), pos.getZ(c));
    if ((ra + rb + rc) / 3 < 0.955) innerTris.push(a, b, c);
    else outerTris.push(a, b, c);
  }
  const reordered = new (idx.constructor)(outerTris.length + innerTris.length);
  reordered.set(outerTris, 0);
  reordered.set(innerTris, outerTris.length);
  geo.setIndex(new THREE.BufferAttribute(reordered, 1));
  geo.clearGroups();
  geo.addGroup(0, outerTris.length, 0);
  geo.addGroup(outerTris.length, innerTris.length, 1);
  return geo;
}
let bibleLines = null;         // lazy: full 31,102-verse text for KEEP READING
let bibleLinesLang = null;

async function unpackBinText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const u8 = new Uint8Array(await res.arrayBuffer());
  for (let i = 0; i < u8.length; i++) u8[i] ^= 0x5a;
  return new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
}

// ---------- Languages: the flag comes before everything ----------
const I18N = {
  en: { welcome: 'Welcome', pick: 'CHOOSE YOUR LANGUAGE', enter: 'TAP TO ENTER', share: 'SHARE IT', read: 'KEEP READING', back: 'BACK TO THE MACHINE', trans: 'BSB' },
  es: { welcome: 'Bienvenido', pick: 'ELIGE TU IDIOMA', enter: 'TOCA PARA ENTRAR', share: 'COMPÁRTELO', read: 'SEGUIR LEYENDO', back: 'VOLVER A LA MÁQUINA', trans: 'VBL' },
  pt: { welcome: 'Bem-vindo', pick: 'ESCOLHA SEU IDIOMA', enter: 'TOQUE PARA ENTRAR', share: 'COMPARTILHAR', read: 'CONTINUAR LENDO', back: 'VOLTAR À MÁQUINA', trans: 'BLIVRE' },
  de: { welcome: 'Willkommen', pick: 'WÄHLE DEINE SPRACHE', enter: 'TIPPEN ZUM STARTEN', share: 'TEILEN', read: 'WEITERLESEN', back: 'ZURÜCK ZUR MASCHINE', trans: 'LUTHER 1912' },
  it: { welcome: 'Benvenuto', pick: 'SCEGLI LA TUA LINGUA', enter: 'TOCCA PER ENTRARE', share: 'CONDIVIDI', read: 'CONTINUA A LEGGERE', back: 'TORNA ALLA MACCHINA', trans: 'RIVEDUTA 1927' },
};
const FULL_BIBLE_LANGS = new Set(['en', 'es']);
let lang = window.__pendingLang || 'en';
if (!I18N[lang]) lang = 'en';
let versesPromise = null;
let entered = false;

const enterUI = {
  screen: document.getElementById('enter-screen'),
  verse: document.getElementById('enter-verse'),
  ref: document.getElementById('enter-ref'),
  btn: document.getElementById('enter-btn'),
};

function applyStrings() {
  const s = I18N[lang];
  enterUI.verse.textContent = s.welcome;
  enterUI.ref.textContent = s.pick;
  enterUI.btn.textContent = s.enter;
  verseUI.share.textContent = s.share;
  verseUI.read.textContent = s.read;
  verseUI.sheetBack.textContent = s.back;
  document.querySelectorAll('#enter-langs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === lang);
  });
}

function loadLangPool(l) {
  lang = l;
  applyStrings();
  // Don't steal bandwidth from the cabinet download — the pool fetches right after it.
  const gate = (window.__cabinetBuf || Promise.resolve()).catch(() => {});
  versesPromise = gate
    .then(() => unpackBinText(`./assets/verses-${l}.bin`))
    .then((txt) => (txt ? JSON.parse(txt) : null))
    .catch(() => null);
  versesPromise.then((d) => {
    if (!d?.verses?.length || l !== lang) return;
    versePool = d.verses;
    if (claw) claw.setVerseDeck(shuffledDeck(versePool.length));
  });
}

// Outside Snapchat there is no bottom chrome — UI may rest in the dark zone
if (!(window.webkit?.messageHandlers?.snapWebLensBridge || window.snapWebLensBridge)) {
  document.body.classList.add('no-snap');
}

// The sealed letter is the chosen material — ?reveal=X still previews other variants
const revealParam = (new URLSearchParams(location.search).get('reveal') || '').toLowerCase();
const revealStyle = revealParam || 'carta';
if (revealStyle !== 'pergamino') document.getElementById('verse-paper')?.classList.add(`reveal-${revealStyle}`);

document.querySelectorAll('#enter-langs button').forEach((b) => {
  b.addEventListener('click', () => { if (b.dataset.lang !== lang) loadLangPool(b.dataset.lang); });
});
function enterGameNow() {
  if (entered) return;
  entered = true;
  perfMark('enter-tap');
  initAudio();
  enterUI.screen.classList.add('off');
  maybeCompileAndFinishLoading();
}
enterUI.btn.addEventListener('click', enterGameNow);
if (window.__pendingEnter) enterGameNow();
loadLangPool(lang);

function shuffledDeck(n) {
  const d = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function startVerseReveal(pr) {
  if (!versePool) { triggerWinLight(); return; }
  // Freeze the claw in the background as soon as the prize reveal starts
  if (claw) {
    claw.autoDemo = false;
    claw.phase = 'idle';
    claw.phaseTimer = 0;
    claw.targetTX = claw.anim.smoothTX;
    claw.targetTZ = claw.anim.smoothTZ;
    claw.targetDrop = 0.48;
  }
  const v = pr.verseIdx >= 0 ? versePool[pr.verseIdx] : null;
  // sample the caught prize's color for the capsule it becomes
  let hex = 0xfbbf24;
  pr.mesh.traverse((o) => {
    if (o.isMesh && o.material && o.material.color && o.material.color.getHex() !== 0x111827) {
      hex = o.material.color.getHex();
    }
  });
  const { r, grp, ballRig, hA, hB, coreMesh, mat, innerMat, coreMat } = revealRig;
  mat.color.setHex(hex);
  mat.opacity = 1;
  innerMat.opacity = 1;
  innerMat.emissiveIntensity = 0.08;
  coreMat.opacity = 0;
  coreMesh.visible = false;
  coreMesh.scale.setScalar(0.6);
  ballRig.rotation.set(0, 0, 0);
  hA.position.set(0, 0, 0);
  hB.position.set(0, 0, 0);
  hA.rotation.set(0, 0, 0);
  hB.rotation.set(0, 0, 0);

  // Spawn at the actual PRIZE OUT door on the lower-left front panel (tripo_part_33),
  // pulled slightly forward in Z so the ball sits visibly in the doorway.
  const door = machine && (machine.getObjectByName('tripo_part_33') || machine.getObjectByName('tripo_part_20'));
  if (door) {
    door.getWorldPosition(_vTmp);
    _vTmp.z += 0.08;
    grp.position.copy(_vTmp);
  } else {
    grp.position.set(-0.15, 0.29, 0.42);
  }
  grp.scale.setScalar(0.5);
  grp.visible = true;
  // target: center of the screen, floating between camera and cabinet
  const dir = controls.target.clone().sub(camera.position).normalize();
  const target = camera.position.clone().add(dir.multiplyScalar(camera.position.distanceTo(controls.target) * 0.52));
  target.y += 0.1;
  revealState = {
    t: 0, grp, ballRig, mat, innerMat, coreMesh, coreMat, verse: v, r,
    from: grp.position.clone(),
    // storyboard: pop UP out of the doorway first, then travel to center
    rise: grp.position.clone().add(new THREE.Vector3(0.04, 0.28, 0.12)),
    target,
    split: false, splitT: 0, opened: false, halves: [hA, hB],
  };
  setMusicMode('attract');
  triggerWinLight();
  shakeAmp = Math.max(shakeAmp, 0.028);
}

function splitVerseBall(R) {
  R.split = true;
  R.splitT = R.t;
  R.ballRig.rotation.set(0, 0, 0);
  // Warm light core inside the capsule — pre-compiled on BLOOM_LAYER so 0 shader recompilation occurs
  R.coreMesh.visible = true;
  R.coreMesh.scale.setScalar(0.6);
  R.coreMat.opacity = 0.95;
  sfx.chime();
}

function openVerseCard(v) {
  verseUI.text.textContent = v ? `\u201C${v.t}\u201D` : '';
  verseUI.ref.textContent = v ? v.r.toUpperCase() : '';
  verseUI.wrap.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => verseUI.wrap.classList.add('open')));
  // The paper finishes speaking, then the arcade goes silent — the Word stays
  setTimeout(() => { if (verseUI.wrap.classList.contains('open')) duckAudio(true); }, 950);
}

function closeVerseCard() {
  verseUI.sheet.classList.remove('on');
  verseUI.wrap.classList.remove('open');
  duckAudio(false);
  setTimeout(() => {
    verseUI.wrap.classList.remove('on');
    if (revealState) {
      revealState.grp.visible = false;
      revealState.coreMesh.visible = false;
      revealState = null;
    }
  }, 380);
}

async function shareCurrentVerse() {
  const v = revealState && revealState.verse;
  if (!v) return;
  const payload = `\u201C${v.t}\u201D \u2014 ${v.r}`;
  try {
    if (navigator.share) {
      await navigator.share({ text: payload });
      return;
    }
  } catch { return; }
  try {
    await navigator.clipboard.writeText(payload);
    showToast('VERSE COPIED \u2014 SEND IT', true);
  } catch {
    showToast('SHARE IT \u2014 ' + v.r.toUpperCase(), true);
  }
}

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

let suppressChapterScroll = false;

async function openChapter(v) {
  if (!v) return;
  const bibleLang = FULL_BIBLE_LANGS.has(lang) ? lang : 'en';
  if (!bibleLines || bibleLinesLang !== bibleLang) {
    const txt = await unpackBinText(`./assets/bible-${bibleLang}.bin`);
    if (!txt) return;
    bibleLines = txt.split('\n');
    bibleLinesLang = bibleLang;
  }
  const ref = bibleLines[v.i].split('\t')[0];            // "Jeremiah 29:11"
  const chapKey = ref.slice(0, ref.lastIndexOf(':'));    // "Jeremiah 29"
  let a = v.i, b = v.i;
  while (a > 0 && bibleLines[a - 1].startsWith(chapKey + ':')) a--;
  while (b < bibleLines.length - 1 && bibleLines[b + 1].startsWith(chapKey + ':')) b++;
  verseUI.sheetTitle.textContent = chapKey.toUpperCase();
  verseUI.sheetBody.innerHTML = bibleLines.slice(a, b + 1).map((ln, k) => {
    const [r, t] = ln.split('\t');
    const vn = r.slice(r.lastIndexOf(':') + 1);
    const gi = a + k;
    const cls = gi === v.i ? ' won' : ' veiled';
    return `<div class="ch-verse${cls}"><span class="vn">${vn}</span>${esc(t || '')}</div>`;
  }).join('');
  suppressChapterScroll = true;
  verseUI.sheet.classList.add('on');
  verseUI.sheetBody.scrollTop = 0;
  requestAnimationFrame(() => {
    const body = verseUI.sheetBody;
    const bodyRect = body.getBoundingClientRect();
    const versesEls = [...body.querySelectorAll('.ch-verse')];
    const won = body.querySelector('.won');
    const lastEl = versesEls[versesEls.length - 1];
    if (won && lastEl) {
      const wonTop = won.getBoundingClientRect().top - bodyRect.top + body.scrollTop;
      const lastBottom = lastEl.getBoundingClientRect().bottom - bodyRect.top + body.scrollTop;
      const desired = Math.max(0, wonTop - body.clientHeight * 0.14);
      // Clamp initial scroll so the last verses always extend all the way down behind the back button
      const maxInitial = Math.max(0, lastBottom - body.clientHeight * 0.96);
      body.scrollTop = Math.min(desired, maxInitial);
    }
    requestAnimationFrame(() => {
      const top0 = body.getBoundingClientRect().top;
      const clearEdge = top0 + body.clientHeight * 0.56;
      versesEls.forEach((el, idx) => {
        const r = el.getBoundingClientRect();
        // Keep the last visible verses in the lower zone veiled on initial open so the
        // dark + blur scroll cue is always present right from the start
        const isLastTwo = idx >= versesEls.length - 2 && versesEls.length > 3;
        if (r.bottom > top0 + 6 && r.top < clearEdge && (!isLastTwo || el.classList.contains('won'))) {
          el.classList.remove('veiled');
        }
      });
      setTimeout(() => { suppressChapterScroll = false; }, 120);
    });
  });
}

// A verse unveils as it rises into the reading window — discovery, not a wall of text
function unveilVisible() {
  const body = verseUI.sheetBody;
  const bodyTop = body.getBoundingClientRect().top;
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 28;
  const edge = bodyTop + body.clientHeight * (atBottom ? 0.92 : 0.62);
  body.querySelectorAll('.ch-verse.veiled').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.top < edge && r.bottom > bodyTop) el.classList.remove('veiled');
  });
}
let unveilTick = false;
verseUI.sheetBody.addEventListener('scroll', () => {
  if (suppressChapterScroll || unveilTick) return;
  unveilTick = true;
  requestAnimationFrame(() => { unveilTick = false; unveilVisible(); });
}, { passive: true });

verseUI.share.addEventListener('click', shareCurrentVerse);
verseUI.read.addEventListener('click', () => openChapter(revealState && revealState.verse));
verseUI.close.addEventListener('click', closeVerseCard);
verseUI.sheetBack.addEventListener('click', () => verseUI.sheet.classList.remove('on'));

function updateVerseReveal(dt) {
  if (!revealState && revealQueue.length && claw) startVerseReveal(revealQueue.shift());
  const R = revealState;
  if (!R) return;
  R.t += dt;
  const easeOut = (x) => 1 - Math.pow(1 - x, 3);
  if (!R.split) {
    // Timeline before split:
    //   0.00..1.50s — panels 1-2: visible inside the lower-left PRIZE OUT doorway
    //   1.50..2.45s — panels 3-4: rises out of the doorway and flies to center
    //   2.45..3.45s — panel 5:    waits 1.0s in front with the real Blender seam facing camera
    if (R.t < 1.5) {
      const w = R.t / 1.5;
      R.grp.position.copy(R.from);
      R.grp.position.y += Math.sin(w * Math.PI * 2) * 0.012;
      R.grp.scale.setScalar(0.5 + 0.08 * Math.sin(w * Math.PI));
      R.ballRig.rotation.y = Math.sin(w * Math.PI * 2) * 0.35;
    } else if (R.t < 2.45) {
      const k = (R.t - 1.5) / 0.95;
      if (k < 0.36) {
        R.grp.position.lerpVectors(R.from, R.rise, easeOut(k / 0.36));
      } else {
        R.grp.position.lerpVectors(R.rise, R.target, easeOut((k - 0.36) / 0.64));
      }
      R.ballRig.rotation.y = (1 - easeOut(k)) * Math.PI * 2; // settles at 0 -> vertical seam
      R.ballRig.rotation.x = Math.sin(k * Math.PI) * 0.35;
      R.grp.scale.setScalar(0.5 + 0.95 * easeOut(k));
    } else {
      const h = (R.t - 2.45) / 1.0; // 0..1 over the 1.0s front hold
      R.grp.position.copy(R.target);
      // subtle anticipation tremor + hair-line gap in the last 0.35s before cracking open
      const trem = h > 0.65 ? (h - 0.65) / 0.35 : 0;
      R.grp.position.x += Math.sin(R.t * 55) * 0.005 * trem;
      R.ballRig.rotation.set(0, 0, 0); // seam dead-vertical facing camera (panel 5)
      R.halves[0].position.x = -trem * 0.012;
      R.halves[1].position.x = trem * 0.012;
      R.innerMat.emissiveIntensity = 0.08 + trem * 0.45;
      R.grp.scale.setScalar(1.45 + 0.05 * Math.sin(h * Math.PI));
      if (R.t >= 3.45) splitVerseBall(R);
    }
  } else {
    const k = Math.min(1, (R.t - R.splitT) / 1.35);
    const [hA, hB] = R.halves;
    // panel 6: the two solidified Blender bowls part left/right and yaw open toward
    // camera (+Z) so you clearly see their concave inner walls + golden light inside
    const part = easeOut(Math.min(1, k / 0.45));
    // panel 7: then both bowls tumble downward while the light expands into the letter
    const drop = Math.max(0, (k - 0.42) / 0.58);
    hA.position.set(-part * 0.24 - drop * 0.10, -drop * drop * 1.05, 0);
    hB.position.set(part * 0.24 + drop * 0.10, -drop * drop * 1.05, 0);
    // left bowl's concave mouth faces +X -> negative Y rotation turns it toward +Z (camera)
    hA.rotation.y = -part * 0.68;
    hB.rotation.y = part * 0.68;
    hA.rotation.z = part * 0.16 + drop * 1.25;
    hB.rotation.z = -part * 0.16 - drop * 1.25;
    const op = 1 - drop * drop;
    R.mat.opacity = op;
    if (R.innerMat) {
      R.innerMat.opacity = op;
      R.innerMat.emissiveIntensity = 0.65 * (1 - drop * 0.5);
    }
    if (R.coreMesh) {
      const ck = Math.sin(Math.min(1, k * 1.35) * Math.PI);
      R.coreMesh.scale.setScalar(0.6 + part * 1.35);
      R.coreMat.opacity = ck * 0.95;
    }
    pitWarm.intensity = Math.max(pitWarm.intensity, Math.sin(Math.min(1, k * 1.4) * Math.PI) * 2.2);
    // the letter opens out of that burst of light while the two concave bowls drop away
    if (!R.opened && R.t - R.splitT > 0.52) {
      R.opened = true;
      openVerseCard(R.verse);
      sfx.paper();
    }
    if (k >= 1) {
      R.grp.visible = false;
      R.coreMesh.visible = false;
    }
  }
}

function maybeCompileAndFinishLoading() {
  if (!machineBuilt || !entered || sceneCompiled) return;
  // Wait 2 rAFs so #enter-screen.off fades out and #loading ("LOADING…") paints first
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (sceneCompiled) return;
      // Pre-warm every effect mesh & reveal half so 0 shaders compile during gameplay or win reveal
      shaft.visible = true;
      dust.visible = true;
      confetti.visible = true;
      for (const s of topStrips) s.visible = true;
      revealRig.grp.visible = true;
      revealRig.coreMesh.visible = true;
      revealRig.grp.position.copy(controls.target);
      revealRig.grp.scale.setScalar(0.0001);

      if (noPostFx) {
        renderer.shadowMap.needsUpdate = true;
        renderer.render(scene, camera);
      } else {
        if (!window.__nobloom) {
          darkenNonBloomed();
          bloomComposer.render();
          restoreMaterials();
        }
        renderer.shadowMap.needsUpdate = true;
        finalComposer.render();
      }

      if (!revealState) {
        revealRig.grp.visible = false;
        revealRig.coreMesh.visible = false;
      }
      if (winLightLife <= 0) {
        shaft.visible = false;
        dust.visible = false;
        for (const s of topStrips) s.visible = false;
      }
      if (confettiLife <= 0) confetti.visible = false;

      sceneCompiled = true;
      clock.getDelta();
      loadBar.style.width = '100%';
      perfMark('machine-ready');
      loadingEl.classList.add('done');
    });
  });
}

const variant = location.search.includes('hq') ? 'hq' : location.search.includes('low') ? 'low' : 'rig';
const files = variant === 'rig'
  ? ['./assets/cabinet.min.glb']
  : [variant === 'hq' ? './assets/claw-machine-hq.min.glb' : './assets/claw-machine.min.glb'];

// The index.html bootstrap already fetched the cabinet into an ArrayBuffer (with real
// progress on the loading bar) — parse that instead of asking the network again.
const gltfPromise = (variant === 'rig' && window.__cabinetBuf)
  ? window.__cabinetBuf
      .then((buf) => loader.parseAsync(buf, ''))
      .then((g) => { perfMark('glb-parsed'); if (loadBar) loadBar.style.width = '90%'; return [g]; },
            () => loader.loadAsync(files[0]).then((g) => [g]))
  : Promise.all(files.map((f) => loader.loadAsync(f)));

const giftHalvesPromise = Promise.all([
  loader.loadAsync('./assets/sphereLeft.glb'),
  loader.loadAsync('./assets/sphereRight.glb'),
]).then(([glL, glR]) => {
  let leftGeo = null, rightGeo = null;
  glL.scene.traverse((o) => { if (o.isMesh && !leftGeo) leftGeo = splitShellGroups(o.geometry); });
  glR.scene.traverse((o) => { if (o.isMesh && !rightGeo) rightGeo = splitShellGroups(o.geometry); });
  if (leftGeo && rightGeo) {
    giftHalvesProto = { leftGeo, rightGeo };
    revealRig.meshA.geometry = leftGeo;
    revealRig.meshB.geometry = rightGeo;
  }
}).catch(() => {});

Promise.all([gltfPromise, giftHalvesPromise]).then(([gltfs]) => {
  machine = new THREE.Group();
  for (const g of gltfs) machine.add(g.scene);

  // Normalize: feet on y=0, centered on XZ, sane world size (~1.8 units tall)
  const box = new THREE.Box3().setFromObject(machine);
  const size = box.getSize(new THREE.Vector3());
  const scale = 1.8 / size.y;
  machine.scale.setScalar(scale);
  box.setFromObject(machine);
  const center = box.getCenter(new THREE.Vector3());
  machine.position.x -= center.x;
  machine.position.z -= center.z;
  machine.position.y -= box.min.y;
  box.setFromObject(machine);
  size.copy(box.getSize(new THREE.Vector3()));
  center.copy(box.getCenter(new THREE.Vector3()));

  machine.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.material) {
        const isGlass = /vidrio/i.test(o.material.name || '');
        const isBuzon = /buzon/i.test(o.material.name || '') || /buzon/i.test(o.name || '');
        o.material.side = isGlass ? THREE.DoubleSide : THREE.FrontSide;
        // Flat outer glass panes use crisp full-res alpha + clearcoat reflections instead of the
        // half-res transmission backbuffer (which pixelated & magnified the 360 skybox behind them).
        if ('transmission' in o.material && (!isGlass || !isBuzon)) o.material.transmission = 0;
        if (isGlass) {
          o.material.transparent = true;
          o.material.depthWrite = false;
          // Crystal-clear vitrine panes without point-light pinpricks on the glass
          o.material.opacity = isBuzon ? 0.22 : 0.04;
          o.material.metalness = 0;
          o.material.roughness = isBuzon ? 0.14 : 0.25;
          o.material.clearcoat = isBuzon ? 0.9 : 0.25;
          o.material.clearcoatRoughness = 0.35;
          o.material.specularIntensity = isBuzon ? 0.8 : 0.2;
          o.material.envMapIntensity = isBuzon ? 1.1 : 0.45;
          o.material.ior = 1.5;
          o.material.color.setHex(isBuzon ? 0xffffff : 0x0b0e18);
          if ('attenuationColor' in o.material) o.material.attenuationColor.setRGB(1, 1, 1);
          if ('specularColor' in o.material) o.material.specularColor.setRGB(1, 1, 1);
        }
        o.material.needsUpdate = true;
      }
    }
  });

  scene.add(machine);

  // Rig handles (world coords preserved by the Blender export + coiled spring + prize pit)
  claw = new ClawRig(machine, scene);
  setupCabinetControls(machine);
  // everything exists now (including revealRig): bake the selective-bloom mask once
  rebuildBloomMask();
  if (versePool) claw.setVerseDeck(shuffledDeck(versePool.length));
  claw.onPrizeWon = (count, pr) => {
    if (scoreEl) scoreEl.textContent = `PRIZES: ${count}`;
    // The caught ball becomes a capsule that flies out and reveals its verse.
    revealQueue.push(pr);
    shakeAmp = Math.max(shakeAmp, 0.03);
  };
  window.claw = claw; // console/probe access
  window.__cam = camera; window.__ctrl = controls; // test probes

  window.__verse = {
    pool: () => versePool,
    state: () => revealState,
    // debug: push a fake win carrying pool index i (default random prize)
    test(i = 0) {
      const go = () => {
        const pr = claw.prizes.find((p) => p.verseIdx >= 0) || claw.prizes[0];
        revealQueue.push({ ...pr, verseIdx: i });
      };
      // Wait for both verse pool and gift-sphere GLBs so the preview always uses the real model
      Promise.all([versesPromise, giftHalvesPromise]).then(go, go);
    },
  };
  // material-variant preview: skip the flag, run the ball→object→open sequence
  if (revealParam) setTimeout(() => {
    enterUI.btn.click();
    setTimeout(() => window.__verse.test(8), 1400);
  }, 500);

  // Frame the cabinet straight-on in the arcade room like the reference composition,
  // keeping the physical joystick + tripo_part_61 button above Snapchat's Lens carousel
  function frameCabinetForViewport() {
    const ar = innerHeight / Math.max(1, innerWidth);
    const shortPhone = ar < 1.95;
    const targetY = center.y * (shortPhone ? 0.86 : 0.90);
    const fitH = size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
    const fitW = size.x / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * camera.aspect);
    const dist = Math.max(fitH, fitW) * (shortPhone ? skyCfg.camDistMul * 1.04 : skyCfg.camDistMul);
    controls.target.set(0, targetY, 0);
    camera.position.set(0, targetY + dist * 0.045, dist);
    controls.minDistance = dist * 0.45;
    controls.maxDistance = dist * 1.9;
    controls.update();
  }
  window.__reframeCabinet = frameCabinetForViewport;
  frameCabinetForViewport();
  glow.scale.setScalar(Math.max(size.x, size.z) * 0.96);
  glow2.scale.setScalar(Math.max(size.x, size.z) * 0.96);

  machineBuilt = true;
  perfMark('machine-built');
  maybeCompileAndFinishLoading();
}).catch((err) => {
  console.error('GLB load failed:', err);
  loadingEl.firstElementChild.textContent = 'LOAD ERROR';
});

// ---------- resize ----------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.fov = portraitFov();
  camera.updateProjectionMatrix();
  if (window.__reframeCabinet) window.__reframeCabinet();
  renderer.setSize(innerWidth, innerHeight);
  bloomComposer.setSize(innerWidth * 0.5, innerHeight * 0.5);
  finalComposer.setSize(innerWidth, innerHeight);
});

// ---------- loop ----------
const clock = new THREE.Clock();
let neonT = 0;
// Adaptive quality: if fps drops, step down (SAO off → transmission off → lower dpr)
// ?fullfx in the URL forces max quality (no auto-degrade)
const forceFullFx = location.search.includes('fullfx');
let qualityTier = 0, fpsAcc = 0, fpsN = 0, fpsTimer = 0;
function stepDownQuality() {
  qualityTier++;
  if (qualityTier === 1) {
    // transmission off → restore solid ball color (tint lived in attenuationColor)
    if (claw && claw._glassMats) claw._glassMats.forEach((m) => { m.transmission = 0; m.color.setHex(m.userData.hex); });
    console.log('[quality] tier 1: transmission off');
  } else if (qualityTier === 2) {
    const pr = Math.min(devicePixelRatio, 1.4);
    renderer.setPixelRatio(pr);
    bloomComposer.setPixelRatio(pr);
    finalComposer.setPixelRatio(pr);
    renderer.setSize(innerWidth, innerHeight);
    bloomComposer.setSize(innerWidth * 0.5, innerHeight * 0.5);
    finalComposer.setSize(innerWidth, innerHeight);
    console.log('[quality] tier 3: pixelRatio', pr);
  }
}
renderer.setAnimationLoop(() => {
  // Keep CPU & GPU 100% idle while the player is choosing a language on #enter-screen
  if (!entered || !sceneCompiled) return;
  const dt = Math.min(clock.getDelta(), 0.05); // 120Hz-safe delta clamp
  neonT += dt;
  // Skybox dolly parallax — closer camera = bigger room features
  {
    const zd = camera.position.distanceTo(controls.target);
    envSphereMat.uniforms.uZoomK.value = 1 - THREE.MathUtils.clamp(
      (zd - controls.minDistance) / Math.max(0.001, controls.maxDistance - controls.minDistance), 0, 1);
  }
  // Subtle arcade neon flicker around the base values (panel-controlled)
  bloomPass.strength = bloomBase * (0.9 + (Math.sin(neonT * 7.3) * 0.08 + Math.sin(neonT * 17.1) * 0.045) * flickAmp);
  glow2.material.opacity = glow2Base + Math.sin(neonT * 3.2) * 0.14 * flickAmp;
  if (claw) {
    updateCabinetControls(dt);
    // Game-feel: phase-change sfx + hitstop slow-mo + near-miss detection
    const ph = claw.phase;
    if (ph !== lastPhase) {
      if (ph === 'descending') sfx.whir();
      else if (ph === 'touchdown') { sfx.thud(); shakeAmp = Math.max(shakeAmp, 0.045); }
      else if (ph === 'grabbing') { sfx.clack(); hitstop = 0.09; }
      else if (ph === 'hoisting') sfx.hoist();
      else if (ph === 'releasing') sfx.tick();
      // two-phase BGM like the real machines: urgent groove during the grab
      // cycle, calm attract melody while idle
      if (ph === 'descending') setMusicMode('play');
      else if (ph === 'idle') setMusicMode('attract');
      lastPhase = ph;
    }
    const cg = claw.clawGroup.position;
    if (ph === 'grabbing') {
      // snapshot whatever sits inside the cage mouth when the ring closes
      cageWatch.clear();
      for (const pr of claw.prizes) {
        if (!pr.body || pr.droppingInChute) continue;
        const dy = cg.y - pr.body.pos.y;
        if (Math.hypot(pr.body.pos.x - cg.x, pr.body.pos.z - cg.z) < 0.34 && dy > 0.1 && dy < 0.6) cageWatch.add(pr);
      }
    }
    if ((ph === 'hoisting' || ph === 'transporting') && cageWatch.size && !nearMissDone) {
      for (const pr of cageWatch) {
        const dy = cg.y - pr.body.pos.y;
        if (Math.hypot(pr.body.pos.x - cg.x, pr.body.pos.z - cg.z) > 0.55 || dy > 0.75) {
          nearMissDone = true;
          sfx.slip();
          break;
        }
      }
    }
    if (ph === 'idle' || ph === 'descending') nearMissDone = false;
    // hitstop: the grab lands with a micro slow-mo instead of a hard freeze
    // (dt→0 would divide by zero inside the trolley velocity math)
    hitstop = Math.max(0, hitstop - dt);
    claw.updateDemo(hitstop > 0 ? dt * 0.06 : dt);
    claw.syncBallInstances();
    // Blob shadow tracking the claw over the pile surface (~world y ≈ 1.0)
    claw.clawGroup.getWorldPosition(_vTmp);
    blobShadow.position.set(_vTmp.x, 1.0, _vTmp.z);
    const hAbove = _vTmp.y - 1.0;
    blobShadow.material.opacity = Math.max(0, Math.min(0.5, 0.55 - hAbove * 0.5));
    blobShadow.scale.setScalar(Math.min(1.6, Math.max(0.6, 0.9 + hAbove * 0.5)));
  }
  // Win celebration: top lights + volumetric beam + floating particles only for a few seconds after prize drops
  if (winLightLife > 0) {
    winLightLife = Math.max(0, winLightLife - dt);
    const prog = 1 - winLightLife / WIN_LIGHT_DUR;
    const env = Math.min(1, prog / 0.12) * Math.min(1, winLightLife / 0.75);
    shaftMat.uniforms.uTime.value = neonT;
    shaftMat.uniforms.uOp.value = 0.16 * env;
    dust.material.opacity = 0.55 * env;
    pitCyan.intensity = (pitCyanBase + Math.sin(neonT * 5.1) * 0.3 * flickAmp) * env;
    pitMag.intensity = (pitMagBase + Math.sin(neonT * 4.3 + 1.7) * 0.28 * flickAmp) * env;
    pitWarm.intensity = 1.5 * env;
    for (let i = 0; i < DUST_N; i++) {
      dustPos[i * 3 + 1] += dt * 0.06;
      dustPos[i * 3] += Math.sin(neonT * 1.4 + dustSeed[i]) * dt * 0.018;
      if (dustPos[i * 3 + 1] > 1.58) dustPos[i * 3 + 1] = 0.78;
    }
    dustGeo.attributes.position.needsUpdate = true;
    if (winLightLife <= 0) {
      shaft.visible = false;
      dust.visible = false;
      for (const s of topStrips) s.visible = false;
      pitCyan.intensity = 0;
      pitMag.intensity = 0;
      pitWarm.intensity = 0;
    }
  }
  if (confettiLife > 0) {
    confettiLife -= dt;
    for (let i = 0; i < CONF_N * 3; i += 3) {
      confVel[i + 1] -= 2.4 * dt;
      confPos[i] += confVel[i] * dt;
      confPos[i + 1] += confVel[i + 1] * dt;
      confPos[i + 2] += confVel[i + 2] * dt;
    }
    confGeo.attributes.position.needsUpdate = true;
    confetti.material.opacity = Math.min(1, confettiLife * 1.4);
    if (confettiLife <= 0) confetti.visible = false;
  }
  updateVerseReveal(dt);
  controls.update(dt);
  // Camera shake decays fast; applied after controls so it never fights the orbit
  if (shakeAmp > 0.0005) {
    shakeAmp *= Math.exp(-5.5 * dt);
    camera.position.x += (Math.random() - 0.5) * shakeAmp;
    camera.position.y += (Math.random() - 0.5) * shakeAmp;
  }
  // Selective bloom: blacken non-neon, blur layer, then composite over normal render
  if (noPostFx) {
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
  } else {
    if (!window.__nobloom) {
      darkenNonBloomed();
      bloomComposer.render();
      restoreMaterials();
    }
    renderer.shadowMap.needsUpdate = true;
    finalComposer.render();
  }
  // debug: per-frame capture hook — called after the composited frame is ready
  if (window.__frameHook) window.__frameHook(renderer.domElement);
  // fps watchdog → adaptive quality tier
  fpsTimer += dt; fpsAcc += dt; fpsN++;
  if (fpsTimer > 2.5 && fpsN > 30) {
    const avgFps = fpsN / fpsAcc;
    fpsTimer = 0; fpsAcc = 0; fpsN = 0;
    if (avgFps < 42 && qualityTier < 2 && !forceFullFx) stepDownQuality();
  }
});
