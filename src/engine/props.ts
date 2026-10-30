// Reusable detailed props, added through a StaticBatcher (merged per material).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { boxUV, type LightAnchor, type MaterialLib, type StaticBatcher } from './Builder';
import { lightCone } from './Atmosphere';
import { GLOBAL } from './shaders';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const rot = (v: THREE.Vector3, yaw: number) => v.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

export interface PropCtx { b: StaticBatcher; L: MaterialLib; anchors: LightAnchor[]; fx: THREE.Group; drips: THREE.Vector4[] }

export function streetLamp(c: PropCtx, pos: THREE.Vector3, yaw: number, color = 0xffd28a, height = 6.5): void {
  const { b, L } = c;
  b.add(new THREE.CylinderGeometry(0.09, 0.13, height, 10), L.m.metalDark, pos.clone().add(V(0, height / 2, 0)), { collide: true });
  b.add(new THREE.CylinderGeometry(0.22, 0.26, 0.5, 10), L.m.metalDark, pos.clone().add(V(0, 0.25, 0)));
  const armLen = 2.2;
  const armMid = pos.clone().add(rot(V(0, height - 0.1, -armLen / 2), yaw));
  b.add(new THREE.BoxGeometry(0.1, 0.1, armLen), L.m.metalDark, armMid, { rotY: yaw });
  const head = pos.clone().add(rot(V(0, height - 0.25, -armLen + 0.2), yaw));
  b.add(new THREE.BoxGeometry(0.5, 0.18, 0.9), L.m.metalDark, head, { rotY: yaw });
  b.add(new THREE.BoxGeometry(0.42, 0.03, 0.8), L.neon(color, 5), head.clone().add(V(0, -0.1, 0)), { rotY: yaw, cast: false });
  c.anchors.push({ pos: head.clone().add(V(0, -0.3, 0)), color: new THREE.Color(color), intensity: 160, distance: 18, kind: 'spot', dir: V(0, -1, 0), angle: 0.75 });
  c.fx.add(lightCone(head.clone().add(V(0, -0.12, 0)), V(0, -1, 0), height - 0.4, 2.6, color, 0.11));
}

export function neonBar(c: PropCtx, from: THREE.Vector3, to: THREE.Vector3, color: THREE.ColorRepresentation, thick = 0.06, light = true): void {
  const d = to.clone().sub(from);
  const len = d.length();
  const geo = new THREE.CylinderGeometry(thick, thick, len, 6);
  const mid = from.clone().add(to).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.clone().normalize());
  c.b.add(geo, c.L.neon(color, 4), mid, { rot: new THREE.Euler().setFromQuaternion(q), cast: false });
  if (light) c.anchors.push({ pos: mid, color: new THREE.Color(color), intensity: 10 * Math.min(3, len), distance: 8, kind: 'point' });
}

export function car(c: PropCtx, pos: THREE.Vector3, yaw: number, paint: THREE.Material, tail = 0xff1a3a): void {
  const { b, L } = c;
  const body = new RoundedBoxGeometry(1.9, 0.62, 4.4, 2, 0.2);
  b.add(body, paint, pos.clone().add(V(0, 0.62, 0)), { rotY: yaw, collide: true });
  const cabin = new RoundedBoxGeometry(1.6, 0.5, 2.2, 2, 0.2);
  b.add(cabin, L.m.glassDark, pos.clone().add(rot(V(0, 1.12, 0.2), yaw)), { rotY: yaw });
  for (const sx of [-0.88, 0.88]) for (const sz of [-1.4, 1.4]) {
    const w = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 16);
    b.add(w, L.m.rubber, pos.clone().add(rot(V(sx, 0.36, sz), yaw)), { rot: new THREE.Euler(0, yaw, Math.PI / 2, 'YXZ') });
  }
  b.add(new THREE.BoxGeometry(1.7, 0.06, 0.04), L.neon(0xe8f4ff, 4), pos.clone().add(rot(V(0, 0.75, -2.21), yaw)), { rotY: yaw, cast: false });
  b.add(new THREE.BoxGeometry(1.8, 0.07, 0.04), L.neon(tail, 4), pos.clone().add(rot(V(0, 0.8, 2.21), yaw)), { rotY: yaw, cast: false });
  b.add(new THREE.BoxGeometry(1.92, 0.025, 3.6), L.neon(0x00e5ff, 1.5), pos.clone().add(rot(V(0, 0.31, 0), yaw)), { rotY: yaw, cast: false });
}

export function vending(c: PropCtx, pos: THREE.Vector3, yaw: number, tex: THREE.Texture, color: number): void {
  const { b, L } = c;
  b.add(boxUV(1.1, 2.0, 0.8, 1), L.m.metal, pos.clone().add(V(0, 1.0, 0)), { rotY: yaw, collide: true });
  b.add(new THREE.PlaneGeometry(0.9, 1.4), L.sign(tex, 1.8), pos.clone().add(rot(V(0, 1.15, -0.41), yaw)), { rotY: yaw + Math.PI, cast: false });
  c.anchors.push({ pos: pos.clone().add(rot(V(0, 1.2, -1), yaw)), color: new THREE.Color(color), intensity: 10, distance: 5, kind: 'point' });
}

export function bollard(c: PropCtx, pos: THREE.Vector3, color: number): void {
  c.b.add(new THREE.CylinderGeometry(0.12, 0.14, 1, 10), c.L.m.metalDark, pos.clone().add(V(0, 0.5, 0)), { collide: true });
  c.b.add(new THREE.CylinderGeometry(0.125, 0.125, 0.05, 10), c.L.neon(color, 3), pos.clone().add(V(0, 0.85, 0)), { cast: false });
}

export function bench(c: PropCtx, pos: THREE.Vector3, yaw: number): void {
  const { b, L } = c;
  b.add(boxUV(2.0, 0.08, 0.5, 1), L.m.metal, pos.clone().add(V(0, 0.48, 0)), { rotY: yaw, collide: true });
  b.add(boxUV(2.0, 0.5, 0.06, 1), L.m.metal, pos.clone().add(rot(V(0, 0.8, 0.24), yaw)), { rotY: yaw });
  for (const sx of [-0.85, 0.85]) b.add(new THREE.BoxGeometry(0.08, 0.46, 0.45), L.m.metalDark, pos.clone().add(rot(V(sx, 0.23, 0), yaw)), { rotY: yaw });
}

export function acUnit(c: PropCtx, pos: THREE.Vector3, yaw: number): void {
  const { b, L } = c;
  b.add(boxUV(1.0, 0.7, 0.6, 1), L.m.metal, pos, { rotY: yaw });
  b.add(new THREE.CylinderGeometry(0.26, 0.26, 0.04, 16), L.m.metalDark, pos.clone().add(rot(V(0, 0, -0.31), yaw)), { rot: new THREE.Euler(Math.PI / 2, yaw, 0, 'YXZ') });
  c.drips.push(new THREE.Vector4(pos.x, pos.y - 0.36, pos.z, pos.y - 0.2));
}

export function pipeRun(c: PropCtx, from: THREE.Vector3, to: THREE.Vector3, r = 0.08, mat?: THREE.Material): void {
  const d = to.clone().sub(from);
  const len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.clone().normalize());
  c.b.add(new THREE.CylinderGeometry(r, r, len, 8), mat ?? c.L.m.metalDark, from.clone().add(to).multiplyScalar(0.5), { rot: new THREE.Euler().setFromQuaternion(q) });
}

/** Sagging cable between two points. */
export function cable(c: PropCtx, a: THREE.Vector3, b2: THREE.Vector3, sag = 1.2, r = 0.02): void {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    pts.push(a.clone().lerp(b2, t).add(V(0, -Math.sin(t * Math.PI) * sag, 0)));
  }
  c.b.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, r, 4, false), c.L.m.rubber, V(0, 0, 0), { cast: false });
}

export function crate(c: PropCtx, pos: THREE.Vector3, size: number, yaw: number, mat?: THREE.Material): void {
  c.b.add(boxUV(size, size, size, 1.2), mat ?? c.L.m.metal, pos.clone().add(V(0, size / 2, 0)), { rotY: yaw, collide: true });
}

export function trashBin(c: PropCtx, pos: THREE.Vector3): void {
  c.b.add(new THREE.CylinderGeometry(0.32, 0.28, 0.95, 12), c.L.m.metalBlue, pos.clone().add(V(0, 0.48, 0)), { collide: true });
  c.b.add(new THREE.CylinderGeometry(0.34, 0.34, 0.06, 12), c.L.m.metalDark, pos.clone().add(V(0, 0.98, 0)));
}

/** Holographic additive material with scanlines and fresnel rim. */
export function holoMaterial(color: THREE.ColorRepresentation, strength = 1.2): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uTime: GLOBAL.uTime, uColor: { value: new THREE.Color(color) }, uStrength: { value: strength } },
    vertexShader: /* glsl */`
      #include <common>
      #include <skinning_pars_vertex>
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main(){
        #include <skinbase_vertex>
        #include <begin_vertex>
        #include <beginnormal_vertex>
        #include <skinnormal_vertex>
        #include <skinning_vertex>
        vec4 wp = modelMatrix * vec4(transformed, 1.0);
        vN = normalize(mat3(modelMatrix) * objectNormal); vV = normalize(cameraPosition - wp.xyz); vY = wp.y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uStrength; uniform vec3 uColor; varying vec3 vN; varying vec3 vV; varying float vY;
      void main(){
        float fres = pow(1.0 - abs(dot(normalize(vN), vV)), 2.0);
        float scan = 0.55 + 0.45 * sin(vY * 60.0 - uTime * 6.0);
        float glitch = step(0.97, fract(sin(floor(uTime * 12.0) * 91.7) * 43758.5)) * 0.6;
        float band = smoothstep(0.0, 0.05, fract(vY * 0.4 - uTime * 0.3)) * 0.4 + 0.6;
        float a = (0.15 + fres * 0.85) * scan * band * uStrength * (1.0 - glitch);
        gl_FragColor = vec4(uColor * a, a);
      }`,
  });
}

/** Animated billboard: cycles several canvas frames with a scrolling scanline shader. */
export function billboardMaterial(frames: THREE.Texture[], intensity = 2.2): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: GLOBAL.uTime, tA: { value: frames[0] }, tB: { value: frames[1 % frames.length] }, tC: { value: frames[2 % frames.length] }, uI: { value: intensity },
    },
    vertexShader: /* glsl */`
      #include <fog_pars_vertex>
      varying vec2 vUv;
      void main(){ vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <fog_pars_fragment>
      uniform float uTime, uI; uniform sampler2D tA, tB, tC; varying vec2 vUv;
      void main(){
        float cyc = mod(uTime, 18.0);
        float w = smoothstep(5.5, 6.0, cyc) - smoothstep(11.5, 12.0, cyc);
        float w2 = smoothstep(11.5, 12.0, cyc) - smoothstep(17.5, 18.0, cyc);
        vec2 uv = vUv;
        float tear = step(0.985, fract(sin(floor(uTime * 8.0) * 13.1) * 9137.0)) * 0.03;
        uv.x += tear * sin(uv.y * 40.0);
        vec3 c = texture2D(tA, uv).rgb * (1.0 - w - w2) + texture2D(tB, uv).rgb * w + texture2D(tC, uv).rgb * w2;
        c *= 0.85 + 0.15 * sin(vUv.y * 600.0);
        c *= 0.92 + 0.08 * sin(uTime * 50.0 + vUv.y * 4.0);
        gl_FragColor = vec4(c * uI, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}
