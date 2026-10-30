// Rapier physics wrapper: static world colliders, kinematic capsule character controller,
// ray casts for hit-scan weapons and dynamic bodies for grenades.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

let ready: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  if (!ready) ready = RAPIER.init();
  return ready;
}

export interface CharacterBody {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  controller: RAPIER.KinematicCharacterController;
  radius: number;
  halfHeight: number;
}

export interface RayHit { distance: number; point: THREE.Vector3; normal: THREE.Vector3; collider: RAPIER.Collider }

export class Physics {
  readonly world: RAPIER.World;
  readonly R = RAPIER;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
  }

  addBox(center: THREE.Vector3, half: THREE.Vector3, rot?: THREE.Quaternion, userData?: number): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(center.x, center.y, center.z).setFriction(0.8);
    if (rot) desc.setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w });
    const c = this.world.createCollider(desc);
    if (userData !== undefined) (c as any).userTag = userData;
    return c;
  }

  addCylinder(center: THREE.Vector3, halfHeight: number, radius: number): RAPIER.Collider {
    return this.world.createCollider(RAPIER.ColliderDesc.cylinder(halfHeight, radius).setTranslation(center.x, center.y, center.z));
  }

  /** Static collider from arbitrary mesh geometry (world-space). */
  addTrimesh(geo: THREE.BufferGeometry, matrix: THREE.Matrix4): RAPIER.Collider {
    const g = geo.index ? geo : geo;
    const pos = g.attributes.position;
    const v = new Float32Array(pos.count * 3);
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) { p.fromBufferAttribute(pos, i).applyMatrix4(matrix); v.set([p.x, p.y, p.z], i * 3); }
    const idx = g.index ? new Uint32Array(g.index.array) : new Uint32Array(pos.count).map((_, i) => i);
    return this.world.createCollider(RAPIER.ColliderDesc.trimesh(v, idx));
  }

  createCharacter(pos: THREE.Vector3, radius = 0.32, halfHeight = 0.58): CharacterBody {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y + halfHeight + radius, pos.z));
    const collider = this.world.createCollider(RAPIER.ColliderDesc.capsule(halfHeight, radius), body);
    const controller = this.world.createCharacterController(0.03);
    controller.enableAutostep(0.42, 0.25, true);
    controller.enableSnapToGround(0.35);
    controller.setMaxSlopeClimbAngle((52 * Math.PI) / 180);
    controller.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    controller.setApplyImpulsesToDynamicBodies(true);
    controller.setSlideEnabled(true);
    return { body, collider, controller, radius, halfHeight };
  }

  /** Moves the character by `delta`; returns the feet position and grounded flag. */
  moveCharacter(c: CharacterBody, delta: THREE.Vector3): { feet: THREE.Vector3; grounded: boolean; hitCeiling: boolean } {
    c.controller.computeColliderMovement(c.collider, { x: delta.x, y: delta.y, z: delta.z }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
    const m = c.controller.computedMovement();
    const t = c.body.translation();
    const next = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
    c.body.setNextKinematicTranslation(next);
    c.body.setTranslation(next, true);
    const grounded = c.controller.computedGrounded();
    return { feet: new THREE.Vector3(next.x, next.y - c.halfHeight - c.radius, next.z), grounded, hitCeiling: delta.y > 0 && m.y < delta.y * 0.5 };
  }

  teleportCharacter(c: CharacterBody, feet: THREE.Vector3): void {
    const p = { x: feet.x, y: feet.y + c.halfHeight + c.radius, z: feet.z };
    c.body.setTranslation(p, true);
    c.body.setNextKinematicTranslation(p);
  }

  /** Crouch: shrink capsule keeping the feet planted. Returns false when standing up is blocked. */
  setCharacterHeight(c: CharacterBody, halfHeight: number): boolean {
    if (Math.abs(halfHeight - c.halfHeight) < 1e-3) return true;
    const t = c.body.translation();
    const feetY = t.y - c.halfHeight - c.radius;
    if (halfHeight > c.halfHeight) {
      // check headroom
      const hit = this.raycast(new THREE.Vector3(t.x, t.y, t.z), new THREE.Vector3(0, 1, 0), (halfHeight - c.halfHeight) * 2 + c.radius + 0.05, c.collider);
      if (hit) return false;
    }
    c.collider.setHalfHeight(halfHeight);
    c.halfHeight = halfHeight;
    const p = { x: t.x, y: feetY + halfHeight + c.radius, z: t.z };
    c.body.setTranslation(p, true);
    c.body.setNextKinematicTranslation(p);
    return true;
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, exclude?: RAPIER.Collider): RayHit | null {
    const ray = new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, undefined, exclude, undefined, (col) => !col.isSensor());
    if (!hit) return null;
    const d = hit.timeOfImpact;
    return {
      distance: d,
      point: origin.clone().addScaledVector(dir, d),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      collider: hit.collider,
    };
  }

  /** Line-of-sight test between two points against static geometry. */
  visible(a: THREE.Vector3, b: THREE.Vector3, exclude?: RAPIER.Collider): boolean {
    const d = b.clone().sub(a);
    const len = d.length();
    if (len < 1e-3) return true;
    const hit = this.raycast(a, d.divideScalar(len), len - 0.05, exclude);
    return !hit;
  }

  createBall(pos: THREE.Vector3, vel: THREE.Vector3, radius: number): RAPIER.RigidBody {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setLinvel(vel.x, vel.y, vel.z).setCcdEnabled(true).setLinearDamping(0.1).setAngularDamping(1.5));
    this.world.createCollider(RAPIER.ColliderDesc.ball(radius).setRestitution(0.38).setFriction(0.7).setDensity(3).setCollisionGroups(0x00020001), body);
    return body;
  }

  removeBody(b: RAPIER.RigidBody): void { this.world.removeRigidBody(b); }

  step(): void { this.world.step(); }

  dispose(): void { this.world.free(); }
}
