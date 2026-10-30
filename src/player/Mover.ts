// Local player movement on a Rapier kinematic character controller (client-predicted).
import * as THREE from 'three';
import type { CharacterBody, Physics } from '../physics/Physics';
import type { Input } from './Input';

export interface MoveOpts {
  speed: number;           // full run speed (m/s)
  walkMult: number;        // walk modifier
  crouchMult: number;
  frozen: boolean;
  faceMovement: boolean;   // third-person: character turns toward travel direction
  holdToRun?: boolean;
}

const STAND = 0.58, CROUCH = 0.3;

export class Mover {
  readonly body: CharacterBody;
  feet = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;            // view yaw
  pitch = 0;
  bodyYaw = 0;        // character facing (3rd person)
  grounded = true;
  crouching = false;
  walking = false;
  speedNow = 0;
  justLanded = false;
  airTime = 0;
  private fallStart = 0;

  constructor(private physics: Physics, spawn: THREE.Vector3) {
    this.body = physics.createCharacter(spawn);
    this.feet.copy(spawn);
  }

  teleport(p: THREE.Vector3, yaw?: number): void {
    this.physics.teleportCharacter(this.body, p);
    this.feet.copy(p);
    this.vel.set(0, 0, 0);
    if (yaw !== undefined) { this.yaw = yaw; this.bodyYaw = yaw; }
  }

  look(input: Input, pitchLimit = 1.5): void {
    const l = input.consumeLook();
    this.yaw -= l.dx;
    this.pitch = THREE.MathUtils.clamp(this.pitch - l.dy, -pitchLimit, pitchLimit);
  }

  update(dt: number, input: Input, o: MoveOpts): void {
    const mv = o.frozen ? { x: 0, y: 0 } : input.move();
    const wantCrouch = input.isHeld('crouch') && !o.frozen;
    if (wantCrouch !== this.crouching) {
      if (this.physics.setCharacterHeight(this.body, wantCrouch ? CROUCH : STAND)) this.crouching = wantCrouch;
    }
    this.walking = input.isHeld('walk');
    let speed = o.speed;
    if (this.crouching) speed *= o.crouchMult;
    else if (this.walking) speed *= o.walkMult;
    // camera-relative wish direction
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = fwd.multiplyScalar(mv.y).add(right.multiplyScalar(mv.x));
    const mag = Math.min(1, wish.length());
    if (mag > 0.01) wish.normalize();
    const target = wish.multiplyScalar(speed * mag);
    const accel = this.grounded ? 16 : 3;
    this.vel.x += (target.x - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (target.z - this.vel.z) * Math.min(1, accel * dt);
    if (this.grounded) {
      if (input.pressed('jump') && !o.frozen && !this.crouching) { this.vel.y = 6.6; this.grounded = false; }
      else this.vel.y = -2;
    } else {
      this.vel.y -= 19 * dt;
    }
    const res = this.physics.moveCharacter(this.body, this.vel.clone().multiplyScalar(dt));
    const wasGrounded = this.grounded;
    this.grounded = res.grounded;
    if (res.hitCeiling && this.vel.y > 0) this.vel.y = 0;
    this.justLanded = !wasGrounded && this.grounded && this.airTime > 0.25;
    this.airTime = this.grounded ? 0 : this.airTime + dt;
    if (this.grounded && this.vel.y < 0) this.vel.y = -2;
    const moved = res.feet.clone().sub(this.feet);
    this.speedNow = Math.hypot(moved.x, moved.z) / Math.max(dt, 1e-4);
    this.feet.copy(res.feet);
    if (o.faceMovement && mag > 0.05) {
      const ty = Math.atan2(-target.x, -target.z);
      let d = ty - this.bodyYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.bodyYaw += d * Math.min(1, dt * 10);
    } else if (!o.faceMovement) this.bodyYaw = this.yaw;
    void this.fallStart;
  }

  /** animation name derived from movement */
  animName(): 'idle' | 'walk' | 'run' | 'jump' | 'crouch' | 'crouchWalk' {
    if (!this.grounded && this.airTime > 0.12) return 'jump';
    if (this.crouching) return this.speedNow > 0.4 ? 'crouchWalk' : 'crouch';
    if (this.speedNow > 3.6) return 'run';
    if (this.speedNow > 0.4) return 'walk';
    return 'idle';
  }
}

/** Third-person orbit camera with collision pull-in. */
export class ThirdPersonCamera {
  distance = 3.4;
  private cur = new THREE.Vector3();
  constructor(readonly camera: THREE.PerspectiveCamera, private physics: Physics) {}

  update(target: THREE.Vector3, yaw: number, pitch: number, dt: number, exclude?: import('@dimforge/rapier3d-compat').Collider): void {
    const head = target.clone().add(new THREE.Vector3(0, 1.65, 0));
    const shoulder = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)).multiplyScalar(0.55);
    const pivot = head.clone().add(shoulder);
    const back = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    let dist = this.distance;
    const hit = this.physics.raycast(pivot, back, dist + 0.3, exclude);
    if (hit) dist = Math.max(0.6, hit.distance - 0.3);
    const want = pivot.clone().addScaledVector(back, dist);
    if (this.cur.lengthSq() === 0) this.cur.copy(want);
    this.cur.lerp(want, Math.min(1, dt * 18));
    if (hit) this.cur.copy(want);
    this.camera.position.copy(this.cur);
    this.camera.lookAt(pivot.clone().addScaledVector(back, -10));
  }
}
