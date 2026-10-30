// NEON DISTRICT: SECTOR 09 — industrial bomb-defusal map, defined as data so the host's
// authoritative collision world and every client's rendered map come from one source.
//
//   z −54 ┌──────────────── DEF SPAWN / north strip ────────────────┐
//         │ B warehouse (indoor)   │B-mid│ mid-N │ A-mid  │ A SITE (dock y 1.5)
//   z −12 │  [B]  tunnel exit ramp │  mid courtyard (+ high walkway) │ A ramp
//         │ B main  │ B-south block│ connector     │ A-south │ A main alley
//   z  18 │         │ tunnel entry ramp ↓ (underground y −4.5)        │
//   z  54 └──────────────── ATK SPAWN / south strip ────────────────┘
import * as THREE from 'three';

export type ArenaMat = 'concrete' | 'concreteDark' | 'metal' | 'metalDark' | 'metalBlue' | 'grating' | 'containerRed' | 'containerBlue' | 'containerYellow' | 'facadeInd' | 'wallIndoor' | 'floorIndoor' | 'asphalt' | 'tileWet';

export interface MapBox { c: [number, number, number]; s: [number, number, number]; mat: ArenaMat; rotY?: number; collide?: boolean; cast?: boolean; tile?: number }
export interface MapRamp { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number; mat: ArenaMat }
export interface Zone { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }

export const BOUNDS = { x0: -46, x1: 46, z0: -54, z1: 54 };
export const SITES: Record<'A' | 'B', Zone> = {
  A: { x0: 23, x1: 44, z0: -38, z1: -16, y0: 1.2, y1: 6 },
  B: { x0: -43, x1: -23, z0: -37, z1: -15, y0: -0.5, y1: 6 },
};
export const BUY_ZONES: Record<'ATK' | 'DEF', Zone> = {
  ATK: { x0: -46, x1: 46, z0: 38, z1: 54, y0: -1, y1: 6 },
  DEF: { x0: -46, x1: 46, z0: -54, z1: -40, y0: -1, y1: 6 },
};
export const SPAWNS: Record<'ATK' | 'DEF', [number, number, number][]> = {
  ATK: [[-6, 0, 48], [-3, 0, 50], [0, 0, 48], [3, 0, 50], [6, 0, 48], [-9, 0, 51], [9, 0, 51]],
  DEF: [[-5, 0, -48], [-2, 0, -50], [1, 0, -48], [4, 0, -50], [7, 0, -48], [-8, 0, -51], [10, 0, -51]],
};
export const TUNNEL_Y = -4.5;
const HOLES = [[-21, 20, -15, 32], [-21, -26, -15, -14]]; // tunnel ramps cut into the ground [x0,z0,x1,z1]

const boxes: MapBox[] = [];
const ramps: MapRamp[] = [];
const B = (x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, mat: ArenaMat, extra: Partial<MapBox> = {}) =>
  boxes.push({ c: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], s: [x1 - x0, y1 - y0, z1 - z0], mat, ...extra });

// ---------------------------------------------------------------- floor (minus tunnel holes)
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
let floor = [[BOUNDS.x0, BOUNDS.z0, BOUNDS.x1, BOUNDS.z1]];
for (const h of HOLES) floor = floor.flatMap((r) => rectMinus(r, h));
export const FLOOR_RECTS = floor;

// ---------------------------------------------------------------- outer walls
const WALL_H = 12;
B(BOUNDS.x0 - 2, BOUNDS.z0 - 2, BOUNDS.x1 + 2, BOUNDS.z0, 0, WALL_H, 'facadeInd', { tile: 12 });
B(BOUNDS.x0 - 2, BOUNDS.z1, BOUNDS.x1 + 2, BOUNDS.z1 + 2, 0, WALL_H, 'facadeInd', { tile: 12 });
B(BOUNDS.x0 - 2, BOUNDS.z0, BOUNDS.x0, BOUNDS.z1, 0, WALL_H, 'facadeInd', { tile: 12 });
B(BOUNDS.x1, BOUNDS.z0, BOUNDS.x1 + 2, BOUNDS.z1, 0, WALL_H, 'facadeInd', { tile: 12 });

// ---------------------------------------------------------------- solid blocks (buildings)
B(4, -40, 20, -26, 0, 9, 'concrete', { tile: 4 });         // A-mid block
B(-14, -40, -4, -30, 0, 9, 'concrete', { tile: 4 });       // B-mid block
B(-30, -12, -14, 18, 0, 10, 'concrete', { tile: 4 });      // B-south block
B(8, -6, 30, 40, 0, 10, 'concrete', { tile: 4 });          // A-south block
B(20, -14, 30, -6, 0, 6, 'concreteDark', { tile: 4 });     // A-short hut
B(-12, 24, -4, 36, 0, 5, 'metalBlue', { tile: 3 });        // tunnel yard shed

// ---------------------------------------------------------------- A site dock (y 1.5) + ramps
B(20, -40, 46, -14, 0, 1.5, 'concreteDark', { tile: 4 });
ramps.push({ x0: 22, x1: 28, z0: -46, z1: -40, y0: 0, y1: 1.5, mat: 'grating' });  // DEF → A
ramps.push({ x0: 36, x1: 44, z0: -6, z1: -14, y0: 0, y1: 1.5, mat: 'grating' });   // A main → A
// west stairs from connector (x 14..20) as a ramp along x
export const X_RAMPS: MapRamp[] = [{ x0: 14, x1: 20, z0: -24, z1: -18, y0: 0, y1: 1.5, mat: 'grating' }];

// ---------------------------------------------------------------- B warehouse (indoor, roofed)
const WH = { x0: -46, x1: -14, z0: -40, z1: -12, h: 8 };
// north wall with CT door x −32..−26
B(WH.x0, WH.z0, -32, WH.z0 + 0.5, 0, WH.h, 'metalDark', { tile: 4 });
B(-26, WH.z0, WH.x1, WH.z0 + 0.5, 0, WH.h, 'metalDark', { tile: 4 });
B(-32, WH.z0, -26, WH.z0 + 0.5, 3.2, WH.h, 'metalDark', { tile: 4 });
// south wall with B-main door x −42..−35
B(WH.x0, WH.z1 - 0.5, -42, WH.z1, 0, WH.h, 'metalDark', { tile: 4 });
B(-35, WH.z1 - 0.5, WH.x1, WH.z1, 0, WH.h, 'metalDark', { tile: 4 });
B(-42, WH.z1 - 0.5, -35, WH.z1, 3.4, WH.h, 'metalDark', { tile: 4 });
// east wall with window/door to mid z −28..−24
B(WH.x1 - 0.5, WH.z0, WH.x1, -28, 0, WH.h, 'metalDark', { tile: 4 });
B(WH.x1 - 0.5, -24, WH.x1, WH.z1, 0, WH.h, 'metalDark', { tile: 4 });
B(WH.x1 - 0.5, -28, WH.x1, -24, 2.8, WH.h, 'metalDark', { tile: 4 });
// roof
B(WH.x0, WH.z0, WH.x1, WH.z1, WH.h, WH.h + 0.4, 'metal', { tile: 4 });
// pillars + B site cover
for (const [x, z] of [[-38, -32], [-38, -20], [-22, -32], [-30, -20]]) B(x - 0.4, z - 0.4, x + 0.4, z + 0.4, 0, WH.h, 'concrete', { tile: 2 });
B(-36, -30, -33, -27, 0, 1.4, 'containerYellow', { tile: 1.5 });
B(-35.5, -29.5, -33.5, -27.5, 1.4, 2.6, 'containerYellow', { tile: 1.5 });
B(-28, -36, -24, -34, 0, 1.2, 'metal', { tile: 1.5 });
B(-41, -22, -38.5, -19.5, 0, 1.3, 'containerRed', { tile: 1.5 });
B(-31, -26, -29, -24, 0, 1.1, 'metal', { tile: 1.5 });
// tunnel exit railing inside warehouse
B(-21.2, -26, -21, -14, 0, 1.1, 'metalDark', { cast: false });
B(-15, -26, -14.8, -14, 0, 1.1, 'metalDark', { cast: false });

// ---------------------------------------------------------------- underground tunnel (y −4.5)
ramps.push({ x0: -21, x1: -15, z0: 32, z1: 20, y0: 0, y1: TUNNEL_Y, mat: 'grating' });   // entry: going north, down
ramps.push({ x0: -21, x1: -15, z0: -14, z1: -26, y0: TUNNEL_Y, y1: 0, mat: 'grating' }); // exit: going north, up
B(-21, -14, -15, 20, TUNNEL_Y - 0.4, TUNNEL_Y, 'concreteDark', { tile: 3, cast: false }); // tunnel floor
B(-22, -26, -21, 32, TUNNEL_Y - 0.4, 0, 'concreteDark', { tile: 3, cast: false });       // tunnel walls
B(-15, -26, -14, 32, TUNNEL_Y - 0.4, 0, 'concreteDark', { tile: 3, cast: false });
B(-21, -14, -15, 20, -0.4, 0, 'concreteDark', { tile: 3, cast: false });                  // ceiling under the blocks
B(-21, -27, -15, -26, TUNNEL_Y - 0.4, 0, 'concreteDark', { tile: 3, cast: false });       // end caps
B(-21, 32, -15, 33, TUNNEL_Y - 0.4, 0, 'concreteDark', { tile: 3, cast: false });
// tunnel entry railings at ground level
B(-21.2, 20, -21, 32, 0, 1.1, 'metalDark', { cast: false });
B(-15, 20, -14.8, 32, 0, 1.1, 'metalDark', { cast: false });

// ---------------------------------------------------------------- mid: cover + high walkway
B(-4, -2, 2, 4, 0, 2.4, 'concreteDark', { tile: 3 });
B(-10, 6, -8, 8, 0, 1.2, 'containerBlue', { tile: 1.5 });
B(4, -10, 6, -8, 0, 1.2, 'metal', { tile: 1.5 });
B(-12, -22, -4, -16, 2.8, 3.1, 'grating', { tile: 2 });                   // walkway deck
for (const [x, z] of [[-11.6, -21.6], [-4.4, -21.6], [-11.6, -16.4], [-4.4, -16.4]]) B(x - 0.2, z - 0.2, x + 0.2, z + 0.2, 0, 2.8, 'metalDark', { cast: true });
B(-12, -22, -11.8, -16, 3.1, 4.1, 'metalDark', { cast: false });           // railings
B(-4.2, -22, -4, -16, 3.1, 4.1, 'metalDark', { cast: false });
ramps.push({ x0: -12, x1: -8, z0: -9, z1: -16, y0: 0, y1: 3.1, mat: 'grating' });

// ---------------------------------------------------------------- connector (mid → A)
B(10, -24, 12, -22, 0, 1.2, 'containerRed', { tile: 1.5 });
B(14, -14, 17, -11, 0, 1.4, 'metal', { tile: 1.5 });

// ---------------------------------------------------------------- A site cover
B(29, -33, 35.5, -30.4, 1.5, 4.1, 'containerRed', { tile: 2.6 });
B(29.5, -32.8, 35, -30.6, 4.1, 6.7, 'containerBlue', { tile: 2.6 });
B(38, -28, 40.6, -21.5, 1.5, 4.1, 'containerYellow', { tile: 2.6 });
B(25, -22, 27, -20, 1.5, 2.7, 'metal', { tile: 1.2 });
B(41, -37, 43.5, -34.5, 1.5, 2.8, 'metal', { tile: 1.2 });
B(24, -38, 26, -36, 1.5, 2.6, 'metal', { tile: 1.2 });

// ---------------------------------------------------------------- lanes cover
B(36, 10, 39, 13, 0, 1.3, 'containerBlue', { tile: 1.5 });                 // A main
B(41, 24, 44, 27, 0, 1.6, 'metal', { tile: 1.5 });
B(32, 30, 34, 36, 0, 1.0, 'concreteDark', { tile: 1.5 });
B(-40, 4, -37, 7, 0, 1.3, 'containerRed', { tile: 1.5 });                  // B main
B(-35, 22, -32, 25, 0, 1.6, 'metal', { tile: 1.5 });
B(-44, 32, -40, 34, 0, 1.0, 'concreteDark', { tile: 1.5 });
B(-2, 26, 1, 29, 0, 1.3, 'containerYellow', { tile: 1.5 });                // mid alley
B(-26, -50, -22, -46, 0, 1.4, 'metal', { tile: 1.5 });                     // DEF strip
B(14, -50, 18, -47, 0, 1.4, 'containerBlue', { tile: 1.5 });
B(-20, 44, -16, 47, 0, 1.4, 'metal', { tile: 1.5 });                       // ATK strip
B(18, 44, 22, 47, 0, 1.4, 'containerRed', { tile: 1.5 });

export const MAP_BOXES = boxes;
export const MAP_RAMPS = ramps;
export const WAREHOUSE = WH;
/** Covered areas (no rain): warehouse, tunnel */
export const ARENA_SHELTERS = [
  { min: new THREE.Vector3(WH.x0, -1, WH.z0), max: new THREE.Vector3(WH.x1, WH.h, WH.z1) },
  { min: new THREE.Vector3(-22, -6, -26), max: new THREE.Vector3(-14, -0.2, 20) },
];

export function inZone(z: Zone, p: { x: number; y: number; z: number }): boolean {
  return p.x >= z.x0 && p.x <= z.x1 && p.z >= z.z0 && p.z <= z.z1 && p.y >= z.y0 && p.y <= z.y1;
}

/** Adds all colliders for the map to a Rapier world. */
export function addSector09Colliders(physics: { addBox: (c: THREE.Vector3, h: THREE.Vector3, q?: THREE.Quaternion) => unknown }): void {
  for (const r of FLOOR_RECTS) {
    physics.addBox(new THREE.Vector3((r[0] + r[2]) / 2, -0.5, (r[1] + r[3]) / 2), new THREE.Vector3((r[2] - r[0]) / 2, 0.5, (r[3] - r[1]) / 2));
  }
  for (const b of MAP_BOXES) {
    if (b.collide === false) continue;
    const q = b.rotY ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rotY) : undefined;
    physics.addBox(new THREE.Vector3(...b.c), new THREE.Vector3(b.s[0] / 2, b.s[1] / 2, b.s[2] / 2), q);
  }
  for (const r of [...MAP_RAMPS, ...X_RAMPS]) {
    const { center, half, q } = rampTransform(r, X_RAMPS.includes(r));
    physics.addBox(center, half, q);
  }
}

/** Ramp as a tilted slab: returns center, half extents and rotation. */
export function rampTransform(r: MapRamp, alongX: boolean): { center: THREE.Vector3; half: THREE.Vector3; q: THREE.Quaternion; len: number } {
  const thick = 0.3;
  const run = alongX ? r.x1 - r.x0 : r.z1 - r.z0;
  const rise = r.y1 - r.y0;
  const len = Math.hypot(run, rise);
  const ang = Math.atan2(rise, Math.abs(run));
  const width = alongX ? Math.abs(r.z1 - r.z0) : Math.abs(r.x1 - r.x0);
  const center = new THREE.Vector3((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2 - thick / 2, (r.z0 + r.z1) / 2);
  const q = new THREE.Quaternion();
  if (alongX) q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.sign(run) * ang);
  else q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.sign(run) * ang);
  const half = alongX ? new THREE.Vector3(len / 2, thick / 2, width / 2) : new THREE.Vector3(width / 2, thick / 2, len / 2);
  return { center, half, q, len };
}

/** Top-down minimap image (walls dark, walkable light, sites marked). */
export function renderMinimap(size = 256): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const sx = size / (BOUNDS.x1 - BOUNDS.x0 + 4), sz = size / (BOUNDS.z1 - BOUNDS.z0 + 4);
  const s = Math.min(sx, sz);
  const ox = size / 2, oz = size / 2;
  const P = (x: number, z: number): [number, number] => [ox + x * s, oz + z * s];
  ctx.fillStyle = 'rgba(8,14,20,0.9)';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(40,70,90,0.55)';
  const [a0, b0] = P(BOUNDS.x0, BOUNDS.z0);
  ctx.fillRect(a0, b0, (BOUNDS.x1 - BOUNDS.x0) * s, (BOUNDS.z1 - BOUNDS.z0) * s);
  for (const b of MAP_BOXES) {
    const top = b.c[1] + b.s[1] / 2;
    if (top < 0.3 || b.s[1] < 0.5) continue;
    const [x, z] = P(b.c[0] - b.s[0] / 2, b.c[2] - b.s[2] / 2);
    ctx.fillStyle = top > 5 ? 'rgba(4,6,10,0.95)' : top > 2 ? 'rgba(20,30,40,0.95)' : 'rgba(30,48,60,0.95)';
    if (b.c[1] - b.s[1] / 2 > 2.5) continue; // roofs / lintels
    ctx.fillRect(x, z, b.s[0] * s, b.s[2] * s);
  }
  ctx.strokeStyle = 'rgba(255,170,40,0.8)';
  ctx.setLineDash([3, 3]);
  for (const r of [...MAP_RAMPS]) { const [x, z] = P(Math.min(r.x0, r.x1), Math.min(r.z0, r.z1)); ctx.strokeRect(x, z, Math.abs(r.x1 - r.x0) * s, Math.abs(r.z1 - r.z0) * s); }
  ctx.setLineDash([]);
  for (const k of ['A', 'B'] as const) {
    const z = SITES[k];
    const [x, y] = P(z.x0, z.z0);
    ctx.fillStyle = 'rgba(255,40,80,0.18)';
    ctx.fillRect(x, y, (z.x1 - z.x0) * s, (z.z1 - z.z0) * s);
    ctx.fillStyle = '#ff3a6a';
    ctx.font = `700 ${Math.floor(size / 12)}px Orbitron, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(k, x + (z.x1 - z.x0) * s / 2, y + (z.z1 - z.z0) * s / 2);
  }
  return c;
}
export const MINIMAP_SCALE = (size: number) => Math.min(size / (BOUNDS.x1 - BOUNDS.x0 + 4), size / (BOUNDS.z1 - BOUNDS.z0 + 4));
