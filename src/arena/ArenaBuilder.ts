// Visual construction of SECTOR 09 from the shared map data, plus lighting and set dressing.
import * as THREE from 'three';
import type { GraphicsSettings } from '../config/settings';
import { distantSkyline, fogLayer, lightCone } from '../engine/Atmosphere';
import { boxUV, MaterialLib, StaticBatcher, type LightAnchor } from '../engine/Builder';
import * as P from '../engine/props';
import { neonText } from '../engine/textures';
import { ARENA_PROPS, ARENA_SHELTERS, BOUNDS, FLOOR_RECTS, MAP_BOXES, MAP_RAMPS, rampTransform, SITES, TUNNEL_Y, WAREHOUSE, X_RAMPS } from './Sector09';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export interface ArenaBuild { group: THREE.Group; anchors: LightAnchor[]; drips: THREE.Vector4[]; puddleMask: THREE.Texture | undefined; animate: ((t: number) => void)[] }

export function buildArenaVisuals(settings: GraphicsSettings): ArenaBuild {
  const L = new MaterialLib(settings);
  const group = new THREE.Group();
  const fx = new THREE.Group();
  group.add(fx);
  const anchors: LightAnchor[] = [];
  const drips: THREE.Vector4[] = [];
  const animate: ((t: number) => void)[] = [];
  const b = new StaticBatcher(null);
  const ctx: P.PropCtx = { b, L, anchors, fx, drips };

  // floor: wet asphalt outside, sealed concrete inside the warehouse
  const ground = new StaticBatcher(null);
  for (const r of FLOOR_RECTS) {
    const w = r[2] - r[0], d = r[3] - r[1];
    const geo = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 9 + r[0] / 9, uv.getY(i) * d / 9 + r[1] / 9);
    ground.add(geo, L.m.asphalt, V((r[0] + r[2]) / 2, 0, (r[1] + r[3]) / 2), { cast: false });
  }
  ground.build(group);
  const wh = WAREHOUSE;
  b.add(boxUV(wh.x1 - wh.x0 - 1, 0.02, wh.z1 - wh.z0 - 1, 3), L.m.floorIndoor, V((wh.x0 + wh.x1) / 2, 0.012, (wh.z0 + wh.z1) / 2), { cast: false });

  for (const bx of MAP_BOXES) {
    const mat = L.m[bx.mat];
    b.add(boxUV(bx.s[0], bx.s[1], bx.s[2], bx.tile ?? 4), mat, V(...bx.c), { rotY: bx.rotY, cast: bx.cast !== false });
  }
  for (const r of MAP_RAMPS) {
    const t = rampTransform(r, false);
    b.add(boxUV(t.half.x * 2, t.half.y * 2, t.half.z * 2, 2), L.m.grating, t.center, { rot: new THREE.Euler().setFromQuaternion(t.q) });
  }
  for (const r of X_RAMPS) {
    const t = rampTransform(r, true);
    b.add(boxUV(t.half.x * 2, t.half.y * 2, t.half.z * 2, 2), L.m.grating, t.center, { rot: new THREE.Euler().setFromQuaternion(t.q) });
  }

  // ------------------------------------------------------------ bomb site markers
  for (const k of ['A', 'B'] as const) {
    const s = SITES[k];
    const cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
    const y = k === 'A' ? 1.52 : 0.03;
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(5, 5).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: 0xffffff, emissiveMap: neonText(k, '#ff2a5a', { w: 256, h: 256, bg: '#000', frame: true }), emissiveIntensity: 1.5, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    decal.position.set(cx, y + 0.01, cz);
    group.add(decal);
    // boundary neon on the floor
    for (const [ax, az, bx2, bz] of [[s.x0, s.z0, s.x1, s.z0], [s.x1, s.z0, s.x1, s.z1], [s.x1, s.z1, s.x0, s.z1], [s.x0, s.z1, s.x0, s.z0]]) {
      P.neonBar(ctx, V(ax, y + 0.02, az), V(bx2, y + 0.02, bz), 0xff2a5a, 0.025, false);
    }
    anchors.push({ pos: V(cx, y + 3, cz), color: new THREE.Color(0xff2a5a), intensity: 60, distance: 14, kind: 'point' });
  }
  // big wall signs
  const wallSign = (text: string, color: string, pos: THREE.Vector3, yaw: number, w: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), L.sign(neonText(text, color, { w: 512, h: 128, bg: '#050508', frame: true }), 2.2));
    m.position.copy(pos);
    m.rotation.y = yaw;
    group.add(m);
    anchors.push({ pos: pos.clone().add(new THREE.Vector3(0, 0, 2).applyAxisAngle(V(0, 1, 0), yaw)), color: new THREE.Color(color), intensity: 40, distance: 10, kind: 'point' });
  };
  wallSign('SITE A ↑', '#ff2a5a', V(30.1, 4, 12), Math.PI / 2, 4);
  wallSign('SITE B ↑', '#ff2a5a', V(-30.1, 4, 12), -Math.PI / 2, 4);
  wallSign('MID', '#00e5ff', V(-9, 4, -29.9), 0, 3);
  wallSign('SECTOR 09', '#ffa31a', V(0, 7, BOUNDS.z1 - 0.1), Math.PI, 10);
  wallSign('DEFENSE GRID', '#00e5ff', V(0, 7, BOUNDS.z0 + 0.1), 0, 10);
  wallSign('B ↓ TUNNEL', '#8aff3a', V(-12.1, 2.5, 30), -Math.PI / 2, 3);
  wallSign('B SITE', '#ff2a5a', V(-14.6, 4.5, -18), -Math.PI / 2, 4);

  // ------------------------------------------------------------ lighting & dressing
  const sodium = 0xffa64d, cool = 0xbfe0ff;
  for (const [x, z, yaw] of ARENA_PROPS.lamps) {
    P.streetLamp(ctx, V(x, 0, z), yaw, x === 0 || Math.abs(z) > 40 ? cool : sodium, 6);
  }
  // floodlights on A dock
  for (const [x, z] of ARENA_PROPS.floods) {
    b.add(new THREE.CylinderGeometry(0.1, 0.12, 7, 8), L.m.metalDark, V(x, 1.5 + 3.5, z));
    b.add(new THREE.BoxGeometry(0.8, 0.5, 0.3), L.neon(0xfff4e0, 6), V(x, 8.6, z));
    anchors.push({ pos: V(x, 8.4, z), color: new THREE.Color(0xfff0d8), intensity: 400, distance: 30, kind: 'spot', dir: V(34 - x, -7, -26 - z).normalize(), angle: 0.7 });
    fx.add(lightCone(V(x, 8.4, z), V(34 - x, -7, -26 - z).normalize(), 14, 6, 0xfff0d8, 0.06));
  }
  // warehouse ceiling lights
  for (let x = wh.x0 + 5; x < wh.x1 - 2; x += 8) {
    for (const z of [-34, -20]) {
      b.add(new THREE.BoxGeometry(2.4, 0.12, 0.4), L.neon(0xdff2ff, 4), V(x, wh.h - 0.3, z), { cast: false });
      anchors.push({ pos: V(x, wh.h - 0.8, z), color: new THREE.Color(0xdff2ff), intensity: 160, distance: 16, kind: 'spot', dir: V(0, -1, 0), angle: 0.9 });
      fx.add(lightCone(V(x, wh.h - 0.4, z), V(0, -1, 0), wh.h - 0.5, 3.4, 0xdff2ff, 0.05));
    }
  }
  // tunnel strip lights (red/amber emergency)
  for (let z = -12; z < 20; z += 6) {
    b.add(new THREE.BoxGeometry(0.15, 0.08, 1.4), L.neon(0xff3a2a, 3), V(-20.9, TUNNEL_Y + 2.6, z), { cast: false });
    anchors.push({ pos: V(-18, TUNNEL_Y + 2.2, z), color: new THREE.Color(0xff4a2a), intensity: 18, distance: 7, kind: 'point' });
  }
  for (let i = 0; i < 6; i++) P.pipeRun(ctx, V(-14.3, TUNNEL_Y + 3.6 - i * 0.2, -26), V(-14.3, TUNNEL_Y + 3.6 - i * 0.2, 32), 0.06, i % 2 ? L.m.metalBlue : L.m.metal);
  // exterior wall pipes, AC units, vertical neon on the outer facades
  for (let z = -46; z < 46; z += 9) {
    P.pipeRun(ctx, V(BOUNDS.x0 + 0.2, 0, z), V(BOUNDS.x0 + 0.2, 11, z), 0.12);
    P.acUnit(ctx, V(BOUNDS.x1 - 0.35, 4 + (z % 3), z + 2), -Math.PI / 2);
  }
  P.neonBar(ctx, V(-30, 0.2, -11.9), V(-30, 9.5, -11.9), 0x00e5ff, 0.05);
  P.neonBar(ctx, V(8.1, 0.2, 39.9), V(8.1, 9.5, 39.9), 0xff2bd6, 0.05);
  P.neonBar(ctx, V(30.1, 0.2, -5.9), V(30.1, 9.5, -5.9), 0xff2bd6, 0.05);
  P.neonBar(ctx, V(-13.9, 0.2, 18.1), V(-13.9, 9.5, 18.1), 0x8aff3a, 0.05);
  // parked vehicle and barrels in lanes
  const truck = new THREE.MeshPhysicalMaterial({ color: 0x1a2a3a, metalness: 0.7, roughness: 0.3, clearcoat: 1 });
  P.car(ctx, V(ARENA_PROPS.car.x, 0, ARENA_PROPS.car.z), ARENA_PROPS.car.yaw, truck);
  for (const [x, z] of ARENA_PROPS.barrels) b.add(new THREE.CylinderGeometry(0.35, 0.35, 1.0, 14), L.m.containerBlue, V(x, 0.5, z));
  // roof edges drip
  for (let x = wh.x0; x < wh.x1; x += 3) drips.push(new THREE.Vector4(x, wh.h + 0.3, wh.z1 + 0.15, wh.h + 0.2));
  for (let x = 8; x < 30; x += 3) drips.push(new THREE.Vector4(x, 10, 40.2, 9.9));
  // atmosphere
  group.add(distantSkyline(80 + settings.particles * 30, 90, 300, 3));
  for (let i = 0; i < settings.particles * 2; i++) group.add(fogLayer(V(-30 + i * 14, 4 + i, i % 2 ? 20 : -10), 40, 0x2a3450, 0.1));
  b.build(group);
  void ARENA_SHELTERS;
  return { group, anchors, drips, puddleMask: L.asphaltSet.mask, animate };
}
