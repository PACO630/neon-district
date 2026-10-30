// Analytic ray tests against player hitboxes (head sphere + torso capsule + legs capsule).
import * as THREE from 'three';

export type HitPart = 'head' | 'body' | 'legs';

export interface Hitbox { feet: THREE.Vector3; crouch: boolean }

export function raySphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number): number | null {
  const oc = o.clone().sub(c);
  const b = oc.dot(d);
  const cc = oc.lengthSq() - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}

/** Ray vs capsule (segment a-b, radius r). Returns approximate entry distance. */
export function rayCapsule(o: THREE.Vector3, d: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number, maxT: number): number | null {
  // closest points between ray segment [o, o + d*maxT] and [a, b]
  const p1 = o, q1 = o.clone().addScaledVector(d, maxT);
  const d1 = q1.clone().sub(p1), d2 = b.clone().sub(a), rr = p1.clone().sub(a);
  const A = d1.dot(d1), E = d2.dot(d2), F = d2.dot(rr);
  const C = d1.dot(rr), Bv = d1.dot(d2);
  const denom = A * E - Bv * Bv;
  let s = denom !== 0 ? THREE.MathUtils.clamp((Bv * F - C * E) / denom, 0, 1) : 0;
  let t = (Bv * s + F) / E;
  if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-C / A, 0, 1); }
  else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((Bv - C) / A, 0, 1); }
  const c1 = p1.clone().addScaledVector(d1, s), c2 = a.clone().addScaledVector(d2, t);
  const dist = c1.distanceTo(c2);
  if (dist > r) return null;
  // back off to the surface along the ray
  const along = s * maxT - Math.sqrt(Math.max(0, r * r - dist * dist));
  return Math.max(0, along);
}

export function testHitbox(o: THREE.Vector3, d: THREE.Vector3, h: Hitbox, maxT: number): { t: number; part: HitPart } | null {
  const f = h.feet;
  const headY = h.crouch ? 1.18 : 1.64;
  const chestTop = h.crouch ? 0.98 : 1.42;
  const hip = h.crouch ? 0.55 : 0.82;
  let best: { t: number; part: HitPart } | null = null;
  const th = raySphere(o, d, new THREE.Vector3(f.x, f.y + headY, f.z), 0.17);
  if (th !== null && th < maxT) best = { t: th, part: 'head' };
  const tb = rayCapsule(o, d, new THREE.Vector3(f.x, f.y + hip, f.z), new THREE.Vector3(f.x, f.y + chestTop, f.z), 0.3, maxT);
  if (tb !== null && (!best || tb < best.t - 0.05)) best = { t: tb, part: 'body' };
  const tl = rayCapsule(o, d, new THREE.Vector3(f.x, f.y + 0.15, f.z), new THREE.Vector3(f.x, f.y + hip, f.z), 0.24, maxT);
  if (tl !== null && (!best || tl < best.t - 0.05)) best = { t: tl, part: 'legs' };
  return best;
}
