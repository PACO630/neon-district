// A visible character (remote player, NPC, statue) built on the CC0 Quaternius rig, with
// AnimationMixer cross-fading, directional locomotion, a procedural crouch, a held weapon and a nameplate.
import * as THREE from 'three';
import { Assets, applyLook, type CharacterInstance, type CharKind } from '../engine/Assets';
import { LAYER_FX } from '../engine/shaders';
import { ANIM_NAMES, type AnimName } from '../networking/protocol';
import type { Look } from '../room/RoomState';

export type MoveDir = 'fwd' | 'back' | 'left' | 'right';

/** Game animation → clip name on the Quaternius "CharacterArmature" rig. */
function clipFor(anim: AnimName, armed: boolean, dir: MoveDir): string {
  switch (anim) {
    case 'idle': return armed ? 'Idle_Gun' : 'Idle_Neutral';
    case 'crouch': return armed ? 'Idle_Gun_Pointing' : 'Idle_Neutral';
    case 'walk':
    case 'crouchWalk': return dir === 'back' ? 'Run_Back' : dir === 'left' ? 'Run_Left' : dir === 'right' ? 'Run_Right' : 'Walk';
    case 'run': return dir === 'back' ? 'Run_Back' : dir === 'left' ? 'Run_Left' : dir === 'right' ? 'Run_Right' : armed ? 'Run_Shoot' : 'Run';
    case 'jump': return armed ? 'Idle_Gun_Pointing' : 'Idle';
    case 'sit': return 'Idle_Neutral';
    case 'drink': return 'Interact';
    case 'wave': return 'Wave';
    case 'dance': return 'Idle_Sword';
    case 'die': return 'Death';
    case 'plant': return 'Interact';
  }
}

/**
 * Weapon-in-hand transform, derived once per rig from its own "Idle_Gun" pose: the rotation that
 * makes the barrel point along the character's facing, expressed in the wrist bone's local space
 * (which is in the armature's centimetre units, hence the counter-scale).
 */
const grips = new Map<CharKind, { quat: THREE.Quaternion; scale: number }>();
function gripFor(kind: CharKind): { quat: THREE.Quaternion; scale: number } {
  let g = grips.get(kind);
  if (g) return g;
  const probe = Assets.character({ jacket: 0, visor: 0, trim: 0 }, kind);
  const act = probe.actions.get('Idle_Gun');
  act?.play();
  probe.mixer.update(0.05);
  probe.root.updateMatrixWorld(true);
  const hq = probe.hand.getWorldQuaternion(new THREE.Quaternion());
  const hs = probe.hand.getWorldScale(new THREE.Vector3()).x || 1;
  // the model faces +Z; the gun's barrel is -Z → rotate it half a turn about Y in world space
  const want = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  g = { quat: hq.invert().multiply(want), scale: 1 / hs };
  grips.set(kind, g);
  return g;
}

export class Avatar {
  readonly root = new THREE.Group();
  readonly char: CharacterInstance;
  private current: THREE.AnimationAction | null = null;
  private currentKey = '';
  private nameplate: THREE.Sprite | null = null;
  private nameCanvas: HTMLCanvasElement | null = null;
  private weaponObj: THREE.Object3D | null = null;
  private weaponKey = '';
  armed = false;
  anim: AnimName = 'idle';
  moveDir: MoveDir = 'fwd';
  /** visual yaw smoothing */
  yaw = 0;
  private targetYaw = 0;
  private crouchK = 0;

  constructor(look: Look, kind: CharKind = 'swat') {
    this.char = Assets.character(look, kind);
    this.root.add(this.char.root);
    this.char.root.rotation.y = Math.PI; // models face +Z; game forward is -Z
    this.play('idle', 0);
  }

  setLook(look: Look): void { applyLook(this.char, look); }

  setName(text: string, color = '#7ff6ff', sub = ''): void {
    if (!this.nameCanvas) {
      this.nameCanvas = document.createElement('canvas');
      this.nameCanvas.width = 512;
      this.nameCanvas.height = 128;
      const tex = new THREE.CanvasTexture(this.nameCanvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.nameplate = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
      this.nameplate.scale.set(1.6, 0.4, 1);
      this.nameplate.position.y = 2.25;
      this.nameplate.layers.set(LAYER_FX);
      this.nameplate.renderOrder = 20;
      this.root.add(this.nameplate);
    }
    const ctx = this.nameCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, 512, 128);
    ctx.font = '700 46px Rajdhani, "PingFang TC", "Hiragino Sans", "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = Math.min(500, ctx.measureText(text).width + 40);
    ctx.fillStyle = 'rgba(4,8,14,0.72)';
    ctx.fillRect(256 - w / 2, 22, w, 56);
    ctx.fillStyle = color;
    ctx.fillRect(256 - w / 2, 22, 4, 56);
    ctx.fillStyle = '#e8f6ff';
    ctx.fillText(text, 256, 52);
    if (sub) {
      ctx.font = '600 28px Rajdhani, sans-serif';
      ctx.fillStyle = color;
      ctx.fillText(sub, 256, 104);
    }
    (this.nameplate!.material.map as THREE.Texture).needsUpdate = true;
  }

  showName(v: boolean): void { if (this.nameplate) this.nameplate.visible = v; }

  play(anim: AnimName, fade = 0.2): void {
    this.anim = anim;
    const clip = clipFor(anim, this.armed, this.moveDir);
    if (clip === this.currentKey) return;
    const next = this.char.actions.get(clip) ?? this.char.actions.get('Idle');
    if (!next) return;
    next.reset();
    if (anim === 'die') { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true; }
    else next.setLoop(THREE.LoopRepeat, Infinity);
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.timeScale = anim === 'crouchWalk' ? 0.6 : anim === 'walk' && clip.startsWith('Run_') ? 0.55 : 1;
    next.play();
    if (this.current && fade > 0) this.current.crossFadeTo(next, fade, false);
    else if (this.current) this.current.stop();
    this.current = next;
    this.currentKey = clip;
  }

  playCode(code: number): void { this.play(ANIM_NAMES[code] ?? 'idle'); }

  /** Chooses forward / backward / strafe locomotion from a world-space velocity. */
  setVelocity(vx: number, vz: number): void {
    if (Math.hypot(vx, vz) < 0.3) return;
    const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
    const f = vx * fwdX + vz * fwdZ;
    const r = vx * -fwdZ + vz * fwdX;
    const next: MoveDir = Math.abs(f) >= Math.abs(r) ? (f >= 0 ? 'fwd' : 'back') : r > 0 ? 'right' : 'left';
    if (next !== this.moveDir) { this.moveDir = next; this.currentKey = ''; this.play(this.anim, 0.15); }
  }

  setTimeScale(s: number): void { if (this.current) this.current.timeScale = s; }

  /** model: 'rifle' | 'pistol' | ... or null for unarmed */
  setWeapon(model: string | null, finish = 'stock'): void {
    const key = `${model}:${finish}`;
    if (key === this.weaponKey) return;
    this.weaponKey = key;
    if (this.weaponObj) { this.weaponObj.removeFromParent(); this.weaponObj = null; }
    const wasArmed = this.armed;
    this.armed = !!model && !['knife', 'c4', 'smoke', 'flash', 'molotov'].includes(model);
    if (model) {
      const w = Assets.weapon(model, finish);
      const g = gripFor(this.char.kind);
      w.scale.setScalar(g.scale);
      w.quaternion.copy(g.quat);
      this.char.hand.add(w);
      this.weaponObj = w;
    }
    if (wasArmed !== this.armed) { const a = this.anim; this.currentKey = ''; this.play(a, 0.15); }
  }

  setYaw(y: number, instant = false): void {
    this.targetYaw = y;
    if (instant) this.yaw = y;
  }

  update(dt: number): void {
    let d = this.targetYaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * Math.min(1, dt * 12);
    this.root.rotation.y = this.yaw;
    this.char.mixer.update(dt);
    // procedural crouch layered on top of the clip (the rig has no crouch animation)
    const want = this.anim === 'crouch' || this.anim === 'crouchWalk' ? 1 : 0;
    this.crouchK += (want - this.crouchK) * Math.min(1, dt * 10);
    if (this.crouchK > 0.01) {
      const k = this.crouchK;
      const L = this.char.legs;
      L.upperL?.rotateX(-1.1 * k);
      L.upperR?.rotateX(-1.1 * k);
      L.lowerL?.rotateX(1.7 * k);
      L.lowerR?.rotateX(1.7 * k);
      this.char.root.position.y = -0.38 * k;
    } else this.char.root.position.y = 0;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.char.mixer.stopAllAction();
    if (this.nameplate) { (this.nameplate.material.map as THREE.Texture).dispose(); this.nameplate.material.dispose(); }
  }
}
