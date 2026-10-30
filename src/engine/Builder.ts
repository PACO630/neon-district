// Scene construction helpers: a PBR material library built from procedural textures, world-scaled
// box UVs, and a static batcher that merges geometry per material (few draw calls) and emits
// matching Rapier colliders.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GraphicsSettings } from '../config/settings';
import type { Physics } from '../physics/Physics';
import { LAYER_REFLECT_SKIP, makeRainGlass, makeWet } from './shaders';
import * as T from './textures';

export type MatKey =
  | 'asphalt' | 'sidewalk' | 'plaza' | 'concrete' | 'concreteDark' | 'metal' | 'metalDark' | 'metalBlue' | 'grating'
  | 'facadeOffice' | 'facadeOffice2' | 'facadeRes' | 'facadeRes2' | 'facadeInd' | 'glass' | 'glassDark' | 'chrome'
  | 'rubber' | 'plastic' | 'paint' | 'curb' | 'lacquer' | 'fabric' | 'containerRed' | 'containerBlue' | 'containerYellow' | 'floorIndoor'
  | 'wallIndoor' | 'tileWet' | 'foliage';

export class MaterialLib {
  readonly m = {} as Record<MatKey, THREE.MeshStandardMaterial>;
  private neonCache = new Map<string, THREE.MeshStandardMaterial>();
  readonly asphaltSet: T.PBRSet;

  constructor(g: GraphicsSettings) {
    const big = g.shadows >= 3 ? 1024 : g.shadows >= 2 ? 512 : 256;
    const mid = big >= 1024 ? 512 : big;
    const small = Math.max(128, mid / 2);
    const std = (set: T.PBRSet, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({
      map: set.map, normalMap: set.normalMap, roughnessMap: set.orm, metalnessMap: set.orm, aoMap: set.orm,
      emissiveMap: set.emissiveMap ?? null, emissive: set.emissiveMap ? new THREE.Color(1, 1, 1) : new THREE.Color(0), envMapIntensity: 0.8,
      roughness: 1, metalness: 1, aoMapIntensity: 0.8, ...extra,
    });
    this.asphaltSet = T.asphalt(big, 11);
    const tilesSet = T.tiles(mid, 31, 4);
    const sideSet = T.tiles(mid, 37, 8);
    const conc = T.concrete(mid, 3, 0.42);
    const concD = T.concrete(mid, 5, 0.24);
    const metal = T.metalPanels(mid, 7, [0.24, 0.26, 0.3]);
    const metalD = T.metalPanels(mid, 9, [0.12, 0.125, 0.14], 2);
    const metalB = T.metalPanels(mid, 13, [0.14, 0.24, 0.34], 3);
    const grate = T.grating(small);
    const m = this.m;
    m.asphalt = makeWet(std(this.asphaltSet, { normalScale: new THREE.Vector2(0.6, 0.6) }), { mask: this.asphaltSet.mask, maskScale: 1 / 22, wetness: 0.8, puddles: 1 });
    m.sidewalk = makeWet(std(sideSet), { mask: sideSet.mask, maskScale: 1 / 9, wetness: 0.7, puddles: 0.5 });
    m.plaza = makeWet(std(tilesSet), { mask: tilesSet.mask, maskScale: 1 / 16, wetness: 0.75, puddles: 0.6 });
    m.tileWet = makeWet(std(tilesSet), { mask: tilesSet.mask, maskScale: 1 / 16, wetness: 0.4, puddles: 0.25 });
    m.concrete = std(conc);
    m.concreteDark = std(concD);
    m.curb = std(conc, { color: 0x9a9a9a });
    m.metal = std(metal);
    m.metalDark = std(metalD);
    m.metalBlue = std(metalB);
    m.grating = std(grate);
    const fac = (seed: number, style: 'office' | 'residential' | 'industrial') => std(T.facade(big >= 1024 ? 1024 : mid, seed, style), { emissiveIntensity: 1.15 });
    m.facadeOffice = fac(101, 'office');
    m.facadeOffice2 = fac(202, 'office');
    m.facadeRes = fac(303, 'residential');
    m.facadeRes2 = fac(404, 'residential');
    m.facadeInd = fac(505, 'industrial');
    m.glass = makeRainGlass(new THREE.MeshPhysicalMaterial({ color: 0x0b1620, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.35, envMapIntensity: 1.6, clearcoat: 1, clearcoatRoughness: 0.05, depthWrite: false }), 1);
    m.glassDark = makeRainGlass(new THREE.MeshPhysicalMaterial({ color: 0x05080c, metalness: 0.6, roughness: 0.06, envMapIntensity: 1.4, clearcoat: 1 }), 0.6);
    m.chrome = new THREE.MeshStandardMaterial({ color: 0xb8c0c8, metalness: 1, roughness: 0.12 });
    m.rubber = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, metalness: 0, roughness: 0.9 });
    m.plastic = new THREE.MeshStandardMaterial({ color: 0x23262c, metalness: 0, roughness: 0.45 });
    m.paint = new THREE.MeshStandardMaterial({ color: 0xc8c8b8, metalness: 0, roughness: 0.5 });
    m.lacquer = new THREE.MeshPhysicalMaterial({ color: 0x120a0c, metalness: 0.2, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 });
    m.fabric = new THREE.MeshStandardMaterial({ color: 0x3a1430, metalness: 0, roughness: 0.95, side: THREE.DoubleSide });
    const cont = (seed: number, c: [number, number, number]) => std(T.corrugated(mid, seed, c));
    m.containerRed = cont(61, [0.32, 0.06, 0.05]);
    m.containerBlue = cont(62, [0.05, 0.14, 0.28]);
    m.containerYellow = cont(63, [0.42, 0.3, 0.04]);
    m.foliage = new THREE.MeshStandardMaterial({ color: 0x1d3a26, roughness: 0.85, metalness: 0, flatShading: true });
    m.floorIndoor = std(T.tiles(mid, 71, 6), { color: 0xd0d0dc });
    m.wallIndoor = std(T.concrete(mid, 9, 0.3), { color: 0xa8b0c0 });
  }

  /** Emissive-only neon tube material (shared per color & intensity). */
  neon(color: THREE.ColorRepresentation, intensity = 3): THREE.MeshStandardMaterial {
    const c = new THREE.Color(color);
    const key = `${c.getHexString()}:${intensity}`;
    let m = this.neonCache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: c, emissiveIntensity: intensity, roughness: 0.4, metalness: 0 });
      this.neonCache.set(key, m);
    }
    return m;
  }

  /** Emissive textured sign (sign face). */
  private signCache = new Map<string, THREE.MeshStandardMaterial>();
  sign(tex: THREE.Texture, intensity = 2.4): THREE.MeshStandardMaterial {
    const key = `${tex.uuid}:${intensity}`;
    let m = this.signCache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: 0x050505, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: intensity, roughness: 0.35, metalness: 0.2 });
      this.signCache.set(key, m);
    }
    return m;
  }
}

/** Box geometry whose UVs are in world units / `tile` so textures keep a constant texel density. */
export function boxUV(w: number, h: number, d: number, tile = 4): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // face order: +x, -x, +y, -y, +z, -z (4 verts each)
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * dims[f][0] / tile, uv.getY(i) * dims[f][1] / tile);
    }
  }
  return g;
}

interface Pending { geo: THREE.BufferGeometry; matrix: THREE.Matrix4 }

export class StaticBatcher {
  private groups = new Map<THREE.Material, { cast: Pending[]; nocast: Pending[] }>();
  constructor(private physics: Physics | null) {}

  add(geo: THREE.BufferGeometry, mat: THREE.Material, pos: THREE.Vector3 | [number, number, number], opts: { rotY?: number; rot?: THREE.Euler; scale?: THREE.Vector3; cast?: boolean; collide?: boolean } = {}): void {
    const p = Array.isArray(pos) ? new THREE.Vector3(...pos) : pos;
    const q = opts.rot ? new THREE.Quaternion().setFromEuler(opts.rot) : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), opts.rotY ?? 0);
    const matrix = new THREE.Matrix4().compose(p, q, opts.scale ?? new THREE.Vector3(1, 1, 1));
    let g = this.groups.get(mat);
    if (!g) this.groups.set(mat, (g = { cast: [], nocast: [] }));
    (opts.cast === false ? g.nocast : g.cast).push({ geo, matrix });
    if (opts.collide && this.physics) {
      geo.computeBoundingBox();
      const bb = geo.boundingBox!;
      const size = bb.getSize(new THREE.Vector3()).multiply(opts.scale ?? new THREE.Vector3(1, 1, 1));
      const center = bb.getCenter(new THREE.Vector3()).applyMatrix4(matrix);
      this.physics.addBox(center, size.multiplyScalar(0.5), q);
    }
  }

  /** Convenience: world-UV box with optional collider. */
  box(mat: THREE.Material, center: [number, number, number], size: [number, number, number], opts: { rotY?: number; cast?: boolean; collide?: boolean; tile?: number } = {}): void {
    this.add(boxUV(size[0], size[1], size[2], opts.tile ?? 4), mat, center, { rotY: opts.rotY, cast: opts.cast, collide: opts.collide ?? true });
  }

  build(parent: THREE.Object3D, opts: { receive?: boolean; layer?: number } = {}): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [mat, g] of this.groups) {
      for (const [list, cast] of [[g.cast, true], [g.nocast, false]] as const) {
        if (!list.length) continue;
        const geos = list.map(({ geo, matrix }) => {
          const c = geo.clone().applyMatrix4(matrix);
          for (const k of Object.keys(c.attributes)) if (!['position', 'normal', 'uv'].includes(k)) c.deleteAttribute(k);
          return c.index ? c.toNonIndexed() : c;
        });
        // chunk to keep index ranges reasonable
        for (let i = 0; i < geos.length; i += 400) {
          const merged = mergeGeometries(geos.slice(i, i + 400));
          if (!merged) continue;
          merged.computeBoundingSphere();
          const mesh = new THREE.Mesh(merged, mat);
          mesh.castShadow = cast;
          mesh.receiveShadow = opts.receive ?? true;
          mesh.matrixAutoUpdate = false;
          if ((mat as any).onBeforeCompile && (mat as any).customProgramCacheKey?.().startsWith('wet')) mesh.layers.set(LAYER_REFLECT_SKIP);
          if (opts.layer !== undefined) mesh.layers.set(opts.layer);
          parent.add(mesh);
          out.push(mesh);
        }
      }
    }
    this.groups.clear();
    return out;
  }
}

/** Light anchors (neon signs, lamps) served by a fixed pool of real lights nearest to the camera. */
export interface LightAnchor { pos: THREE.Vector3; color: THREE.Color; intensity: number; distance: number; kind: 'point' | 'spot'; dir?: THREE.Vector3; angle?: number }

export class LightPool {
  private points: THREE.PointLight[] = [];
  private spots: THREE.SpotLight[] = [];
  private timer = 0;
  /** Anchor intensities are authored in rough candela; gains calibrate them for physically-based falloff. */
  pointGain = 7;
  spotGain = 3;
  constructor(parent: THREE.Object3D, private anchors: LightAnchor[], nPoint: number, nSpot: number, spotShadows: number) {
    for (let i = 0; i < nPoint; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      parent.add(l);
      this.points.push(l);
    }
    for (let i = 0; i < nSpot; i++) {
      const l = new THREE.SpotLight(0xffffff, 0, 20, 0.6, 0.6, 1.6);
      if (i < spotShadows) {
        l.castShadow = true;
        l.shadow.mapSize.set(512, 512);
        l.shadow.bias = -0.0008;
        l.shadow.normalBias = 0.03;
        l.shadow.camera.near = 0.5;
      }
      parent.add(l);
      parent.add(l.target);
      this.spots.push(l);
    }
  }

  update(dt: number, cam: THREE.Vector3, force = false): void {
    this.timer -= dt;
    if (this.timer > 0 && !force) return;
    this.timer = 0.4;
    const score = (a: LightAnchor) => a.pos.distanceToSquared(cam) / (a.intensity * a.distance);
    const pts = this.anchors.filter((a) => a.kind === 'point').sort((a, b) => score(a) - score(b));
    const sps = this.anchors.filter((a) => a.kind === 'spot').sort((a, b) => score(a) - score(b));
    this.points.forEach((l, i) => {
      const a = pts[i];
      if (!a) { l.intensity = 0; return; }
      l.position.copy(a.pos);
      l.color.copy(a.color);
      l.intensity = a.intensity * this.pointGain;
      l.distance = a.distance * 1.25;
    });
    this.spots.forEach((l, i) => {
      const a = sps[i];
      if (!a) { l.intensity = 0; return; }
      l.position.copy(a.pos);
      l.target.position.copy(a.pos).add(a.dir ?? new THREE.Vector3(0, -1, 0));
      l.target.updateMatrixWorld();
      l.color.copy(a.color);
      l.intensity = a.intensity * this.spotGain;
      l.distance = a.distance;
      l.angle = a.angle ?? 0.6;
    });
  }
}
