// Global shader customizations: height fog for every material, wet-surface reflections with rain
// ripples, and rain-streaked glass. Materials are patched through onBeforeCompile.
import * as THREE from 'three';

export const GLOBAL = {
  uTime: { value: 0 },
  uRain: { value: 1 },        // 0..1 rain intensity
};

let installed = false;
/** Layered fog: exponential distance fog + ground-hugging height fog (rain haze between buildings). */
export function installShaderChunks(): void {
  if (installed) return;
  installed = true;
  THREE.ShaderChunk.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
#endif`;
  THREE.ShaderChunk.fog_vertex = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorldPos = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );
#endif`;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
  THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    float heightFog = exp( - max( vFogWorldPos.y + 1.5, 0.0 ) * 0.075 ) * ( 1.0 - exp( - vFogDepth * fogDensity * 2.2 ) ) * 0.6;
    fogFactor = clamp( fogFactor + heightFog * ( 1.0 - fogFactor ), 0.0, 1.0 );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;
}

// ---------------------------------------------------------------- wet surfaces
export interface WetUniforms {
  tReflect: { value: THREE.Texture | null };
  uReflectMatrix: { value: THREE.Matrix4 };
  uHasReflect: { value: number };
  uReflectStrength: { value: number };
}

export const WET: WetUniforms = {
  tReflect: { value: null },
  uReflectMatrix: { value: new THREE.Matrix4() },
  uHasReflect: { value: 0 },
  uReflectStrength: { value: 1 },
};

const RIPPLE_GLSL = /* glsl */`
float wetHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// Expanding rain-drop rings; returns height-gradient in xz.
vec2 rippleGrad(vec2 p, float t) {
  vec2 g = vec2(0.0);
  for (int layer = 0; layer < 2; layer++) {
    vec2 q = p * (layer == 0 ? 2.2 : 3.7) + float(layer) * 17.0;
    vec2 cell = floor(q);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(i, j);
      float h = wetHash(c);
      vec2 center = c + vec2(wetHash(c + 3.1), wetHash(c + 7.3));
      float ph = fract(t * (0.9 + h * 0.6) + h * 9.0);
      vec2 d = q - center;
      float r = length(d);
      float ring = r - ph * 0.9;
      float amp = (1.0 - ph) * (1.0 - ph) * smoothstep(0.9, 0.0, r);
      float w = sin(ring * 28.0) * exp(-ring * ring * 60.0) * amp;
      g += (r > 1e-3 ? d / r : vec2(0.0)) * w;
    }
  }
  return g;
}`;

export interface WetOptions {
  mask?: THREE.Texture;        // R = puddle amount
  maskScale?: number;          // world units -> mask uv
  wetness?: number;            // 0..1 base wetness away from puddles
  puddles?: number;            // 0..1 puddle coverage strength
}

/** Turns a MeshStandardMaterial into a rain-soaked surface with planar reflections and ripples. */
export function makeWet(mat: THREE.MeshStandardMaterial, o: WetOptions = {}): THREE.MeshStandardMaterial {
  const maskScale = o.maskScale ?? 1 / 24;
  const wetness = o.wetness ?? 0.7;
  const puddles = o.puddles ?? 1;
  mat.customProgramCacheKey = () => `wet-${!!o.mask}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.tReflect = WET.tReflect;
    shader.uniforms.uReflectMatrix = WET.uReflectMatrix;
    shader.uniforms.uHasReflect = WET.uHasReflect;
    shader.uniforms.uReflectStrength = WET.uReflectStrength;
    shader.uniforms.uTime = GLOBAL.uTime;
    shader.uniforms.uRain = GLOBAL.uRain;
    shader.uniforms.tWetMask = { value: o.mask ?? null };
    shader.uniforms.uWet = { value: new THREE.Vector3(maskScale, wetness, puddles) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform mat4 uReflectMatrix;
        varying vec4 vReflect;
        varying vec3 vWetWorld;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 wetWp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wetWp = instanceMatrix * wetWp;
        #endif
        wetWp = modelMatrix * wetWp;
        vWetWorld = wetWp.xyz;
        vReflect = uReflectMatrix * wetWp;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tReflect;
        uniform float uHasReflect;
        uniform float uReflectStrength;
        uniform float uTime;
        uniform float uRain;
        uniform vec3 uWet;
        ${o.mask ? 'uniform sampler2D tWetMask;' : ''}
        varying vec4 vReflect;
        varying vec3 vWetWorld;
        ${RIPPLE_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float puddle = ${o.mask ? 'smoothstep(0.08, 0.55, texture2D(tWetMask, vWetWorld.xz * uWet.x).r)' : '0.0'} * uWet.z;
        float wet = max(uWet.y * uRain, puddle);
        diffuseColor.rgb *= mix(1.0, 0.42, wet);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.45, wet * uRain);
        roughnessFactor = mix(roughnessFactor, 0.035, puddle);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 rg = rippleGrad(vWetWorld.xz, uTime) * uRain;
          vec3 waterN = normalize((viewMatrix * vec4(-rg.x * 0.35, 1.0, -rg.y * 0.35, 0.0)).xyz);
          normal = normalize(mix(normal, waterN, puddle * 0.9));
        }`)
      .replace('#include <opaque_fragment>', `
        if (uHasReflect > 0.5) {
          vec3 vdir = normalize(vViewPosition);
          float ndv = clamp(dot(normal, vdir), 0.0, 1.0);
          float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
          vec3 nW = (vec4(normal, 0.0) * viewMatrix).xyz;
          float rough = clamp(roughnessFactor, 0.0, 1.0);
          vec2 ruv = vReflect.xy / vReflect.w + nW.xz * (0.015 + rough * 0.05);
          float blur = rough * 0.025;
          vec3 refl = texture2D(tReflect, ruv).rgb * 0.4;
          refl += texture2D(tReflect, ruv + vec2(blur, blur * 2.0)).rgb * 0.15;
          refl += texture2D(tReflect, ruv - vec2(blur, blur * 2.0)).rgb * 0.15;
          refl += texture2D(tReflect, ruv + vec2(-blur, blur * 4.0)).rgb * 0.15;
          refl += texture2D(tReflect, ruv + vec2(blur, -blur * 4.0)).rgb * 0.15;
          float k = mix(0.35 * wet * (1.0 - rough), 1.0, puddle) * mix(fres, 1.0, 0.45) * uReflectStrength;
          outgoingLight = outgoingLight * (1.0 - k * 0.6) + refl * k;
        }
        #include <opaque_fragment>`);
  };
  return mat;
}

// ---------------------------------------------------------------- rain-streaked glass
export function makeRainGlass(mat: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial, scale = 1): typeof mat {
  mat.customProgramCacheKey = () => 'rainglass';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = GLOBAL.uTime;
    shader.uniforms.uRain = GLOBAL.uRain;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlassW;\nvarying vec3 vGlassN;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 gw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          gw = instanceMatrix * gw;
        #endif
        vGlassW = (modelMatrix * gw).xyz;
        vGlassN = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform float uRain;
        varying vec3 vGlassW; varying vec3 vGlassN;
        float gHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5453); }
        // static droplets + running streaks; returns (gradX, gradY, mask)
        vec3 drops(vec2 uv) {
          vec3 acc = vec3(0.0);
          vec2 g = uv * 9.0;
          vec2 id = floor(g);
          vec2 f = fract(g) - 0.5;
          float h = gHash(id);
          vec2 c = vec2(h - 0.5, gHash(id + 1.7) - 0.5) * 0.6;
          vec2 d = f - c;
          float r = 0.08 + 0.1 * gHash(id + 4.2);
          float m = smoothstep(r, r * 0.4, length(d)) * step(0.35, h);
          acc += vec3(d * m * 6.0, m);
          // running streak
          vec2 sg = vec2(uv.x * 4.0, uv.y * 0.6 + uTime * (0.25 + 0.2 * gHash(vec2(floor(uv.x * 4.0), 1.0))));
          vec2 sid = floor(sg);
          vec2 sf = fract(sg) - vec2(0.5, 0.5);
          float sh = gHash(sid);
          float sx = sf.x - (sh - 0.5) * 0.6 - sin(sg.y * 10.0) * 0.02;
          float head = smoothstep(0.06, 0.0, length(vec2(sx, (sf.y + 0.35) * 0.5)));
          float trail = smoothstep(0.02, 0.0, abs(sx)) * smoothstep(-0.35, 0.4, sf.y) * 0.35;
          float sm = (head + trail) * step(0.55, sh);
          acc += vec3(sx * 8.0 * sm, 0.0, sm);
          return acc;
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 an = abs(vGlassN);
          vec2 guv = (an.x > an.z ? vGlassW.zy : vGlassW.xy) * ${(0.35 * scale).toFixed(3)};
          vec3 dr = drops(guv) * uRain;
          vec3 pn = normalize(vec3(dr.xy * 0.6, 1.0));
          normal = normalize(normal + (viewMatrix * vec4(pn.x, pn.y, 0.0, 0.0)).xyz * 0.9);
          roughnessFactor = mix(roughnessFactor, 0.0, dr.z);
        }`);
  };
  return mat;
}

// ---------------------------------------------------------------- planar reflection renderer
export const LAYER_REFLECT_SKIP = 2; // objects on this layer only are invisible to the mirror (ground itself)
export const LAYER_FX = 1;           // rain & other screen-ish effects, also skipped by the mirror

export class PlanarReflection {
  readonly rt: THREE.WebGLRenderTarget;
  private cam = new THREE.PerspectiveCamera();
  private n = new THREE.Vector3(0, 1, 0);
  private planeP = new THREE.Vector3();
  private camP = new THREE.Vector3();
  private rot = new THREE.Matrix4();
  private look = new THREE.Vector3();
  private target = new THREE.Vector3();
  private view = new THREE.Vector3();
  private plane = new THREE.Plane();
  private clip = new THREE.Vector4();
  private q = new THREE.Vector4();
  scale = 0.5;
  enabled = true;
  frameSkip = 0;
  private frame = 0;

  constructor(public y = 0) {
    this.rt = new THREE.WebGLRenderTarget(64, 64, { type: THREE.HalfFloatType, samples: 0 });
    this.rt.texture.generateMipmaps = false;
    WET.tReflect.value = this.rt.texture;
    this.cam.layers.set(0);
  }

  setSize(w: number, h: number): void {
    this.rt.setSize(Math.max(64, Math.floor(w * this.scale)), Math.max(64, Math.floor(h * this.scale)));
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    WET.uHasReflect.value = this.enabled ? 1 : 0;
    if (!this.enabled) return;
    if (this.frameSkip && this.frame++ % (this.frameSkip + 1) !== 0) return;
    this.planeP.set(0, this.y, 0);
    this.camP.setFromMatrixPosition(camera.matrixWorld);
    this.view.subVectors(this.planeP, this.camP);
    if (this.view.dot(this.n) > 0) return;
    this.view.reflect(this.n).negate().add(this.planeP);
    this.rot.extractRotation(camera.matrixWorld);
    this.look.set(0, 0, -1).applyMatrix4(this.rot).add(this.camP);
    this.target.subVectors(this.planeP, this.look).reflect(this.n).negate().add(this.planeP);
    const c = this.cam;
    c.position.copy(this.view);
    c.up.set(0, 1, 0).applyMatrix4(this.rot).reflect(this.n);
    c.lookAt(this.target);
    c.far = camera.far;
    c.near = camera.near;
    c.updateMatrixWorld();
    c.projectionMatrix.copy(camera.projectionMatrix);
    const tm = WET.uReflectMatrix.value;
    tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    tm.multiply(c.projectionMatrix).multiply(c.matrixWorldInverse);
    // oblique near-plane clipping so geometry below the water line is not mirrored
    this.plane.setFromNormalAndCoplanarPoint(this.n, this.planeP).applyMatrix4(c.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const pm = c.projectionMatrix.elements;
    this.q.set((Math.sign(this.clip.x) + pm[8]) / pm[0], (Math.sign(this.clip.y) + pm[9]) / pm[5], -1, (1 + pm[10]) / pm[14]);
    this.clip.multiplyScalar(2 / this.clip.dot(this.q));
    pm[2] = this.clip.x; pm[6] = this.clip.y; pm[10] = this.clip.z + 1 - 0.003; pm[14] = this.clip.w;
    c.projectionMatrixInverse.copy(c.projectionMatrix).invert();

    const prevRT = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, c);
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setRenderTarget(prevRT);
  }
}
