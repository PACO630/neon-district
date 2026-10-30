// NEON CITY: layout, districts, towers, signage, props, lights, colliders.
//
//            N (−Z)                 TACTICAL GATE  (0, −110)
//                                   AFTERLIFE BAR  (x 10..30, z −66..−44), door faces west
//   NIGHT MARKET  ←  CENTRAL PLAZA (0,0)  →  ARMORY (x 46..70, z −30..−10), door faces south
//   (x −112..−34)                    BLACK VAULT stairs (x −21..−9, z 57..63) → room at y = −4
//            S (+Z)
import * as THREE from 'three';
import { Assets } from '../engine/Assets';
import { distantSkyline, fogLayer, lightCone, Searchlights } from '../engine/Atmosphere';
import { boxUV, MaterialLib, StaticBatcher, type LightAnchor } from '../engine/Builder';
import * as P from '../engine/props';
import type { Shelter } from '../engine/Rain';
import { GLOBAL, LAYER_REFLECT_SKIP } from '../engine/shaders';
import { canvasTexture, neonText } from '../engine/textures';
import type { Physics } from '../physics/Physics';
import type { GraphicsSettings } from '../config/settings';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const CYAN = 0x00e5ff, MAGENTA = 0xff2bd6, VIOLET = 0x8a4dff, AMBER = 0xffa31a, RED = 0xff2a3a, LIME = 0x8aff3a, YELLOW = 0xfcee0a;

export type InteractKind = 'armory' | 'vault' | 'bar' | 'gate' | 'npc' | 'kiosk';
export interface Interactable { id: string; pos: THREE.Vector3; radius: number; label: string; kind: InteractKind }
export interface NpcSpot {
  kind: 'walker' | 'clerk' | 'patron' | 'guard' | 'worker' | 'idle' | 'dancer';
  pos: THREE.Vector3; yaw: number; path?: THREE.Vector3[]; name: string; lines: string[]; shop?: InteractKind; seat?: boolean;
}

export interface CityBuild {
  group: THREE.Group;
  anchors: LightAnchor[];
  drips: THREE.Vector4[];
  shelters: Shelter[];
  interactables: Interactable[];
  npcs: NpcSpot[];
  spawn: THREE.Vector3;
  jinglePoints: THREE.Vector3[];
  chatterPoints: THREE.Vector3[];
  barPos: THREE.Vector3;
  animate: ((t: number, dt: number) => void)[];
  /** Areas under a roof (for ambience / indoor audio). */
  indoor: THREE.Box3[];
  /** Approximate walkable ground height lookup */
  groundAt: (x: number, z: number) => number;
  armoryRack: THREE.Vector3[];
  probePoint: THREE.Vector3;
  puddleMask: THREE.Texture | undefined;
}

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/** Splits rect r into the parts not covered by hole h (both [x0,z0,x1,z1]). */
function rectMinus(r: number[], h: number[]): number[][] {
  const [x0, z0, x1, z1] = r;
  const [hx0, hz0, hx1, hz1] = h;
  if (hx1 <= x0 || hx0 >= x1 || hz1 <= z0 || hz0 >= z1) return [r];
  const out: number[][] = [];
  if (hz0 > z0) out.push([x0, z0, x1, hz0]);
  if (hz1 < z1) out.push([x0, hz1, x1, z1]);
  if (hx0 > x0) out.push([x0, Math.max(z0, hz0), hx0, Math.min(z1, hz1)]);
  if (hx1 < x1) out.push([hx1, Math.max(z0, hz0), x1, Math.min(z1, hz1)]);
  return out;
}

const SIGN_WORDS_V = ['酒吧', '拉麵', '電子', '義體診所', '夜市', '賓館', '網咖', '當舖', '按摩', '藥局', '居酒屋', '龍城', '霓虹', '電腦'];
const SIGN_WORDS_H = ['KUROGANE', 'NEOTEK', 'SYNAPSE', 'HELIX BIO', 'VOLT', 'ZERO-G NOODLES', 'DATA DEN', 'MOTOKO OPTICS', 'RED LOTUS', 'NIGHTCORE', 'CHROME DOLL', 'PIXEL RAMEN'];
const NEON_COLORS = [CYAN, CYAN, 0xfcee0a, AMBER, MAGENTA, RED, 0xf2f6ff];
const css = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

function adFrame(title: string, sub: string, c1: string, c2: string, kind: number): THREE.CanvasTexture {
  return canvasTexture(512, 1024, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, c1);
    g.addColorStop(1, '#050208');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < 18; i++) {
      ctx.strokeStyle = c2;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (kind === 0) { ctx.arc(w / 2, h * 0.42, 40 + i * 14, 0, Math.PI * 2); }
      else if (kind === 1) { ctx.moveTo(0, h * 0.2 + i * 30); ctx.lineTo(w, h * 0.1 + i * 36); }
      else { ctx.rect(w / 2 - 20 - i * 10, h * 0.42 - 20 - i * 10, 40 + i * 20, 40 + i * 20); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = c2;
    ctx.shadowColor = c2;
    ctx.shadowBlur = 30;
    ctx.beginPath();
    if (kind === 0) ctx.arc(w / 2, h * 0.42, 90, 0, Math.PI * 2);
    else if (kind === 1) { ctx.moveTo(w / 2, h * 0.28); ctx.lineTo(w * 0.75, h * 0.55); ctx.lineTo(w * 0.25, h * 0.55); }
    else ctx.rect(w / 2 - 70, h * 0.42 - 70, 140, 140);
    ctx.fill();
    ctx.shadowBlur = 20;
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 76px Orbitron, Rajdhani, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, w / 2, h * 0.74);
    ctx.font = '600 34px Rajdhani, "PingFang TC", sans-serif';
    ctx.fillStyle = c2;
    ctx.fillText(sub, w / 2, h * 0.81);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '500 22px "JetBrains Mono", monospace';
    ctx.fillText('//  NEON DISTRICT  //  ' + new Array(3).fill('■').join(' '), w / 2, h * 0.92);
  });
}

function shopInterior(color: string, seed: number): THREE.CanvasTexture {
  // calm interior: lit ceiling gradient, back-lit shelving, soft silhouettes — no colour noise
  const r = rng(seed);
  return canvasTexture(256, 128, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#fff3dc');
    g.addColorStop(0.18, color);
    g.addColorStop(1, '#0c0d12');
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(10,12,18,0.55)';
    for (let i = 0; i < 3; i++) ctx.fillRect(10, 34 + i * 28, w - 20, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    for (let i = 0; i < 18; i++) ctx.fillRect(14 + r() * (w - 40), 22 + Math.floor(r() * 3) * 28, 8 + r() * 14, 11);
    ctx.fillStyle = 'rgba(6,7,10,0.8)';
    for (let i = 0; i < 2; i++) { const x = r() * (w - 30); ctx.fillRect(x, h * 0.42, 16, h * 0.58); ctx.beginPath(); ctx.arc(x + 8, h * 0.4, 7, 0, Math.PI * 2); ctx.fill(); }
  });
}

export function buildCity(physics: Physics, settings: GraphicsSettings): CityBuild {
  const L = new MaterialLib(settings);
  const group = new THREE.Group();
  const fx = new THREE.Group();
  group.add(fx);
  const anchors: LightAnchor[] = [];
  const drips: THREE.Vector4[] = [];
  const b = new StaticBatcher(physics);
  const ctx: P.PropCtx = { b, L, anchors, fx, drips };
  const rand = rng(1337);
  const interactables: Interactable[] = [];
  const npcs: NpcSpot[] = [];
  const animate: ((t: number, dt: number) => void)[] = [];
  const shelters: Shelter[] = [];
  const indoor: THREE.Box3[] = [];
  const jinglePoints: THREE.Vector3[] = [];
  const chatterPoints: THREE.Vector3[] = [];
  const armoryRack: THREE.Vector3[] = [];
  const detail = settings.particles; // 1..3

  // ================================================================= ground
  const vaultHole = [-21, 57, -9, 63];
  const groundRects = rectMinus([-125, -125, 125, 125], vaultHole);
  const ground = new StaticBatcher(physics);
  for (const r of groundRects) {
    const w = r[2] - r[0], d = r[3] - r[1];
    const geo = new THREE.PlaneGeometry(w, d);
    geo.rotateX(-Math.PI / 2);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 9 + r[0] / 9, uv.getY(i) * d / 9 + r[1] / 9);
    ground.add(geo, L.m.asphalt, V((r[0] + r[2]) / 2, 0, (r[1] + r[3]) / 2), { cast: false });
    physics.addBox(V((r[0] + r[2]) / 2, -0.5, (r[1] + r[3]) / 2), V(w / 2, 0.5, d / 2));
  }
  // raised pedestrian areas (sidewalk blocks, plaza, market lane)
  const blocks: number[][] = [
    [34, -125, 125, -6], [6, -125, 34, -34], [-125, -125, -34, -6], [-34, -125, -6, -34],
    [34, 6, 125, 125], [6, 34, 34, 125], [-125, 6, -34, 125], [-34, 34, -6, 125],
  ];
  const curbH = 0.15;
  const raised = (r: number[], mat: THREE.Material) => {
    const w = r[2] - r[0], d = r[3] - r[1];
    ground.add(boxUV(w, curbH, d, 3), mat, V((r[0] + r[2]) / 2, curbH / 2, (r[1] + r[3]) / 2), { cast: false, collide: true });
  };
  for (const r of blocks) for (const part of rectMinus(r, vaultHole)) raised(part, L.m.sidewalk);
  raised([-22, -22, 22, 22], L.m.plaza);
  raised([-125, -6, -34, 6], L.m.plaza); // night market lane
  raised([-6, -125, 6, -100], L.m.plaza); // gate forecourt (street part; blocks cover the sides)
  ground.build(group);
  // curbs (kerb stones) along block edges facing streets
  for (const r of [...blocks, [-22, -22, 22, 22]]) {
    const cx = (r[0] + r[2]) / 2, cz = (r[1] + r[3]) / 2, w = r[2] - r[0], d = r[3] - r[1];
    b.add(boxUV(w, 0.18, 0.25, 2), L.m.curb, V(cx, 0.09, r[1] + 0.12), { cast: false });
    b.add(boxUV(w, 0.18, 0.25, 2), L.m.curb, V(cx, 0.09, r[3] - 0.12), { cast: false });
    b.add(boxUV(0.25, 0.18, d, 2), L.m.curb, V(r[0] + 0.12, 0.09, cz), { cast: false });
    b.add(boxUV(0.25, 0.18, d, 2), L.m.curb, V(r[2] - 0.12, 0.09, cz), { cast: false });
  }
  // lane markings & crosswalks
  const paint = new THREE.MeshStandardMaterial({ color: 0xb8b8a8, roughness: 0.35, metalness: 0 });
  const paintY = new THREE.MeshStandardMaterial({ color: 0xc8a020, roughness: 0.35, metalness: 0 });
  for (let z = -120; z < -36; z += 6) b.add(new THREE.BoxGeometry(0.15, 0.01, 3), paintY, V(0, 0.006, z), { cast: false });
  for (let z = 38; z < 120; z += 6) b.add(new THREE.BoxGeometry(0.15, 0.01, 3), paintY, V(0, 0.006, z), { cast: false });
  for (let x = 38; x < 120; x += 6) b.add(new THREE.BoxGeometry(3, 0.01, 0.15), paintY, V(x, 0.006, 0), { cast: false });
  for (const [cx, cz, alongX] of [[0, -28, true], [0, 28, true], [28, 0, false], [-28, 0, false]] as const) {
    for (let i = -5; i <= 5; i++) {
      if (alongX) b.add(new THREE.BoxGeometry(0.6, 0.01, 4.5), paint, V(cx + i * 1.1, 0.006, cz), { cast: false });
      else b.add(new THREE.BoxGeometry(4.5, 0.01, 0.6), paint, V(cx, 0.006, cz + i * 1.1), { cast: false });
    }
  }

  // ================================================================= towers
  const facades = [L.m.facadeOffice, L.m.facadeOffice2, L.m.facadeRes, L.m.facadeRes2, L.m.facadeInd];
  const reserved: number[][] = [
    [8, -68, 32, -42],      // bar
    [44, -32, 72, -8],      // armory
    [-42, 48, -6, 72],      // black vault area
    [-24, -125, 24, -98],   // gate
    [-125, -12, -30, 12],   // market lane + stalls
  ];
  const overlaps = (a: number[], bb: number[]) => !(a[2] <= bb[0] || a[0] >= bb[2] || a[3] <= bb[1] || a[1] >= bb[3]);
  const signTexCache = new Map<string, THREE.Texture>();
  const signTex = (text: string, color: number, vertical: boolean) => {
    const k = `${text}|${color}|${vertical}`;
    let t = signTexCache.get(k);
    if (!t) {
      t = vertical
        ? neonText(text, css(color), { w: 128, h: 128 * Math.max(2, [...text].length), vertical: true, bg: '#08040c' })
        : neonText(text, css(color), { w: 512, h: 128, bg: '#06060a', frame: rand() > 0.5 });
      signTexCache.set(k, t);
    }
    return t;
  };
  const addVerticalSign = (pos: THREE.Vector3, yaw: number, text: string, color: number) => {
    const n = [...text].length;
    const h = Math.max(2.2, n * 1.1);
    const geo = new THREE.BoxGeometry(0.9, h, 0.14);
    b.add(geo, L.m.metalDark, pos, { rotY: yaw });
    const face = new THREE.PlaneGeometry(0.84, h - 0.08);
    const mat = L.sign(signTex(text, color, true), 2.6);
    const off = new THREE.Vector3(0, 0, 0.075).applyAxisAngle(V(0, 1, 0), yaw);
    b.add(face, mat, pos.clone().add(off), { rotY: yaw, cast: false });
    b.add(face, mat, pos.clone().sub(off), { rotY: yaw + Math.PI, cast: false });
    anchors.push({ pos: pos.clone(), color: new THREE.Color(color), intensity: 26 + h * 6, distance: 10, kind: 'point' });
  };
  const addHorizontalSign = (pos: THREE.Vector3, yaw: number, text: string, color: number, w = 6) => {
    const h = w / 4;
    b.add(new THREE.BoxGeometry(w + 0.2, h + 0.2, 0.2), L.m.metalDark, pos, { rotY: yaw });
    const off = new THREE.Vector3(0, 0, 0.105).applyAxisAngle(V(0, 1, 0), yaw);
    b.add(new THREE.PlaneGeometry(w, h), L.sign(signTex(text, color, false), 2.4), pos.clone().add(off), { rotY: yaw, cast: false });
    anchors.push({ pos: pos.clone().add(off.clone().multiplyScalar(12)), color: new THREE.Color(color), intensity: 40 + w * 5, distance: 12, kind: 'point' });
  };

  const interiorCache = new Map<number, THREE.Texture>();
  const interiorTex = (col: number) => {
    let t = interiorCache.get(col);
    if (!t) { t = shopInterior(css(col), col); interiorCache.set(col, t); }
    return t;
  };
  const adTextures = [
    [adFrame('SYNAPSE', '思考，更快。', '#3a0a4a', '#ff2bd6', 0), adFrame('HELIX', 'BIO-UPGRADE 2077', '#082a3a', '#00e5ff', 1), adFrame('VOLT', '永不斷電', '#3a1a04', '#ffa31a', 2)],
    [adFrame('KUROGANE', 'ARMS & ARMOR', '#2a0408', '#ff2a3a', 2), adFrame('NIGHTCORE', '夜之城電台 88.1', '#14063a', '#8a4dff', 0), adFrame('ZERO-G', 'NOODLES 24/7', '#04301a', '#8aff3a', 1)],
  ];
  const addBillboard = (pos: THREE.Vector3, yaw: number, w: number, h: number, set: number) => {
    const frames = adTextures[set % adTextures.length];
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), P.billboardMaterial(frames, 2.0));
    m.position.copy(pos);
    m.rotation.y = yaw;
    group.add(m);
    b.add(new THREE.BoxGeometry(w + 0.6, h + 0.6, 0.4), L.m.metalDark, pos.clone().add(new THREE.Vector3(0, 0, -0.25).applyAxisAngle(V(0, 1, 0), yaw)), { rotY: yaw });
    const fwd = new THREE.Vector3(0, 0, 1).applyAxisAngle(V(0, 1, 0), yaw);
    anchors.push({ pos: pos.clone().addScaledVector(fwd, 4), color: new THREE.Color(set % 2 ? 0xff40c0 : 0x40c0ff), intensity: 120, distance: 22, kind: 'point' });
    jinglePoints.push(pos.clone());
  };

  // curated brand palette (weighted): cyan and Night-City yellow dominate, magenta / red as accents
  const BRAND = [CYAN, CYAN, CYAN, YELLOW, YELLOW, AMBER, MAGENTA, MAGENTA, 0xf2f6ff, RED];
  const tower = (x0: number, z0: number, x1: number, z1: number, height: number, facing: number[]) => {
    const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const fac = facades[Math.floor(rand() * facades.length)];
    const brand = BRAND[Math.floor(rand() * BRAND.length)];
    const podiumH = 5.2;
    b.box(L.m.concreteDark, [cx, curbH + podiumH / 2, cz], [w, podiumH, d], { tile: 4 });
    // tower body with setbacks
    let y = curbH + podiumH;
    let tw = w - 1, td = d - 1;
    let remaining = height - podiumH;
    let tier = 0;
    const edgeLit = rand() > 0.72;
    while (remaining > 4 && tier < 3) {
      const h = tier === 2 ? remaining : remaining * (0.45 + rand() * 0.3);
      b.add(boxUV(tw, h, td, 20), fac, V(cx, y + h / 2, cz), { collide: tier === 0 });
      b.add(boxUV(tw + 0.5, 0.45, td + 0.5, 2), L.m.metal, V(cx, y + h, cz));
      if (edgeLit) {
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          P.neonBar(ctx, V(cx + sx * tw / 2, y, cz + sz * td / 2), V(cx + sx * tw / 2, y + h, cz + sz * td / 2), brand, 0.06, false);
        }
      }
      y += h;
      remaining -= h;
      tw *= 0.8;
      td *= 0.8;
      tier++;
    }
    // tidy roof: one plant box, optional antenna with a warning light
    b.add(boxUV(tw * 0.4, 2.2, td * 0.3, 2), L.m.metal, V(cx, y + 1.1, cz));
    if (rand() > 0.5) {
      const ah = 8 + rand() * 14;
      b.add(new THREE.CylinderGeometry(0.06, 0.12, ah, 6), L.m.metal, V(cx + tw * 0.25, y + ah / 2, cz));
      b.add(new THREE.SphereGeometry(0.28, 8, 6), L.neon(RED, 6), V(cx + tw * 0.25, y + ah, cz), { cast: false });
    }
    for (const dir of facing) {
      const yaw = [0, Math.PI / 2, Math.PI, -Math.PI / 2][dir]; // 0:+z 1:+x 2:-z 3:-x
      const n = new THREE.Vector3(0, 0, 1).applyAxisAngle(V(0, 1, 0), yaw);
      const t = new THREE.Vector3(1, 0, 0).applyAxisAngle(V(0, 1, 0), yaw);
      const half = dir % 2 === 0 ? d / 2 : w / 2;
      const span = dir % 2 === 0 ? w : d;
      const face = V(cx, 0, cz).addScaledVector(n, half);
      // storefront: continuous glazing between slim mullions, lit interior
      const shops = Math.max(1, Math.floor(span / 8));
      for (let i = 0; i < shops; i++) {
        const off = -span / 2 + (i + 0.5) * (span / shops);
        const p = face.clone().addScaledVector(t, off);
        const sw = span / shops - 0.5;
        b.add(new THREE.PlaneGeometry(sw, 3.4), L.sign(interiorTex(i % 2 ? brand : 0xffe3b0), 0.9), p.clone().add(V(0, curbH + 1.85, 0)).addScaledVector(n, 0.03), { rotY: yaw, cast: false });
        b.add(new THREE.BoxGeometry(sw, 3.5, 0.05), L.m.glass, p.clone().add(V(0, curbH + 1.85, 0)).addScaledVector(n, 0.14), { rotY: yaw, cast: false });
        b.add(new THREE.BoxGeometry(0.16, 3.6, 0.22), L.m.metalDark, p.clone().addScaledVector(t, sw / 2 + 0.2).add(V(0, curbH + 1.85, 0)).addScaledVector(n, 0.12), { rotY: yaw });
      }
      // one continuous canopy per facade with a warm down-light strip and a brand-colour edge
      const cp = face.clone().addScaledVector(n, 1.1).setY(curbH + 3.95);
      b.add(new THREE.BoxGeometry(span, 0.16, 2.2), L.m.metalDark, cp, { rotY: yaw });
      b.add(new THREE.BoxGeometry(span - 0.4, 0.03, 0.08), L.neon(0xffd9a0, 3), cp.clone().add(V(0, -0.1, 0)).addScaledVector(n, 0.4), { rotY: yaw, cast: false });
      P.neonBar(ctx, cp.clone().addScaledVector(n, 1.1).addScaledVector(t, -span / 2), cp.clone().addScaledVector(n, 1.1).addScaledVector(t, span / 2), brand, 0.025, false);
      anchors.push({ pos: cp.clone().addScaledVector(n, 0.6).add(V(0, -1.2, 0)), color: new THREE.Color(0xffd2a0), intensity: 22, distance: 8, kind: 'point' });
      for (let k = 0; k < Math.floor(span / 4); k++) {
        const dp = cp.clone().addScaledVector(n, 1.1).addScaledVector(t, -span / 2 + (k + 0.5) * 4).add(V(0, -0.1, 0));
        drips.push(new THREE.Vector4(dp.x, dp.y, dp.z, dp.y - curbH));
      }
      // signage: at most one blade sign and one brand sign per facade
      if (rand() > 0.45) {
        const word = SIGN_WORDS_V[Math.floor(rand() * SIGN_WORDS_V.length)];
        const sy = curbH + podiumH + 3 + rand() * 5 + [...word].length * 0.55;
        const p = face.clone().addScaledVector(t, (rand() - 0.5) * span * 0.6).addScaledVector(n, 0.9).setY(sy);
        addVerticalSign(p, yaw + Math.PI / 2, word, brand);
      }
      if (rand() > 0.55) {
        const word = SIGN_WORDS_H[Math.floor(rand() * SIGN_WORDS_H.length)];
        addHorizontalSign(face.clone().addScaledVector(n, 0.2).setY(curbH + podiumH + 1.5), yaw, word, brand, Math.min(span * 0.6, 9));
      }
      for (let i = 0; i < Math.floor(span / 12); i++) {
        if (rand() > 0.4) continue;
        P.acUnit(ctx, face.clone().addScaledVector(t, -span / 2 + 2 + rand() * (span - 4)).addScaledVector(n, 0.32).setY(curbH + podiumH + 4 + rand() * Math.min(20, height - 12)), yaw);
      }
    }
  };

  // place towers in each block on a grid of lots, skipping reserved areas and keeping 4 m sidewalks
  const lot = (r: number[], streetSides: number[]) => {
    const margin = 4;
    const x0 = r[0] + margin, z0 = r[1] + margin, x1 = r[2] - margin, z1 = r[3] - margin;
    let x = x0;
    while (x < x1 - 8) {
      const lw = Math.min(x1 - x, 14 + rand() * 12);
      let z = z0;
      while (z < z1 - 8) {
        const ld = Math.min(z1 - z, 14 + rand() * 12);
        const rect = [x, z, x + lw - 1.5, z + ld - 1.5];
        if (!reserved.some((rr) => overlaps(rr, rect))) {
          const distC = Math.hypot((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2);
          const h = distC < 70 ? 35 + rand() * 75 : 22 + rand() * 50;
          // facing: which faces are near a street (block edge on street side)
          const facing: number[] = [];
          if (streetSides.includes(0) && rect[3] > r[3] - margin - 2) facing.push(0);
          if (streetSides.includes(1) && rect[2] > r[2] - margin - 2) facing.push(1);
          if (streetSides.includes(2) && rect[1] < r[1] + margin + 2) facing.push(2);
          if (streetSides.includes(3) && rect[0] < r[0] + margin + 2) facing.push(3);
          tower(rect[0], rect[1], rect[2], rect[3], h, facing);
        }
        z += ld;
      }
      x += lw;
    }
  };
  // sides: 0:+z 1:+x 2:-z 3:-x facing streets
  lot([34, -125, 125, -6], [0, 3]);
  lot([6, -125, 34, -34], [0, 3]);
  lot([-125, -125, -34, -6], [0, 1]);
  lot([-34, -125, -6, -34], [0, 1]);
  lot([34, 6, 125, 125], [2, 3]);
  lot([6, 34, 34, 125], [2, 3]);
  lot([-125, 6, -34, 125], [1, 2]);
  lot([-34, 34, -6, 125], [1, 2]);

  // ================================================================= CENTRAL PLAZA
  // hologram statue on a pedestal
  b.add(new THREE.CylinderGeometry(3.2, 3.6, 0.8, 32), L.m.metalDark, V(0, 0.55, 0), { collide: true });
  b.add(new THREE.TorusGeometry(3.22, 0.035, 6, 64).rotateX(Math.PI / 2), L.neon(CYAN, 3), V(0, 0.96, 0), { cast: false });
  b.add(new THREE.CylinderGeometry(1.0, 1.2, 0.5, 24), L.m.chrome, V(0, 1.2, 0));
  const statue = Assets.character({ jacket: 0, visor: 0, trim: 0 });
  statue.root.scale.setScalar(3.2);
  statue.root.position.set(0, 1.45, 0);
  const holo = P.holoMaterial(CYAN, 1.1);
  statue.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { (o as THREE.Mesh).material = holo; (o as THREE.Mesh).castShadow = false; } });
  statue.actions.get('Wave')?.play();
  group.add(statue.root);
  anchors.push({ pos: V(0, 5, 0), color: new THREE.Color(CYAN), intensity: 60, distance: 20, kind: 'point' });
  animate.push((t, dt) => { statue.root.rotation.y = t * 0.25; statue.mixer.update(dt * 0.5); });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(4.2, 0.04, 8, 96), holo);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 3;
  group.add(ring);
  animate.push((t) => { ring.position.y = 2 + Math.sin(t * 0.8) * 2.5 + 2.5; ring.scale.setScalar(1 + Math.sin(t * 0.8) * 0.15); });
  interactables.push({ id: 'kiosk', pos: V(7, 0, 15), radius: 2.5, label: 'Read the CITY DIRECTORY', kind: 'kiosk' });
  // directory kiosk
  b.add(boxUV(1.4, 2.2, 0.4, 1), L.m.metal, V(7, 1.25, 16), { collide: true });
  b.add(new THREE.PlaneGeometry(1.2, 1.5), L.sign(neonText('CITY ⟶ GUIDE', '#00e5ff', { w: 256, h: 320, bg: '#021018', frame: true }), 1.6), V(7, 1.45, 15.79), { rotY: Math.PI, cast: false });
  // benches ring & planters
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    P.bench(ctx, V(Math.cos(a) * 9, curbH, Math.sin(a) * 9), -a + Math.PI / 2);
  }
  for (const [x, z] of [[-15, -15], [15, -15], [-15, 15], [15, 15]]) {
    // low stone planter with dense shrubs and a slim light pillar
    b.add(boxUV(4.6, 0.7, 4.6, 2), L.m.concrete, V(x, curbH + 0.35, z), { collide: true });
    b.add(new THREE.BoxGeometry(4.62, 0.04, 4.62), L.neon(0xffd9a0, 1.6), V(x, curbH + 0.7, z), { cast: false });
    for (let k = 0; k < 7; k++) b.add(new THREE.IcosahedronGeometry(0.55 + rand() * 0.35, 0), L.m.foliage, V(x + (rand() - 0.5) * 3.2, curbH + 0.95, z + (rand() - 0.5) * 3.2));
    b.add(new THREE.CylinderGeometry(0.12, 0.12, 6.5, 12), L.m.metalDark, V(x, curbH + 3.95, z), { collide: true });
    for (let k = 0; k < 4; k++) b.add(new THREE.CylinderGeometry(0.13, 0.13, 0.9, 12), L.neon(CYAN, 2.2), V(x, curbH + 2 + k * 1.5, z), { cast: false });
    anchors.push({ pos: V(x, 4, z), color: new THREE.Color(0xa8f4ff), intensity: 28, distance: 10, kind: 'point' });
    P.streetLamp(ctx, V(x * 1.25, curbH, z * 0.6), Math.atan2(-x, -z) + Math.PI, 0xffd28a);
  }
  // fountain pool (water reflects via the wet shader with full puddle strength)
  const water = new THREE.Mesh(new THREE.CircleGeometry(2.6, 48).rotateX(-Math.PI / 2), L.m.plaza);
  for (const [x, z] of [[-16, 0], [16, 0]]) {
    b.add(new THREE.TorusGeometry(2.8, 0.25, 8, 40).rotateX(Math.PI / 2), L.m.concreteDark, V(x, curbH + 0.25, z), { collide: false });
    physics.addCylinder(V(x, 0.4, z), 0.25, 3);
    const w = water.clone();
    w.position.set(x, curbH + 0.2, z);
    w.layers.set(LAYER_REFLECT_SKIP);
    group.add(w);
    P.neonBar(ctx, V(x, curbH + 0.52, z - 2.5), V(x, curbH + 0.52, z + 2.5), CYAN, 0.03, false);
    anchors.push({ pos: V(x, 2.2, z), color: new THREE.Color(CYAN), intensity: 14, distance: 8, kind: 'point' });
  }
  // street lamps around ring
  for (let i = -3; i <= 3; i++) {
    const s = i * 10;
    P.streetLamp(ctx, V(s, curbH, -21), Math.PI, 0xffd28a);
    P.streetLamp(ctx, V(s, curbH, 21), 0, 0xffd28a);
    if (Math.abs(s) > 6) { P.streetLamp(ctx, V(-21, curbH, s), -Math.PI / 2, 0xffd28a); P.streetLamp(ctx, V(21, curbH, s), Math.PI / 2, 0xffd28a); }
  }
  // big billboards on the corner towers facing the plaza
  addBillboard(V(37, 22, -37), -Math.PI / 4, 9, 18, 0);
  addBillboard(V(-37, 24, -37), Math.PI / 4, 9, 18, 1);
  addBillboard(V(37, 20, 37), -Math.PI * 0.75, 8, 16, 1);
  addBillboard(V(-37, 21, 37), Math.PI * 0.75, 8, 16, 0);
  chatterPoints.push(V(0, 1.5, 10));

  // ================================================================= NIGHT MARKET (west lane)
  for (let x = -40; x > -108; x -= 6.5) {
    for (const side of [-1, 1]) {
      const z = side * 4.6;
      const yaw = side > 0 ? Math.PI : 0;
      const col = NEON_COLORS[Math.floor(rand() * NEON_COLORS.length)];
      // stall counter + frame + canopy
      b.box(L.m.metal, [x, curbH + 0.5, z], [4.2, 1.0, 1.4], { tile: 1.5 });
      b.add(new THREE.BoxGeometry(4.2, 0.04, 0.04), L.neon(col, 3), V(x, curbH + 1.02, z - side * 0.72), { cast: false });
      for (const sx of [-2, 2]) b.add(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 6), L.m.metalDark, V(x + sx, curbH + 1.3, z - side * 0.6));
      const canopy = new THREE.BoxGeometry(4.6, 0.06, 2.6);
      b.add(canopy, rand() > 0.5 ? L.m.fabric : L.m.metalBlue, V(x, curbH + 2.75, z - side * 0.2), { rot: new THREE.Euler(side * 0.16, 0, 0) });
      for (let k = 0; k < 2; k++) { const dp = V(x + (rand() - 0.5) * 4, curbH + 2.55, z - side * 1.45); drips.push(new THREE.Vector4(dp.x, dp.y, dp.z, dp.y - curbH)); }
      // goods on the counter (instanced via batcher)
      for (let k = 0; k < 6; k++) b.add(new THREE.BoxGeometry(0.25, 0.2 + rand() * 0.3, 0.25), k % 2 ? L.m.plastic : L.m.metalBlue, V(x - 1.6 + k * 0.62, curbH + 1.2, z), { cast: true });
      // stall sign
      const word = SIGN_WORDS_V[Math.floor(rand() * SIGN_WORDS_V.length)];
      const tex = neonText(word, css(col), { w: 512, h: 128, bg: '#060308' });
      b.add(new THREE.PlaneGeometry(2.4, 0.6), L.sign(tex, 2.2), V(x, curbH + 3.15, z - side * 1.52), { rotY: yaw, cast: false });
      anchors.push({ pos: V(x, curbH + 2.2, z - side * 1.5), color: new THREE.Color(col), intensity: 8, distance: 6, kind: 'point' });
      if (rand() > 0.4) npcs.push({ kind: 'clerk', pos: V(x, curbH, z + side * 1.2), yaw: side > 0 ? Math.PI : 0, name: 'Vendor', lines: ['Fresh synth-noodles! Real soy, almost.', 'Chrome bits, cheap. No questions.', 'Rain\'s been falling for nine years, choom.'] });
    }
    // lantern strings across the lane
    const a = V(x, curbH + 5.5, -6.5), c2 = V(x - 3.25, curbH + 5.5, 6.5);
    P.cable(ctx, a, c2, 1.0);
    for (let k = 1; k < 6; k++) {
      const t = k / 6;
      const p = a.clone().lerp(c2, t).add(V(0, -Math.sin(t * Math.PI) * 1.0 - 0.25, 0));
      const col = k % 2 ? RED : AMBER;
      b.add(new THREE.SphereGeometry(0.22, 10, 8), L.neon(col, 2.2), p, { cast: false });
      if (k === 3) anchors.push({ pos: p, color: new THREE.Color(col), intensity: 6, distance: 7, kind: 'point' });
    }
    chatterPoints.length < 6 && x % 13 === 0 && chatterPoints.push(V(x, 1.6, 0));
  }
  chatterPoints.push(V(-60, 1.6, 0), V(-90, 1.6, 0));
  // market gateway arch + big end screen
  b.box(L.m.lacquer, [-36, 4, -6.2], [0.8, 8, 0.8]);
  b.box(L.m.lacquer, [-36, 4, 6.2], [0.8, 8, 0.8]);
  b.box(L.m.lacquer, [-36, 8.3, 0], [1.2, 0.8, 15]);
  addHorizontalSign(V(-35.3, 8.3, 0), Math.PI / 2, '夜市 NIGHT MARKET', MAGENTA, 10);
  b.box(L.m.concreteDark, [-114, 7, 0], [2, 14, 16]);
  addBillboard(V(-112.8, 8, 0), Math.PI / 2, 12, 9, 1);
  for (let i = 0; i < detail * 2; i++) group.add(fogLayer(V(-70 + i * 12, 3.5 + i, (i % 2) * 2), 26, 0x4a2a60, 0.15));

  // ================================================================= AFTERLIFE BAR  (x 10..30, z −66..−44), door on west face
  {
    const x0 = 10, x1 = 30, z0 = -66, z1 = -44, h = 6;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const wall = L.m.concreteDark;
    b.box(wall, [cx, curbH + h / 2, z0], [x1 - x0, h, 0.4]);           // north
    b.box(wall, [cx, curbH + h / 2, z1], [x1 - x0, h, 0.4]);           // south
    b.box(wall, [x1, curbH + h / 2, cz], [0.4, h, z1 - z0]);           // east
    // west wall with door gap (z −57.5 .. −53.5)
    b.box(wall, [x0, curbH + h / 2, (z0 - 57.5) / 2], [0.4, h, -57.5 - z0]);
    b.box(wall, [x0, curbH + h / 2, (-53.5 + z1) / 2], [0.4, h, z1 + 53.5]);
    b.box(wall, [x0, curbH + h - 1, -55.5], [0.4, 2, 4]);
    b.box(L.m.metalDark, [cx, curbH + h + 0.2, cz], [x1 - x0 + 0.6, 0.4, z1 - z0 + 0.6]); // roof
    // upper floors (apartments) above the bar
    b.add(boxUV(x1 - x0, 24, z1 - z0, 12), L.m.facadeRes, V(cx, curbH + h + 12.4, cz), { collide: true });
    // interior lining (lighter walls so the neon spill reads)
    b.add(boxUV(0.05, h - 0.2, z1 - z0 - 0.9, 3), L.m.wallIndoor, V(x1 - 0.25, curbH + h / 2, cz), { cast: false, collide: false });
    b.add(boxUV(x1 - x0 - 0.9, h - 0.2, 0.05, 3), L.m.wallIndoor, V(cx, curbH + h / 2, z0 + 0.25), { cast: false, collide: false });
    b.add(boxUV(x1 - x0 - 0.9, h - 0.2, 0.05, 3), L.m.wallIndoor, V(cx, curbH + h / 2, z1 - 0.25), { cast: false, collide: false });
    // interior
    b.add(boxUV(x1 - x0 - 0.8, 0.02, z1 - z0 - 0.8, 3), L.m.floorIndoor, V(cx, curbH + 0.01, cz), { cast: false, collide: false });
    b.add(boxUV(x1 - x0 - 0.8, 0.1, z1 - z0 - 0.8, 3), L.m.wallIndoor, V(cx, curbH + h - 0.1, cz), { cast: false, collide: false });
    // bar counter along east wall
    b.box(L.m.lacquer, [26.5, curbH + 0.55, cz], [1.2, 1.1, 14], { tile: 2 });
    b.add(new THREE.BoxGeometry(1.3, 0.05, 14.1), L.m.chrome, V(26.5, curbH + 1.12, cz));
    P.neonBar(ctx, V(25.85, curbH + 0.2, cz - 7), V(25.85, curbH + 0.2, cz + 7), MAGENTA, 0.03);
    // back shelves with glowing bottles
    for (let i = 0; i < 3; i++) b.add(new THREE.BoxGeometry(0.4, 0.05, 12), L.m.metal, V(29.5, curbH + 1.6 + i * 0.7, cz));
    for (let i = 0; i < 36; i++) b.add(new THREE.CylinderGeometry(0.05, 0.06, 0.32, 8), L.neon(NEON_COLORS[i % 7], 1.2), V(29.5, curbH + 1.8 + (i % 3) * 0.7, cz - 5.5 + Math.floor(i / 3) * 0.95), { cast: false });
    // stools
    for (let i = 0; i < 6; i++) {
      const z = cz - 5 + i * 2;
      b.add(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 14), L.m.lacquer, V(25.2, curbH + 0.75, z));
      b.add(new THREE.CylinderGeometry(0.04, 0.04, 0.72, 6), L.m.chrome, V(25.2, curbH + 0.36, z));
      if (i % 2 === 0) npcs.push({ kind: 'patron', pos: V(24.4, curbH, z + 0.6), yaw: -Math.PI / 2, name: ['Ghost', 'Nix', 'Vera', 'Kade'][i % 4], seat: true, lines: ['They say SECTOR 09 still has live wiring. Bring armor.', 'Drinks here cost more than my cyberarm.', 'The Tactical Gate is north. Grab a crew first.'] });
    }
    // booths
    for (const z of [cz - 7, cz + 7]) {
      b.box(L.m.fabric, [14, curbH + 0.45, z], [3, 0.9, 1.2]);
      b.box(L.m.lacquer, [14, curbH + 0.75, z + (z < cz ? 1.4 : -1.4)], [1.4, 0.08, 1.0]);
    }
    npcs.push({ kind: 'clerk', pos: V(28, curbH, cz), yaw: Math.PI / 2, name: 'Bartender Rho', shop: 'bar', lines: ['What\'ll it be?'] });
    npcs.push({ kind: 'dancer', pos: V(17, curbH, cz - 2), yaw: 0, name: 'Dancer', lines: ['♪ ♪ ♪'] });
    npcs.push({ kind: 'dancer', pos: V(18.5, curbH, cz + 1.5), yaw: 2, name: 'Dancer', lines: ['Feel that bass?'] });
    // dance floor
    const df = new THREE.Mesh(new THREE.PlaneGeometry(6, 6).rotateX(-Math.PI / 2), P.holoMaterial(VIOLET, 0.45));
    df.position.set(17.5, curbH + 0.03, cz);
    group.add(df);
    anchors.push({ pos: V(17.5, curbH + 4, cz), color: new THREE.Color(VIOLET), intensity: 45, distance: 12, kind: 'point' });
    anchors.push({ pos: V(25, curbH + 4, cz), color: new THREE.Color(MAGENTA), intensity: 40, distance: 10, kind: 'point' });
    anchors.push({ pos: V(14, curbH + 4, cz - 7), color: new THREE.Color(CYAN), intensity: 25, distance: 8, kind: 'point' });
    // facade sign
    addHorizontalSign(V(9.6, curbH + 7.2, -55.5), -Math.PI / 2, 'AFTERLIFE', MAGENTA, 8);
    addVerticalSign(V(9, curbH + 11, -48), 0, '酒吧', RED);
    P.neonBar(ctx, V(9.7, curbH + 4.1, -57.7), V(9.7, curbH + 4.1, -53.3), MAGENTA, 0.04);
    shelters.push({ min: V(x0, -1, z0), max: V(x1, curbH + h, z1) });
    indoor.push(new THREE.Box3(V(x0, -1, z0), V(x1, curbH + h, z1)));
    interactables.push({ id: 'bar', pos: V(25.4, 0, cz), radius: 2.6, label: 'Order a drink', kind: 'bar' });
    chatterPoints.push(V(cx, 1.5, cz));
  }
  const barPos = V(20, 2, -55);

  // ================================================================= ARMORY (x 46..70, z −30..−10), door on south face
  {
    const x0 = 46, x1 = 70, z0 = -30, z1 = -10, h = 7;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const wall = L.m.metalDark;
    b.box(wall, [cx, curbH + h / 2, z0], [x1 - x0, h, 0.4]);
    b.box(wall, [x0, curbH + h / 2, cz], [0.4, h, z1 - z0]);
    b.box(wall, [x1, curbH + h / 2, cz], [0.4, h, z1 - z0]);
    b.box(wall, [(x0 + 56) / 2, curbH + h / 2, z1], [56 - x0, h, 0.4]);
    b.box(wall, [(64 + x1) / 2, curbH + h / 2, z1], [x1 - 64, h, 0.4]);
    b.box(wall, [60, curbH + h - 1.25, z1], [8, 2.5, 0.4]);
    b.box(L.m.metal, [cx, curbH + h + 0.2, cz], [x1 - x0 + 0.6, 0.4, z1 - z0 + 0.6]);
    b.add(boxUV(x1 - x0, 30, z1 - z0, 12), L.m.facadeInd, V(cx, curbH + h + 15.4, cz), { collide: true });
    b.add(boxUV(x1 - x0 - 0.8, 0.02, z1 - z0 - 0.8, 2), L.m.grating, V(cx, curbH + 0.01, cz), { cast: false, collide: false });
    // counter + glass display cases
    b.box(L.m.metal, [cx, curbH + 0.55, -22], [10, 1.1, 1.2], { tile: 2 });
    b.add(new THREE.BoxGeometry(10, 0.5, 1.2), L.m.glass, V(cx, curbH + 1.35, -22), { cast: false });
    P.neonBar(ctx, V(cx - 5, curbH + 1.12, -21.38), V(cx + 5, curbH + 1.12, -21.38), CYAN, 0.025);
    // weapon wall racks (actual weapon models)
    const rackModels = ['rifle', 'smg', 'sniper', 'shotgun', 'pistol', 'rifle', 'smg', 'sniper'];
    rackModels.forEach((m, i) => {
      const p = V(cx - 8.5 + i * 2.4, curbH + 3.2, z0 + 0.45);
      const w = Assets.weapon(m, ['stock', 'chrome', 'magenta', 'hazard', 'ghost'][i % 5]);
      w.position.copy(p);
      w.rotation.set(0, Math.PI / 2, 0);
      w.scale.setScalar(1.6);
      group.add(w);
      armoryRack.push(p);
      b.add(new THREE.BoxGeometry(2.0, 0.04, 0.3), L.neon(CYAN, 1.4), p.clone().add(V(0, -0.45, 0.1)), { cast: false });
    });
    b.box(L.m.metalBlue, [cx, curbH + 3.2, z0 + 0.25], [21, 3.6, 0.1]);
    // crates
    for (let i = 0; i < 6; i++) P.crate(ctx, V(x0 + 2 + (i % 3) * 1.3, curbH, z1 - 2.5 - Math.floor(i / 3) * 1.3), 1.1, 0.2 * i, L.m.containerYellow);
    npcs.push({ kind: 'clerk', pos: V(cx, curbH, -23.4), yaw: 0, name: 'Quartermaster Voss', shop: 'armory', lines: ['Look but don\'t touch. Unless you\'re buying.'] });
    npcs.push({ kind: 'guard', pos: V(65, curbH, -12), yaw: 0.3, name: 'Armory Guard', lines: ['Keep your hands where I can see them.'] });
    anchors.push({ pos: V(cx, curbH + 5.5, -18), color: new THREE.Color(0xd8f0ff), intensity: 70, distance: 14, kind: 'point' });
    anchors.push({ pos: V(cx, curbH + 4, -27), color: new THREE.Color(CYAN), intensity: 40, distance: 10, kind: 'point' });
    addHorizontalSign(V(60, curbH + 8.2, -9.65), 0, 'ARMORY', CYAN, 8);
    addVerticalSign(V(48, curbH + 12, -9.2), Math.PI / 2, '武器', AMBER);
    shelters.push({ min: V(x0, -1, z0), max: V(x1, curbH + h, z1) });
    indoor.push(new THREE.Box3(V(x0, -1, z0), V(x1, curbH + h, z1)));
    interactables.push({ id: 'armory', pos: V(cx, 0, -20.5), radius: 2.8, label: 'Browse the ARMORY', kind: 'armory' });
  }

  // ================================================================= BLACK VAULT (stairs down to y = −4)
  {
    const floorY = -4;
    // stair ramp (collider is a rotated box)
    const sx0 = -21, sx1 = -9, sz0 = 57, sz1 = 63;
    const run = sx1 - sx0, rise = curbH - floorY;
    const len = Math.hypot(run, rise);
    const ang = Math.atan2(rise, run);
    const rampGeo = new THREE.BoxGeometry(len, 0.3, sz1 - sz0);
    const rampPos = V((sx0 + sx1) / 2, (curbH + floorY) / 2 - 0.15, (sz0 + sz1) / 2);
    b.add(rampGeo, L.m.grating, rampPos, { rot: new THREE.Euler(0, 0, ang), collide: true });
    // step visuals
    for (let i = 0; i < 16; i++) {
      const t = (i + 0.5) / 16;
      b.add(new THREE.BoxGeometry(run / 16, 0.05, sz1 - sz0), L.neon(i % 4 === 0 ? RED : 0x200408, i % 4 === 0 ? 1.5 : 0.3), V(sx0 + run * t, floorY + rise * t + 0.02, (sz0 + sz1) / 2), { rot: new THREE.Euler(0, 0, ang), cast: false });
    }
    // stairwell walls
    b.box(L.m.concreteDark, [(sx0 + sx1) / 2, floorY / 2, sz0 - 0.2], [run, -floorY + 1.4, 0.4]);
    b.box(L.m.concreteDark, [(sx0 + sx1) / 2, floorY / 2, sz1 + 0.2], [run, -floorY + 1.4, 0.4]);
    // railing at street level
    b.box(L.m.metalDark, [(sx0 + sx1) / 2, curbH + 0.55, sz0 - 0.2], [run, 1.1, 0.1]);
    b.box(L.m.metalDark, [(sx0 + sx1) / 2, curbH + 0.55, sz1 + 0.2], [run, 1.1, 0.1]);
    b.box(L.m.metalDark, [sx0 - 0.2, curbH + 0.55, (sz0 + sz1) / 2], [0.1, 1.1, sz1 - sz0]);
    // underground room x −40..−21, z 50..70
    const rx0 = -40, rx1 = -21, rz0 = 50, rz1 = 70, rh = 3.6;
    b.add(boxUV(rx1 - rx0, 0.4, rz1 - rz0, 3), L.m.concreteDark, V((rx0 + rx1) / 2, floorY - 0.2, (rz0 + rz1) / 2), { collide: true, cast: false });
    b.add(boxUV(rx1 - rx0, 0.3, rz1 - rz0, 3), L.m.concreteDark, V((rx0 + rx1) / 2, floorY + rh + 0.15, (rz0 + rz1) / 2), { collide: true });
    b.box(L.m.concreteDark, [rx0, floorY + rh / 2, (rz0 + rz1) / 2], [0.4, rh, rz1 - rz0]);
    b.box(L.m.concreteDark, [(rx0 + rx1) / 2, floorY + rh / 2, rz0], [rx1 - rx0, rh, 0.4]);
    b.box(L.m.concreteDark, [(rx0 + rx1) / 2, floorY + rh / 2, rz1], [rx1 - rx0, rh, 0.4]);
    b.box(L.m.concreteDark, [rx1, floorY + rh / 2, (rz0 + sz0) / 2], [0.4, rh, sz0 - rz0]);
    b.box(L.m.concreteDark, [rx1, floorY + rh / 2, (sz1 + rz1) / 2], [0.4, rh, rz1 - sz1]);
    // pipes on the ceiling, cages, crates, merchant
    for (let i = 0; i < 4; i++) P.pipeRun(ctx, V(rx0, floorY + rh - 0.3 - i * 0.18, rz0 + 2 + i * 0.4), V(rx1, floorY + rh - 0.3 - i * 0.18, rz0 + 2 + i * 0.4), 0.07, i % 2 ? L.m.metalBlue : L.m.metal);
    for (let i = 0; i < 8; i++) P.crate(ctx, V(rx0 + 1.5 + (i % 4) * 1.4, floorY, rz1 - 2 - Math.floor(i / 4) * 1.4), 1.2, i * 0.3, i % 2 ? L.m.containerRed : L.m.metal);
    b.box(L.m.metal, [-34, floorY + 0.5, 60], [1.2, 1, 6]);
    P.neonBar(ctx, V(-33.38, floorY + 0.9, 57), V(-33.38, floorY + 0.9, 63), RED, 0.03);
    const vaultSign = neonText('BLACK VAULT', '#ff2a3a', { w: 512, h: 128, bg: '#0a0204', frame: true });
    b.add(new THREE.PlaneGeometry(4, 1), L.sign(vaultSign, 2.2), V(rx0 + 0.25, floorY + 2.6, 60), { rotY: Math.PI / 2, cast: false });
    b.add(new THREE.PlaneGeometry(3, 0.75), L.sign(vaultSign, 2.2), V(-9.2, curbH + 3.2, 60), { rotY: Math.PI / 2, cast: false });
    b.box(L.m.metalDark, [-8.9, curbH + 2.5, 60], [0.2, 0.3, 7]);
    for (const z of [56.5, 63.5]) b.box(L.m.metalDark, [-8.9, curbH + 1.2, z], [0.2, 2.4, 0.2]);
    npcs.push({ kind: 'clerk', pos: V(-35.2, floorY, 60), yaw: -Math.PI / 2, name: 'Fixer Mags', shop: 'vault', lines: ['Credits only. No names.'] });
    npcs.push({ kind: 'guard', pos: V(-23, floorY, 52), yaw: -0.5, name: 'Vault Muscle', lines: ['You lost, choom?'] });
    anchors.push({ pos: V(-30, floorY + 3, 60), color: new THREE.Color(RED), intensity: 45, distance: 14, kind: 'point' });
    anchors.push({ pos: V(-24, floorY + 3, 66), color: new THREE.Color(VIOLET), intensity: 20, distance: 9, kind: 'point' });
    anchors.push({ pos: V(-15, -1, 60), color: new THREE.Color(RED), intensity: 30, distance: 9, kind: 'point' });
    shelters.push({ min: V(rx0, -10, rz0), max: V(rx1 + 0.2, -0.2, rz1) });
    indoor.push(new THREE.Box3(V(rx0, -10, rz0), V(rx1, -0.3, rz1)));
    interactables.push({ id: 'vault', pos: V(-33, floorY, 60), radius: 2.6, label: 'Deal with the BLACK VAULT', kind: 'vault' });
  }

  // ================================================================= TACTICAL GATE (north end)
  {
    const gz = -110;
    b.box(L.m.metalDark, [-9, 8, gz], [3, 16, 3]);
    b.box(L.m.metalDark, [9, 8, gz], [3, 16, 3]);
    b.box(L.m.metalDark, [0, 16.5, gz], [22, 2.5, 3.4]);
    b.box(L.m.concreteDark, [0, 10, gz - 6], [60, 20, 2]); // back wall
    for (const sx of [-9, 9]) for (const sz of [-1.55, 1.55]) P.neonBar(ctx, V(sx - 1.55 * Math.sign(sx) * 0 + sx * 0, 0.3, gz + sz), V(sx, 15, gz + sz), RED, 0.05);
    const portal = new THREE.Mesh(new THREE.CircleGeometry(6.4, 64), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      uniforms: { uTime: GLOBAL.uTime },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: /* glsl */`uniform float uTime; varying vec2 vUv;
        void main(){ vec2 p = vUv - 0.5; float r = length(p) * 2.0; float a = atan(p.y, p.x);
          float swirl = sin(a * 6.0 + r * 18.0 - uTime * 3.0) * 0.5 + 0.5;
          float rim = smoothstep(0.86, 0.98, r) * smoothstep(1.0, 0.97, r);
          float core = (1.0 - r) * 0.35 * swirl;
          vec3 c = mix(vec3(1.0, 0.1, 0.25), vec3(0.0, 0.9, 1.0), swirl) * (core + rim * 2.0);
          gl_FragColor = vec4(c, (core + rim) * smoothstep(1.0, 0.98, r)); }`,
    }));
    portal.position.set(0, 7.5, gz);
    group.add(portal);
    animate.push((t) => { portal.rotation.z = t * 0.2; });
    anchors.push({ pos: V(0, 7, gz + 4), color: new THREE.Color(RED), intensity: 45, distance: 20, kind: 'point' });
    addHorizontalSign(V(0, 16.5, gz + 1.75), 0, 'TACTICAL ARENA', RED, 14);
    // terminal
    b.box(L.m.metal, [0, curbH + 0.6, gz + 9], [1.6, 1.2, 0.8]);
    b.add(new THREE.PlaneGeometry(1.3, 0.8), L.sign(neonText('SECTOR 09', '#ff2a3a', { w: 512, h: 256, bg: '#100204', frame: true }), 1.8), V(0, curbH + 1.5, gz + 9.2), { rot: new THREE.Euler(-0.4, 0, 0), cast: false });
    b.add(new THREE.BoxGeometry(1.4, 0.9, 0.08), L.m.metalDark, V(0, curbH + 1.5, gz + 9.15), { rot: new THREE.Euler(-0.4, 0, 0) });
    interactables.push({ id: 'gate', pos: V(0, 0, gz + 9), radius: 3.2, label: 'Open TACTICAL GATE (match setup)', kind: 'gate' });
    npcs.push({ kind: 'guard', pos: V(-6, curbH, gz + 4), yaw: 0, name: 'Gate Sentry', lines: ['Arena matches need a host. Teams up to 5 a side.'] });
    npcs.push({ kind: 'guard', pos: V(6, curbH, gz + 4), yaw: 0, name: 'Gate Sentry', lines: ['SECTOR 09. Bomb defusal. Don\'t die cheap.'] });
    for (const x of [-14, 14]) P.streetLamp(ctx, V(x, curbH, gz + 12), x < 0 ? -Math.PI / 2 : Math.PI / 2, 0xffd0d0);
    for (let i = -3; i <= 3; i++) P.bollard(ctx, V(i * 3, curbH, gz + 16), RED);
  }

  // ================================================================= streets: lamps, cars, props
  for (let z = -95; z <= -40; z += 14) { P.streetLamp(ctx, V(-7.3, curbH, z), -Math.PI / 2); P.streetLamp(ctx, V(7.3, curbH, z + 7), Math.PI / 2); }
  for (let z = 40; z <= 110; z += 14) { P.streetLamp(ctx, V(-7.3, curbH, z), -Math.PI / 2); P.streetLamp(ctx, V(7.3, curbH, z + 7), Math.PI / 2); }
  for (let x = 40; x <= 110; x += 14) { P.streetLamp(ctx, V(x, curbH, -7.3), Math.PI); P.streetLamp(ctx, V(x + 7, curbH, 7.3), 0); }
  const carPaints = [
    new THREE.MeshPhysicalMaterial({ color: 0x101418, metalness: 0.8, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05 }),
    new THREE.MeshPhysicalMaterial({ color: 0x5a0a1a, metalness: 0.7, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 }),
    new THREE.MeshPhysicalMaterial({ color: 0xc8c8cc, metalness: 0.9, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 }),
    new THREE.MeshPhysicalMaterial({ color: 0x0a2a3a, metalness: 0.8, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05 }),
  ];
  for (let z = -92; z <= -46; z += 9) if (rand() > 0.3) P.car(ctx, V(-4.2, 0, z), 0, carPaints[Math.floor(rand() * 4)]);
  for (let z = 44; z <= 110; z += 9) if (rand() > 0.3) P.car(ctx, V(4.2, 0, z), Math.PI, carPaints[Math.floor(rand() * 4)]);
  for (let x = 44; x <= 110; x += 9) if (rand() > 0.35) P.car(ctx, V(x, 0, 4.2), Math.PI / 2, carPaints[Math.floor(rand() * 4)]);
  P.car(ctx, V(26, 0, 30), 0.3, carPaints[1]);
  P.car(ctx, V(-28, 0, -26), 2.2, carPaints[2]);
  // south parking lot
  for (let i = 0; i < 6; i++) P.car(ctx, V(12 + i * 3.2, curbH, 92), 0, carPaints[i % 4]);
  addBillboard(V(22, 14, 104), Math.PI, 14, 8, 0);
  const vendTex = [neonText('SYNTH-COLA', '#ff2bd6', { w: 256, h: 384, bg: '#1a0414', vertical: false }), neonText('NOODLE', '#00e5ff', { w: 256, h: 384, bg: '#02141a' })];
  for (const [x, z, yaw, i] of [[-20, 12, Math.PI / 2, 0], [-20, 13.3, Math.PI / 2, 1], [8.2, -40, -Math.PI / 2, 0], [-8, 44, Math.PI / 2, 1], [36, 8.5, Math.PI, 0]] as const) {
    P.vending(ctx, V(x, curbH, z), yaw, vendTex[i], i ? CYAN : MAGENTA);
  }
  for (let i = 0; i < 24; i++) P.trashBin(ctx, V((rand() > 0.5 ? 1 : -1) * (7.5 + rand() * 0.5), curbH, 40 + rand() * 70));
  for (let i = -2; i <= 2; i++) { P.bollard(ctx, V(i * 2.2, curbH, 22.6), CYAN); P.bollard(ctx, V(i * 2.2, curbH, -22.6), CYAN); }

  // ================================================================= elevated monorail
  {
    const tz = -38, ty = 13;
    b.add(boxUV(250, 1.0, 2.6, 4), L.m.concrete, V(0, ty, tz), { collide: false });
    b.add(new THREE.BoxGeometry(250, 0.06, 0.15), L.neon(CYAN, 2.5), V(0, ty - 0.52, tz + 1.25), { cast: false });
    b.add(new THREE.BoxGeometry(250, 0.06, 0.15), L.neon(CYAN, 2.5), V(0, ty - 0.52, tz - 1.25), { cast: false });
    for (let x = -120; x <= 120; x += 20) {
      if (Math.abs(x) < 9) continue;
      b.box(L.m.concrete, [x, ty / 2, tz], [1.4, ty, 1.4]);
      b.add(new THREE.BoxGeometry(3.4, 0.8, 2.4), L.m.concrete, V(x, ty - 0.9, tz));
    }
    for (let x = -118; x <= 118; x += 7) drips.push(new THREE.Vector4(x + rand() * 3, ty - 0.55, tz + (rand() > 0.5 ? 1.3 : -1.3), ty - 0.6));
    // the train: emissive windows, moves back and forth
    const train = new THREE.Group();
    const carBody = new THREE.MeshStandardMaterial({ color: 0x1a1e24, metalness: 0.85, roughness: 0.3 });
    const winTex = canvasTexture(256, 32, (c, w, h) => {
      c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 10; i++) { c.fillStyle = i % 3 ? '#ffd9a0' : '#a0f0ff'; c.fillRect(6 + i * 25, 8, 18, 16); }
    });
    for (let i = 0; i < 4; i++) {
      const car = new THREE.Mesh(boxUV(14, 3, 2.8, 2), carBody);
      car.position.set(i * 14.6, 0, 0);
      car.castShadow = true;
      train.add(car);
      for (const s of [-1, 1]) {
        const wpl = new THREE.Mesh(new THREE.PlaneGeometry(13, 1.2), new THREE.MeshStandardMaterial({ color: 0, emissive: 0xffffff, emissiveMap: winTex, emissiveIntensity: 2 }));
        wpl.position.set(i * 14.6, 0.4, s * 1.41);
        wpl.rotation.y = s > 0 ? 0 : Math.PI;
        train.add(wpl);
      }
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(14, 0.1, 2.85), L.neon(MAGENTA, 3));
      stripe.position.set(i * 14.6, -0.9, 0);
      train.add(stripe);
    }
    train.position.set(-200, ty + 2.1, tz);
    group.add(train);
    let tx = -220, dir = 1, wait = 0;
    animate.push((_t, dt) => {
      if (wait > 0) { wait -= dt; return; }
      tx += dir * dt * 22;
      if (tx > 220 || tx < -280) { dir = -dir; wait = 6; }
      train.position.x = tx;
    });
  }

  // ================================================================= sky traffic (instanced flying cars)
  {
    const count = 24 + detail * 16;
    const geo = new THREE.BoxGeometry(1.8, 0.6, 4);
    const mat = new THREE.MeshStandardMaterial({ color: 0x15181d, metalness: 0.8, roughness: 0.35, emissive: 0x000000 });
    const cars = new THREE.InstancedMesh(geo, mat, count);
    const lightsGeo = new THREE.BoxGeometry(1.6, 0.12, 0.1);
    const head = new THREE.InstancedMesh(lightsGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 4, 4.5) }), count);
    const tail = new THREE.InstancedMesh(lightsGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 0.3, 0.5) }), count);
    const lanes = Array.from({ length: count }, (_, i) => ({
      y: 22 + (i % 5) * 9 + rand() * 4, axis: i % 2, off: (rand() - 0.5) * 200, speed: (18 + rand() * 20) * (rand() > 0.5 ? 1 : -1), phase: rand() * 400,
    }));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1);
    group.add(cars, head, tail);
    cars.frustumCulled = head.frustumCulled = tail.frustumCulled = false;
    animate.push((t) => {
      lanes.forEach((l, i) => {
        const p = ((l.phase + t * l.speed) % 400 + 400) % 400 - 200;
        const pos = l.axis ? V(p, l.y, l.off) : V(l.off, l.y, p);
        const yaw = l.axis ? (l.speed > 0 ? Math.PI / 2 : -Math.PI / 2) : l.speed > 0 ? 0 : Math.PI;
        q.setFromAxisAngle(V(0, 1, 0), yaw);
        m.compose(pos, q, s);
        cars.setMatrixAt(i, m);
        const fwd = V(0, 0, 1).applyQuaternion(q);
        m.compose(pos.clone().addScaledVector(fwd, 2.02), q, s);
        head.setMatrixAt(i, m);
        m.compose(pos.clone().addScaledVector(fwd, -2.02), q, s);
        tail.setMatrixAt(i, m);
      });
      cars.instanceMatrix.needsUpdate = head.instanceMatrix.needsUpdate = tail.instanceMatrix.needsUpdate = true;
    });
  }

  // ================================================================= walkers (pedestrian loops on sidewalks)
  const loops: THREE.Vector3[][] = [
    [V(-20, curbH, -20), V(20, curbH, -20), V(20, curbH, 20), V(-20, curbH, 20)],
    [V(-9, curbH, -40), V(-9, curbH, -98), V(9, curbH, -98), V(9, curbH, -40)],
    [V(-40, curbH, 0.5), V(-104, curbH, 0.5), V(-104, curbH, -1.5), V(-40, curbH, -1.5)],
    [V(40, curbH, -9), V(108, curbH, -9), V(108, curbH, 9), V(40, curbH, 9)],
    [V(-9, curbH, 40), V(-9, curbH, 108), V(9, curbH, 108), V(9, curbH, 40)],
    [V(-104, curbH, 2), V(-40, curbH, 2)],
  ];
  const walkerNames = ['Courier', 'Salaryman', 'Netrunner', 'Street Kid', 'Medtech', 'Nomad', 'Tourist', 'Maintenance Drone Op'];
  const walkerLines = ['Got somewhere to be.', 'Rain never stops here.', 'Heard there\'s a match at the Tactical Gate.', 'Watch your wallet in the market.', 'The Afterlife has the best synthwave in the district.', 'Black Vault sells gear that never touched a shop shelf.'];
  const walkerCount = 4 + detail * 4;
  for (let i = 0; i < walkerCount; i++) {
    const path = loops[i % loops.length].map((p) => p.clone().add(V((rand() - 0.5) * 1.5, 0, (rand() - 0.5) * 1.5)));
    if (rand() > 0.5) path.reverse();
    npcs.push({ kind: 'walker', pos: path[0].clone(), yaw: 0, path, name: walkerNames[i % walkerNames.length], lines: walkerLines });
  }
  npcs.push({ kind: 'worker', pos: V(30, 0, 2), yaw: 1.2, name: 'Utility Tech', lines: ['Power grid\'s held together with tape and prayer.'] });
  npcs.push({ kind: 'idle', pos: V(-12, curbH, -14), yaw: 0.6, name: 'Info Broker', lines: ['Want a tip? Invite codes are one-shot. Make a new one for every friend.'] });
  npcs.push({ kind: 'guard', pos: V(18, curbH, 18), yaw: -2.3, name: 'NCPD Officer', lines: ['Move along.'] });

  // ================================================================= sky & distant city
  group.add(distantSkyline(90 + detail * 50, 170, 480, 7));
  const sl = new Searchlights([V(-150, 0, -220), V(180, 0, -160), V(60, 0, 240)], 0x8fb8ff);
  group.add(sl.group);
  animate.push((t) => sl.update(t));
  for (let i = 0; i < detail * 3; i++) group.add(fogLayer(V((rand() - 0.5) * 160, 8 + rand() * 18, (rand() - 0.5) * 160), 60, 0x30406a, 0.12));

  // invisible boundary walls
  for (const [x, z, w, d] of [[0, -124, 260, 2], [0, 124, 260, 2], [-124, 0, 2, 260], [124, 0, 2, 260]]) physics.addBox(V(x, 20, z), V(w / 2, 20, d / 2));

  b.build(group);

  const groundAt = (x: number, z: number) => {
    if (x > -40 && x < -21 && z > 50 && z < 70) return -4;
    if (x >= -21 && x <= -9 && z >= 57 && z <= 63) return -4 + ((x + 21) / 12) * 4.15;
    const onStreet = (Math.max(Math.abs(x), Math.abs(z)) > 22 && Math.max(Math.abs(x), Math.abs(z)) < 34) || (Math.abs(x) < 6 && Math.abs(z) > 34) || (Math.abs(z) < 6 && x > 34);
    return onStreet ? 0 : curbH;
  };

  return {
    group, anchors, drips, shelters, interactables, npcs, spawn: V(0, curbH, 12), jinglePoints, chatterPoints, barPos,
    animate, indoor, groundAt, armoryRack, probePoint: V(0, 3, 14), puddleMask: L.asphaltSet.mask,
  };
}
