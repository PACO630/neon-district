// Night sky with city-glow lit clouds, volumetric light cones (street lamps, sign beams, searchlights),
// drifting fog layers between buildings, and an instanced distant skyline with procedural windows.
import * as THREE from 'three';
import { GLOBAL, LAYER_FX } from './shaders';

export function createSky(radius = 900): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uTime: GLOBAL.uTime, uGlowA: { value: new THREE.Color(0x9a4a3a) }, uGlowB: { value: new THREE.Color(0x1f6a86) }, uZenith: { value: new THREE.Color(0x060812) } },
    vertexShader: /* glsl */`varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform vec3 uGlowA, uGlowB, uZenith; varying vec3 vDir;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
      float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
      void main(){
        float h = clamp(vDir.y, -0.1, 1.0);
        float az = atan(vDir.z, vDir.x);
        vec3 glow = mix(uGlowA, uGlowB, 0.5 + 0.5 * sin(az * 1.5 + 0.7));
        vec3 col = mix(glow * 0.9, uZenith, pow(smoothstep(-0.02, 0.55, h), 0.55));
        vec2 cuv = vDir.xz / max(vDir.y + 0.15, 0.05) * 0.6 + vec2(uTime * 0.004, uTime * 0.0015);
        float c = fbm(cuv);
        float clouds = smoothstep(0.42, 0.85, c) * smoothstep(0.0, 0.25, h);
        vec3 lit = glow * 1.4 * (1.0 - smoothstep(0.0, 0.8, h)) + vec3(0.02, 0.025, 0.05);
        col = mix(col, lit, clouds * 0.75);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}

// ---------------------------------------------------------------- volumetric light cones
const coneMat = (color: THREE.Color, intensity: number) => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  uniforms: { uColor: { value: color }, uIntensity: { value: intensity }, uTime: GLOBAL.uTime, uRain: GLOBAL.uRain },
  vertexShader: /* glsl */`
    varying float vAlong; varying vec3 vN; varying vec3 vView; varying vec3 vW;
    void main(){
      vAlong = 1.0 - (position.y + 0.5);   // 0 at apex (top), 1 at base
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vW = wp.xyz;
      vN = normalize(mat3(modelMatrix) * normal);
      vView = normalize(cameraPosition - wp.xyz);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 uColor; uniform float uIntensity, uTime, uRain; varying float vAlong; varying vec3 vN; varying vec3 vView; varying vec3 vW;
    float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,45.164))) * 43758.5453); }
    void main(){
      float edge = pow(clamp(abs(dot(normalize(vN), vView)), 0.0, 1.0), 1.6);
      float al = clamp(vAlong, 0.0, 1.0);
      float fall = pow(1.0 - al, 1.4) * smoothstep(0.0, 0.06, al);
      // rain streaks scattering inside the beam
      vec3 q = vW * vec3(14.0, 1.2, 14.0) + vec3(0.0, uTime * 9.0, 0.0);
      float streak = step(0.985, hash(floor(q))) * uRain;
      float near = smoothstep(1.5, 7.0, length(cameraPosition - vW));
      float a = edge * fall * uIntensity * (0.85 + streak * 2.5) * near;
      gl_FragColor = vec4(uColor * a, a);
    }`,
});

/** A cone of light hanging from `apex` pointing along `dir`. */
export function lightCone(apex: THREE.Vector3, dir: THREE.Vector3, length: number, radius: number, color: THREE.ColorRepresentation, intensity = 0.25): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(0.06, radius, 1, 24, 1, true);
  const m = new THREE.Mesh(geo, coneMat(new THREE.Color(color), intensity));
  m.scale.y = length;
  const d = dir.clone().normalize();
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), d);
  m.position.copy(apex).addScaledVector(d, length / 2);
  m.layers.set(LAYER_FX);
  m.renderOrder = 5;
  return m;
}

/** Sky searchlights sweeping over the skyline (god-ray style beams). */
export class Searchlights {
  readonly group = new THREE.Group();
  private beams: { mesh: THREE.Mesh; base: THREE.Vector3; phase: number; speed: number }[] = [];
  constructor(points: THREE.Vector3[], color: THREE.ColorRepresentation) {
    for (const p of points) {
      const mesh = lightCone(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 380, 22, color, 0.07);
      this.group.add(mesh);
      this.beams.push({ mesh, base: p, phase: Math.random() * 6.28, speed: 0.08 + Math.random() * 0.1 });
    }
  }
  update(t: number): void {
    for (const b of this.beams) {
      const a = b.phase + t * b.speed;
      const d = new THREE.Vector3(Math.sin(a) * 0.45, 1, Math.cos(a * 0.7) * 0.45).normalize();
      b.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), d);
      b.mesh.position.copy(b.base).addScaledVector(d, 190);
    }
  }
}

// ---------------------------------------------------------------- fog layers
export function fogLayer(center: THREE.Vector3, size: number, color: THREE.ColorRepresentation, opacity = 0.18): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    uniforms: { uTime: GLOBAL.uTime, uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uSeed: { value: Math.random() * 100 } },
    vertexShader: /* glsl */`varying vec2 vUv; varying float vDist; void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position,1.0); vDist = length(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uOpacity, uSeed; uniform vec3 uColor; varying vec2 vUv; varying float vDist;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
      void main(){
        vec2 p = vUv * 5.0 + uSeed;
        float n = noise(p + uTime * 0.03) * 0.6 + noise(p * 2.3 - uTime * 0.05) * 0.4;
        float edge = smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x) * smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
        float near = smoothstep(2.0, 12.0, vDist);
        float a = smoothstep(0.35, 0.9, n) * edge * near * uOpacity;
        gl_FragColor = vec4(uColor, a);
      }`,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.copy(center);
  m.layers.set(LAYER_FX);
  m.renderOrder = 4;
  return m;
}

// ---------------------------------------------------------------- distant skyline
export function distantSkyline(count: number, inner: number, outer: number, seed = 1): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x07080c, roughness: 0.6, metalness: 0.4 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSkyW; varying vec3 vSkyN; varying float vSkySeed;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 sw = instanceMatrix * vec4(transformed, 1.0);
        vSkyW = (modelMatrix * sw).xyz;
        vSkyN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
        vSkySeed = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.71;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vSkyW; varying vec3 vSkyN; varying float vSkySeed;
        float skh(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec3 an = abs(vSkyN);
          if (an.y < 0.5) {
            vec2 wuv = vec2(an.x > an.z ? vSkyW.z : vSkyW.x, vSkyW.y) / vec2(2.2, 3.2);
            vec2 cell = floor(wuv);
            vec2 f = fract(wuv);
            float win = step(0.18, f.x) * step(f.x, 0.82) * step(0.25, f.y) * step(f.y, 0.8);
            float r = skh(cell + vSkySeed);
            float lit = step(0.72, r) * win;
            vec3 wc = r > 0.93 ? vec3(0.2, 0.9, 1.0) : r > 0.88 ? vec3(1.0, 0.25, 0.8) : vec3(1.0, 0.75, 0.45);
            totalEmissiveRadiance += wc * lit * 0.9;
          } else if (vSkyW.y > 1.0) {
            totalEmissiveRadiance += vec3(1.0, 0.1, 0.1) * step(0.92, fract(vSkySeed * 7.0)) * 1.5;
          }
        }`);
  };
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const im = new THREE.InstancedMesh(geo, mat, count);
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2;
    const r = inner + rand() * (outer - inner);
    const w = 14 + rand() * 30, d = 14 + rand() * 30;
    const h = 40 + Math.pow(rand(), 2) * 260;
    m.compose(new THREE.Vector3(Math.cos(a) * r, -2, Math.sin(a) * r), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * 0.6), new THREE.Vector3(w, h, d));
    im.setMatrixAt(i, m);
  }
  im.frustumCulled = false;
  g.add(im);
  // aircraft warning beacons on the tallest towers
  const beaconMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.3, 0.3), fog: false });
  for (let i = 0; i < 24; i++) {
    const a = rand() * Math.PI * 2;
    const r = inner + rand() * (outer - inner);
    const b = new THREE.Mesh(new THREE.SphereGeometry(1.2, 6, 4), beaconMat);
    b.position.set(Math.cos(a) * r, 120 + rand() * 160, Math.sin(a) * r);
    g.add(b);
  }
  return g;
}

/** Environment probe built from emissive panels, used where a real-scene probe is unavailable. */
export function neonEnvironmentScene(): THREE.Scene {
  const s = new THREE.Scene();
  s.background = new THREE.Color(0x020308);
  const panel = (color: number, intensity: number, pos: THREE.Vector3, size: THREE.Vector2) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.y), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.copy(pos);
    m.lookAt(0, 0, 0);
    s.add(m);
  };
  panel(0x00e5ff, 3, new THREE.Vector3(8, 2, 0), new THREE.Vector2(3, 6));
  panel(0xff2bd6, 3, new THREE.Vector3(-8, 3, 2), new THREE.Vector2(4, 4));
  panel(0x7a5cff, 2, new THREE.Vector3(0, 4, -8), new THREE.Vector2(8, 2));
  panel(0xffa040, 1.5, new THREE.Vector3(2, 1, 8), new THREE.Vector2(3, 2));
  panel(0x203050, 1, new THREE.Vector3(0, 10, 0), new THREE.Vector2(20, 20));
  panel(0x101018, 1, new THREE.Vector3(0, -6, 0), new THREE.Vector2(20, 20));
  return s;
}
