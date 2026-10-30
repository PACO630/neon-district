// GPU rain: two depth layers of wind-slanted streaks that wrap around the camera, ground splash
// crowns, roof-edge drip streams, and pooled CPU splash bursts for footsteps in puddles.
// All shader-driven: zero per-frame CPU cost for the ambient rain.
import * as THREE from 'three';
import { GLOBAL, LAYER_FX } from './shaders';

const MAX_SHELTERS = 8;

const streakVS = /* glsl */`
  attribute vec4 aOffset;  // xyz random 0..1, w speed variance
  uniform float uTime; uniform vec3 uBox; uniform vec3 uCam; uniform vec2 uWind; uniform float uLen; uniform float uWidth;
  uniform vec4 uShelterMin[${MAX_SHELTERS}]; uniform vec4 uShelterMax[${MAX_SHELTERS}];
  uniform float uGround;
  varying float vAlpha; varying vec2 vUv;
  void main(){
    float speed = 11.0 + aOffset.w * 6.0;
    vec3 p;
    p.y = mod(aOffset.y * uBox.y - uTime * speed, uBox.y) + uCam.y - uBox.y * 0.35;
    vec2 drift = uWind * (uTime + aOffset.w);
    p.xz = mod(aOffset.xz * uBox.xz - uCam.xz + drift, uBox.xz) + uCam.xz - uBox.xz * 0.5;
    vAlpha = 1.0;
    for (int i = 0; i < ${MAX_SHELTERS}; i++) {
      if (uShelterMax[i].w > 0.5 && all(greaterThan(p, uShelterMin[i].xyz)) && all(lessThan(p, uShelterMax[i].xyz))) vAlpha = 0.0;
    }
    if (p.y < uGround) vAlpha = 0.0;
    vec3 vel = normalize(vec3(uWind.x, -speed, uWind.y));
    vec3 toCam = normalize(uCam - p);
    vec3 side = normalize(cross(vel, toCam)) * uWidth;
    vec3 wp = p + side * (position.x) + vel * (position.y * uLen);
    float dist = length(uCam - p);
    vAlpha *= smoothstep(0.5, 2.5, dist) * (1.0 - smoothstep(uBox.x * 0.35, uBox.x * 0.5, dist));
    vUv = position.xy + 0.5;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }`;
const streakFS = /* glsl */`
  uniform vec3 uColor; uniform float uOpacity; varying float vAlpha; varying vec2 vUv;
  void main(){
    if (vAlpha <= 0.0) discard;
    float a = (1.0 - abs(vUv.x * 2.0 - 1.0)) * smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
    gl_FragColor = vec4(uColor, a * vAlpha * uOpacity);
  }`;

const splashVS = /* glsl */`
  attribute vec3 aSeed;
  uniform float uTime; uniform vec3 uCam; uniform float uRadius; uniform float uGround;
  uniform vec4 uShelterMin[${MAX_SHELTERS}]; uniform vec4 uShelterMax[${MAX_SHELTERS}];
  varying vec2 vUv; varying float vLife;
  float hh(float n){ return fract(sin(n) * 43758.5453); }
  void main(){
    float rate = 2.2 + aSeed.z;
    float cyc = uTime * rate + aSeed.x * 10.0;
    float id = floor(cyc);
    vLife = fract(cyc);
    vec2 r = vec2(hh(id * 12.9 + aSeed.y * 78.2), hh(id * 3.7 + aSeed.x * 41.1)) * 2.0 - 1.0;
    vec3 c = vec3(uCam.x + r.x * uRadius, uGround + 0.02, uCam.z + r.y * uRadius);
    float hidden = 0.0;
    for (int i = 0; i < ${MAX_SHELTERS}; i++) {
      if (uShelterMax[i].w > 0.5 && c.x > uShelterMin[i].x && c.x < uShelterMax[i].x && c.z > uShelterMin[i].z && c.z < uShelterMax[i].z && uCam.y < uShelterMax[i].y) hidden = 1.0;
    }
    float s = (0.05 + vLife * 0.16) * (1.0 - hidden);
    vec3 toCam = normalize(uCam - c);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
    vec3 wp = c + right * position.x * s * 2.0 + vec3(0.0, 1.0, 0.0) * (position.y + 0.5) * s * 1.4;
    vUv = position.xy + 0.5;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }`;
const splashFS = /* glsl */`
  uniform vec3 uColor; varying vec2 vUv; varying float vLife;
  void main(){
    vec2 p = vUv - vec2(0.5, 0.0);
    float crown = smoothstep(0.08, 0.0, abs(length(p * vec2(1.0, 2.2)) - 0.42)) * smoothstep(0.6, 0.0, vUv.y);
    float drops = smoothstep(0.06, 0.0, length(fract(vec2(vUv.x * 4.0, vUv.y * 2.0 - vLife)) - 0.5) - 0.12) * step(0.3, vUv.y);
    float a = (crown + drops * 0.4) * (1.0 - vLife);
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor, a * 0.5);
  }`;

const dripVS = /* glsl */`
  attribute vec4 aEmitter; // xyz top position, w fall height
  attribute float aPhase;
  uniform float uTime; uniform vec3 uCam;
  varying vec2 vUv; varying float vA;
  void main(){
    float t = fract(uTime * 0.9 + aPhase);
    float fall = 0.5 * 9.8 * t * t * 0.6;
    vec3 p = aEmitter.xyz - vec3(0.0, min(fall, aEmitter.w), 0.0);
    vA = fall < aEmitter.w ? 1.0 : 0.0;
    vec3 toCam = normalize(uCam - p);
    vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), toCam)) * 0.01;
    float len = 0.12 + t * 0.4;
    vec3 wp = p + side * position.x + vec3(0.0, 1.0, 0.0) * position.y * len;
    vUv = position.xy + 0.5;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }`;
const dripFS = /* glsl */`
  uniform vec3 uColor; varying vec2 vUv; varying float vA;
  void main(){
    if (vA <= 0.0) discard;
    float a = (1.0 - abs(vUv.x * 2.0 - 1.0)) * vUv.y;
    gl_FragColor = vec4(uColor, a * 0.55);
  }`;

function quad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

export interface Shelter { min: THREE.Vector3; max: THREE.Vector3 }

export class Rain {
  readonly group = new THREE.Group();
  private mats: THREE.ShaderMaterial[] = [];
  private shelterMin = Array.from({ length: MAX_SHELTERS }, () => new THREE.Vector4());
  private shelterMax = Array.from({ length: MAX_SHELTERS }, () => new THREE.Vector4());
  private cam = new THREE.Vector3();
  private bursts: { mesh: THREE.InstancedMesh; vel: THREE.Vector3[]; pos: THREE.Vector3[]; life: number[] };
  private burstCursor = 0;
  private dummy = new THREE.Object3D();
  ground = 0;

  constructor(density: number, private drips: THREE.Vector4[] = []) {
    const shared = { uTime: GLOBAL.uTime, uCam: { value: this.cam }, uShelterMin: { value: this.shelterMin }, uShelterMax: { value: this.shelterMax } };
    // two layers: near (dense, thin, close box) and far (large box, longer streaks)
    const layers = [
      { count: Math.floor(5000 * density), box: new THREE.Vector3(22, 18, 22), len: 0.55, width: 0.012, opacity: 0.32 },
      { count: Math.floor(9000 * density), box: new THREE.Vector3(70, 40, 70), len: 1.1, width: 0.03, opacity: 0.18 },
    ];
    for (const L of layers) {
      if (L.count <= 0) continue;
      const geo = new THREE.InstancedBufferGeometry().copy(quad() as any) as THREE.InstancedBufferGeometry;
      const off = new Float32Array(L.count * 4);
      for (let i = 0; i < off.length; i++) off[i] = Math.random();
      geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 4));
      geo.instanceCount = L.count;
      const mat = new THREE.ShaderMaterial({
        vertexShader: streakVS, fragmentShader: streakFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: {
          ...shared, uBox: { value: L.box }, uWind: { value: new THREE.Vector2(1.2, 0.4) }, uLen: { value: L.len }, uWidth: { value: L.width },
          uColor: { value: new THREE.Color(0.55, 0.65, 0.8) }, uOpacity: { value: L.opacity }, uGround: { value: -50 },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.layers.set(LAYER_FX);
      mesh.renderOrder = 10;
      this.mats.push(mat);
      this.group.add(mesh);
    }
    // ground splashes
    const splashCount = Math.floor(900 * density);
    if (splashCount > 0) {
      const geo = new THREE.InstancedBufferGeometry().copy(quad() as any) as THREE.InstancedBufferGeometry;
      const seeds = new Float32Array(splashCount * 3);
      for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
      geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
      geo.instanceCount = splashCount;
      const mat = new THREE.ShaderMaterial({
        vertexShader: splashVS, fragmentShader: splashFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { ...shared, uRadius: { value: 16 }, uGround: { value: 0 }, uColor: { value: new THREE.Color(0.6, 0.7, 0.85) } },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.layers.set(LAYER_FX);
      this.mats.push(mat);
      this.group.add(mesh);
    }
    // drip streams from roof edges / awnings
    if (drips.length) {
      const per = density > 0.6 ? 3 : 1;
      const geo = new THREE.InstancedBufferGeometry().copy(quad() as any) as THREE.InstancedBufferGeometry;
      const em = new Float32Array(drips.length * per * 4);
      const ph = new Float32Array(drips.length * per);
      drips.forEach((d, i) => {
        for (let k = 0; k < per; k++) {
          const j = i * per + k;
          em.set([d.x + (Math.random() - 0.5) * 0.1, d.y, d.z + (Math.random() - 0.5) * 0.1, d.w], j * 4);
          ph[j] = Math.random();
        }
      });
      geo.setAttribute('aEmitter', new THREE.InstancedBufferAttribute(em, 4));
      geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(ph, 1));
      geo.instanceCount = drips.length * per;
      const mat = new THREE.ShaderMaterial({
        vertexShader: dripVS, fragmentShader: dripFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uTime: GLOBAL.uTime, uCam: { value: this.cam }, uColor: { value: new THREE.Color(0.65, 0.75, 0.9) } },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.layers.set(LAYER_FX);
      this.group.add(mesh);
    }
    // pooled footstep / impact splash droplets
    const poolSize = 160;
    const im = new THREE.InstancedMesh(new THREE.SphereGeometry(0.018, 5, 4), new THREE.MeshBasicMaterial({ color: 0x9fb8d0, transparent: true, opacity: 0.6 }), poolSize);
    im.frustumCulled = false;
    im.layers.set(LAYER_FX);
    this.bursts = { mesh: im, vel: Array.from({ length: poolSize }, () => new THREE.Vector3()), pos: Array.from({ length: poolSize }, () => new THREE.Vector3()), life: new Array(poolSize).fill(0) };
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < poolSize; i++) im.setMatrixAt(i, this.dummy.matrix);
    this.group.add(im);
  }

  setShelters(list: Shelter[]): void {
    for (let i = 0; i < MAX_SHELTERS; i++) {
      const s = list[i];
      if (s) { this.shelterMin[i].set(s.min.x, s.min.y, s.min.z, 1); this.shelterMax[i].set(s.max.x, s.max.y, s.max.z, 1); }
      else { this.shelterMin[i].set(0, 0, 0, 0); this.shelterMax[i].set(0, 0, 0, 0); }
    }
  }

  setGround(y: number): void {
    this.ground = y;
    for (const m of this.mats) if (m.uniforms.uGround && m.uniforms.uRadius) m.uniforms.uGround.value = y;
  }

  /** Spawns a crown of droplets (footstep in a puddle, bullet hitting water). */
  splash(p: THREE.Vector3, strength = 1): void {
    const n = Math.floor(10 * strength);
    for (let k = 0; k < n; k++) {
      const i = this.burstCursor++ % this.bursts.life.length;
      const a = Math.random() * Math.PI * 2;
      const s = (0.6 + Math.random() * 1.2) * strength;
      this.bursts.pos[i].copy(p).add(new THREE.Vector3(0, 0.03, 0));
      this.bursts.vel[i].set(Math.cos(a) * s, 1.5 + Math.random() * 1.8 * strength, Math.sin(a) * s);
      this.bursts.life[i] = 0.5 + Math.random() * 0.25;
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    this.cam.setFromMatrixPosition(camera.matrixWorld);
    const b = this.bursts;
    let dirty = false;
    for (let i = 0; i < b.life.length; i++) {
      if (b.life[i] <= 0) continue;
      dirty = true;
      b.life[i] -= dt;
      b.vel[i].y -= 9.8 * dt;
      b.pos[i].addScaledVector(b.vel[i], dt);
      this.dummy.position.copy(b.pos[i]);
      this.dummy.scale.setScalar(b.life[i] > 0 && b.pos[i].y > this.ground - 0.05 ? 1 : 0);
      this.dummy.updateMatrix();
      b.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (dirty) b.mesh.instanceMatrix.needsUpdate = true;
  }
}
