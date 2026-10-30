// Pooled combat VFX: tracers, muzzle flashes, impact sparks, blood, bullet decals, smoke volumes,
// incendiary fire, explosions. Every pool has a fixed size (no unbounded particle spawning).
import * as THREE from 'three';
import { GLOBAL, LAYER_FX } from '../engine/shaders';

const softTex = (() => {
  let t: THREE.Texture | null = null;
  return () => {
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.5)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    t = new THREE.CanvasTexture(c);
    return t;
  };
})();

const smokeTex = (() => {
  let t: THREE.Texture | null = null;
  return () => {
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    for (let i = 0; i < 26; i++) {
      const x = 64 + (Math.random() - 0.5) * 50, y = 64 + (Math.random() - 0.5) * 50, r = 18 + Math.random() * 30;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.35)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
    }
    t = new THREE.CanvasTexture(c);
    return t;
  };
})();

interface Particle { active: boolean; pos: THREE.Vector3; vel: THREE.Vector3; life: number; max: number; size: number; grow: number; color: THREE.Color; gravity: number; drag: number }

/** Billboard particle pool rendered as one InstancedMesh with per-instance color/opacity. */
class ParticlePool {
  readonly mesh: THREE.InstancedMesh;
  private parts: Particle[];
  private cursor = 0;
  private colorAttr: THREE.InstancedBufferAttribute;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();

  constructor(count: number, tex: THREE.Texture, blending: THREE.Blending, private alphaCurve: (k: number) => number) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const colors = new Float32Array(count * 4);
    this.colorAttr = new THREE.InstancedBufferAttribute(colors, 4);
    geo.setAttribute('aColor', this.colorAttr);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending, fog: false,
      uniforms: { map: { value: tex } },
      vertexShader: /* glsl */`
        attribute vec4 aColor; varying vec4 vColor; varying vec2 vUv;
        void main(){
          vColor = aColor; vUv = uv;
          vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float s = length(instanceMatrix[0].xyz);
          gl_Position = projectionMatrix * (center + vec4(position.xy * s, 0.0, 0.0));
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map; varying vec4 vColor; varying vec2 vUv;
        void main(){ vec4 t = texture2D(map, vUv); float a = t.a * vColor.a; if (a < 0.004) discard; gl_FragColor = vec4(vColor.rgb * t.rgb, a); }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_FX);
    this.parts = Array.from({ length: count }, () => ({ active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, max: 1, size: 1, grow: 0, color: new THREE.Color(), gravity: 0, drag: 0 }));
    for (let i = 0; i < count; i++) { this.m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, this.m); }
  }

  spawn(pos: THREE.Vector3, vel: THREE.Vector3, life: number, size: number, color: THREE.Color, o: { grow?: number; gravity?: number; drag?: number } = {}): void {
    const p = this.parts[this.cursor];
    this.cursor = (this.cursor + 1) % this.parts.length;
    p.active = true;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.life = 0;
    p.max = life;
    p.size = size;
    p.grow = o.grow ?? 0;
    p.gravity = o.gravity ?? 0;
    p.drag = o.drag ?? 0;
    p.color.copy(color);
  }

  update(dt: number): void {
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (!p.active) continue;
      p.life += dt;
      if (p.life >= p.max) {
        p.active = false;
        this.m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.m);
        this.colorAttr.setW(i, 0);
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.vel.multiplyScalar(1 - Math.min(1, p.drag * dt));
      p.pos.addScaledVector(p.vel, dt);
      const k = p.life / p.max;
      const sz = p.size + p.grow * p.life;
      this.s.set(sz, sz, sz);
      this.m.compose(p.pos, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
      this.colorAttr.setXYZW(i, p.color.r, p.color.g, p.color.b, this.alphaCurve(k));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }
}

interface Tracer { mesh: THREE.Mesh; life: number }
interface TimedLight { light: THREE.PointLight; life: number; max: number; base: number; flicker: boolean }
interface Area { pos: THREE.Vector3; until: number; radius: number; kind: 'smoke' | 'fire'; acc: number; light?: THREE.PointLight }

export class Effects {
  readonly group = new THREE.Group();
  private additive: ParticlePool;
  private smoke: ParticlePool;
  private tracers: Tracer[] = [];
  private tracerIdx = 0;
  private lights: TimedLight[] = [];
  private decals: THREE.InstancedMesh;
  private decalIdx = 0;
  private areas: Area[] = [];
  private time = 0;
  shake = 0;

  constructor(quality: number) {
    const n = quality >= 3 ? 1400 : quality === 2 ? 800 : 400;
    this.additive = new ParticlePool(n, softTex(), THREE.AdditiveBlending, (k) => 1 - k);
    this.smoke = new ParticlePool(quality >= 2 ? 500 : 260, smokeTex(), THREE.NormalBlending, (k) => Math.min(1, k * 6) * (1 - k) * 1.2);
    this.group.add(this.additive.mesh, this.smoke.mesh);
    const tracerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 4.5, 2.5), transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    for (let i = 0; i < 48; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 1), tracerMat);
      m.visible = false;
      m.layers.set(LAYER_FX);
      this.group.add(m);
      this.tracers.push({ mesh: m, life: 0 });
    }
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffaa55, 0, 10, 2);
      this.group.add(l);
      this.lights.push({ light: l, life: 0, max: 0, base: 0, flicker: false });
    }
    const decalMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9, metalness: 0, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -4, depthWrite: false });
    this.decals = new THREE.InstancedMesh(new THREE.CircleGeometry(0.045, 8), decalMat, 128);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < 128; i++) this.decals.setMatrixAt(i, zero);
    this.decals.frustumCulled = false;
    this.group.add(this.decals);
  }

  private flashLight(pos: THREE.Vector3, color: number, intensity: number, life: number, distance = 10, flicker = false): THREE.PointLight {
    const tl = this.lights.reduce((a, b) => (a.life / Math.max(a.max, 1e-3) >= b.life / Math.max(b.max, 1e-3) ? a : b));
    tl.light.position.copy(pos);
    tl.light.color.setHex(color);
    tl.light.distance = distance;
    tl.base = intensity;
    tl.light.intensity = intensity;
    tl.life = 0;
    tl.max = life;
    tl.flicker = flicker;
    return tl.light;
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const t = this.tracers[this.tracerIdx++ % this.tracers.length];
    const d = to.clone().sub(from);
    const len = d.length();
    if (len < 1) return;
    const seg = Math.min(len, 6 + Math.random() * 4);
    t.mesh.scale.set(1, 1, seg);
    t.mesh.position.copy(from).addScaledVector(d, (seg / 2 + Math.random() * Math.max(0, len - seg)) / len);
    t.mesh.lookAt(to);
    t.mesh.visible = true;
    t.life = 0.06;
  }

  muzzle(pos: THREE.Vector3, dir: THREE.Vector3, big = 1): void {
    this.flashLight(pos, 0xffb060, 25 * big, 0.06, 8);
    for (let i = 0; i < 4; i++) this.additive.spawn(pos.clone().addScaledVector(dir, 0.05 + i * 0.06), dir.clone().multiplyScalar(2), 0.05, 0.12 * big * (1 - i * 0.18), new THREE.Color(4, 2.2, 0.8));
  }

  impact(pos: THREE.Vector3, normal: THREE.Vector3, kind: 'world' | 'flesh' | 'metal'): void {
    if (kind === 'flesh') {
      for (let i = 0; i < 8; i++) this.smoke.spawn(pos, normal.clone().multiplyScalar(0.6).add(new THREE.Vector3((Math.random() - 0.5), Math.random(), (Math.random() - 0.5)).multiplyScalar(1.2)), 0.45, 0.12, new THREE.Color(0.35, 0.02, 0.03), { grow: 0.6, gravity: 3, drag: 2 });
      return;
    }
    for (let i = 0; i < (kind === 'metal' ? 10 : 6); i++) {
      const v = normal.clone().multiplyScalar(2 + Math.random() * 3).add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3));
      this.additive.spawn(pos, v, 0.18 + Math.random() * 0.2, 0.035, new THREE.Color(5, 3, 1.2), { gravity: 9 });
    }
    for (let i = 0; i < 3; i++) this.smoke.spawn(pos, normal.clone().multiplyScalar(0.5 + Math.random() * 0.4), 0.9, 0.12, new THREE.Color(0.55, 0.55, 0.6), { grow: 0.5, drag: 1.5 });
    // bullet hole decal
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    m.compose(pos.clone().addScaledVector(normal, 0.01), q, new THREE.Vector3(1, 1, 1));
    this.decals.setMatrixAt(this.decalIdx++ % 128, m);
    this.decals.instanceMatrix.needsUpdate = true;
  }

  explosion(pos: THREE.Vector3, scale = 1): void {
    this.flashLight(pos.clone().add(new THREE.Vector3(0, 1, 0)), 0xff8a3a, 900 * scale, 1.2, 40 * scale);
    for (let i = 0; i < 60 * scale; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize().multiplyScalar(4 + Math.random() * 12 * scale);
      this.additive.spawn(pos.clone().add(new THREE.Vector3(0, 0.5, 0)), v, 0.6 + Math.random() * 0.6, 0.8 * scale, new THREE.Color(5, 2 + Math.random(), 0.6), { grow: 2 * scale, drag: 2.5, gravity: -1 });
    }
    for (let i = 0; i < 40 * scale; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 6);
      this.smoke.spawn(pos.clone().add(new THREE.Vector3(0, 1, 0)), v, 3 + Math.random() * 2, 2 * scale, new THREE.Color(0.12, 0.11, 0.12), { grow: 1.5, drag: 1.2, gravity: -0.4 });
    }
    this.shake = Math.max(this.shake, 1.2 * scale);
  }

  flashPop(pos: THREE.Vector3): void {
    this.flashLight(pos, 0xffffff, 1500, 0.25, 30);
    for (let i = 0; i < 20; i++) this.additive.spawn(pos, new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(8), 0.25, 0.6, new THREE.Color(8, 8, 8), { drag: 4 });
  }

  smokeArea(pos: THREE.Vector3, duration: number): void { this.areas.push({ pos: pos.clone(), until: this.time + duration, radius: 4.2, kind: 'smoke', acc: 0 }); }
  fireArea(pos: THREE.Vector3, duration: number): void {
    const light = this.flashLight(pos.clone().add(new THREE.Vector3(0, 0.8, 0)), 0xff6a1a, 160, duration, 12, true);
    this.areas.push({ pos: pos.clone(), until: this.time + duration, radius: 3.2, kind: 'fire', acc: 0, light });
  }
  extinguish(pos: THREE.Vector3): void {
    for (const a of this.areas) if (a.kind === 'fire' && a.pos.distanceTo(pos) < a.radius + 4) a.until = this.time;
    for (let i = 0; i < 20; i++) this.smoke.spawn(pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, 0.3, (Math.random() - 0.5) * 3)), new THREE.Vector3(0, 1.5, 0), 2, 0.8, new THREE.Color(0.6, 0.6, 0.62), { grow: 1 });
  }
  /** Is the segment a→b obscured by an active smoke cloud? (for HUD name tags) */
  smokeBlocks(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const ab = b.clone().sub(a);
    const len = ab.length();
    ab.divideScalar(len);
    for (const s of this.areas) {
      if (s.kind !== 'smoke' || this.time > s.until - 1) continue;
      const t = THREE.MathUtils.clamp(s.pos.clone().add(new THREE.Vector3(0, 1.2, 0)).sub(a).dot(ab), 0, len);
      if (a.clone().addScaledVector(ab, t).distanceTo(s.pos.clone().add(new THREE.Vector3(0, 1.2, 0))) < s.radius * 0.85) return true;
    }
    return false;
  }

  clearAreas(): void { for (const a of this.areas) a.until = 0; }

  update(dt: number): void {
    this.time += dt;
    for (const t of this.tracers) if (t.mesh.visible && (t.life -= dt) <= 0) t.mesh.visible = false;
    for (const l of this.lights) {
      if (l.life >= l.max) { l.light.intensity = 0; continue; }
      l.life += dt;
      const k = 1 - l.life / l.max;
      l.light.intensity = l.flicker ? l.base * (0.75 + Math.random() * 0.35) * Math.min(1, k * 4) : l.base * k * k;
    }
    for (const a of this.areas) {
      if (this.time > a.until) continue;
      a.acc += dt;
      if (a.kind === 'smoke') {
        const rate = 0.05;
        while (a.acc > rate) {
          a.acc -= rate;
          const left = a.until - this.time;
          const r = a.radius * Math.min(1, (18 - left) / 1.2 + 0.2);
          const p = a.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * r * 1.6, Math.random() * 3.2, (Math.random() - 0.5) * r * 1.6));
          this.smoke.spawn(p, new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.05, (Math.random() - 0.5) * 0.3), 4, 2.6, new THREE.Color(0.62, 0.64, 0.68).multiplyScalar(left < 2 ? left / 2 : 1), { grow: 0.4 });
        }
      } else {
        const rate = 0.012;
        while (a.acc > rate) {
          a.acc -= rate;
          const ang = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * a.radius;
          const p = a.pos.clone().add(new THREE.Vector3(Math.cos(ang) * rr, 0.05, Math.sin(ang) * rr));
          this.additive.spawn(p, new THREE.Vector3(0, 1.5 + Math.random() * 2, 0), 0.5 + Math.random() * 0.4, 0.45, new THREE.Color(5, 1.6 + Math.random(), 0.3), { grow: -0.4, drag: 0.5 });
          if (Math.random() < 0.08) this.smoke.spawn(p.clone().add(new THREE.Vector3(0, 1.2, 0)), new THREE.Vector3(0, 1.4, 0), 2.2, 0.7, new THREE.Color(0.08, 0.07, 0.07), { grow: 0.8 });
        }
      }
    }
    this.areas = this.areas.filter((a) => this.time <= a.until + 0.1);
    this.additive.update(dt);
    this.smoke.update(dt);
    this.shake = Math.max(0, this.shake - dt * 2.5);
    void GLOBAL;
  }
}
