// First-person arms + weapon, rendered in a separate scene after clearing depth so it never
// clips into walls. Procedural animation: bob, sway, recoil, reload, draw, knife swing, throw.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Assets } from '../engine/Assets';

export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
  private rig = new THREE.Group();
  private gun: THREE.Object3D | null = null;
  private muzzle: THREE.Object3D | null = null;
  private armL: THREE.Mesh;
  private armR: THREE.Mesh;
  private jacketMat = new THREE.MeshStandardMaterial({ color: 0x1c2230, roughness: 0.55, metalness: 0.15 });
  private flash: THREE.Mesh;
  private model = '';
  private kick = 0;
  private reloadT = -1;
  private reloadDur = 1;
  private drawT = 1;
  private swingT = 1;
  private throwT = 1;
  private bobT = 0;
  private sway = new THREE.Vector2();
  ads = 0;
  visible = true;

  /** Must be called once with the main renderer so metal parts get reflections. */
  initEnvironment(renderer: THREE.WebGLRenderer): void {
    if (this.scene.environment) return;
    const pm = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    pm.dispose();
  }

  constructor() {
    this.scene.add(new THREE.HemisphereLight(0x8090c0, 0x201820, 1.2));
    const key = new THREE.DirectionalLight(0xbfd8ff, 1.6);
    key.position.set(1, 2, 1);
    this.scene.add(key);
    const rim = new THREE.PointLight(0xff2bd6, 2, 3);
    rim.position.set(-0.6, 0.2, -0.2);
    this.scene.add(rim);
    this.scene.add(this.camera);
    this.camera.add(this.rig);
    const glove = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.75 });
    const mkArm = () => {
      const g = new THREE.Group();
      const fore = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.075, 0.34, 2, 0.02), this.jacketMat);
      fore.position.z = 0.17;
      const hand = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.09, 0.1, 2, 0.02), glove);
      hand.position.z = -0.02;
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.077, 0.01, 0.08), new THREE.MeshStandardMaterial({ color: 0, emissive: 0x00e5ff, emissiveIntensity: 0.7 }));
      stripe.position.set(0, 0.035, 0.12);
      g.add(fore, hand, stripe);
      return g;
    };
    const l = mkArm(), r = mkArm();
    this.armL = l as unknown as THREE.Mesh;
    this.armR = r as unknown as THREE.Mesh;
    this.rig.add(l, r);
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 3.4, 1.2), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, map: (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      g.translate(32, 32);
      for (let i = 0; i < 6; i++) { g.rotate(Math.PI / 3); const gr = g.createLinearGradient(0, 0, 30, 0); gr.addColorStop(0, '#fff'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.beginPath(); g.moveTo(0, -4); g.lineTo(30, 0); g.lineTo(0, 4); g.fill(); }
      return new THREE.CanvasTexture(c);
    })() }));
    this.rig.add(this.flash);
  }

  setLook(jacket: number): void { this.jacketMat.color.setHex(jacket); }

  setWeapon(model: string, finish: string): void {
    const key = `${model}:${finish}`;
    if (key === this.model) return;
    this.model = key;
    if (this.gun) this.rig.remove(this.gun);
    this.gun = Assets.weapon(model, finish);
    this.gun.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = false; });
    this.rig.add(this.gun);
    this.muzzle = this.gun.getObjectByName('Muzzle') ?? null;
    this.drawT = 0;
    this.reloadT = -1;
  }

  fire(strength: number): void {
    this.kick = Math.min(1.4, this.kick + strength);
    (this.flash.material as THREE.MeshBasicMaterial).opacity = 1;
    this.flash.rotation.z = Math.random() * Math.PI;
  }
  swing(): void { this.swingT = 0; }
  throwAnim(): void { this.throwT = 0; }
  reload(duration: number): void { this.reloadT = 0; this.reloadDur = duration; }
  cancelReload(): void { this.reloadT = -1; }
  get reloading(): boolean { return this.reloadT >= 0 && this.reloadT < 1; }

  /** World-space muzzle position given the main camera. */
  muzzleWorld(mainCam: THREE.Camera): THREE.Vector3 {
    const p = new THREE.Vector3();
    if (this.muzzle) { this.camera.updateMatrixWorld(); this.muzzle.getWorldPosition(p); }
    else p.set(0.15, -0.1, -0.6);
    // viewmodel camera sits at the origin with identity rotation → p is in view space
    return p.applyMatrix4(mainCam.matrixWorld);
  }

  update(dt: number, moveSpeed: number, look: { dx: number; dy: number }, grounded: boolean, crouch: boolean): void {
    this.rig.visible = this.visible;
    const raw = this.model.split(':')[0];
    const m = raw === 'longpistol' ? 'pistol' : raw === 'bullpup' ? 'rifle' : raw;
    this.kick = Math.max(0, this.kick - dt * 9);
    const fm = this.flash.material as THREE.MeshBasicMaterial;
    fm.opacity = Math.max(0, fm.opacity - dt * 30);
    this.drawT = Math.min(1, this.drawT + dt * 2.8);
    this.swingT = Math.min(1, this.swingT + dt * 3);
    this.throwT = Math.min(1, this.throwT + dt * 2.2);
    if (this.reloadT >= 0) { this.reloadT += dt / this.reloadDur; if (this.reloadT >= 1) this.reloadT = -1; }
    this.bobT += dt * (grounded ? moveSpeed * 1.6 : 0);
    const bobAmp = Math.min(1, moveSpeed / 5) * (1 - this.ads * 0.85);
    this.sway.x = THREE.MathUtils.lerp(this.sway.x, -look.dx * 2.2, Math.min(1, dt * 10));
    this.sway.y = THREE.MathUtils.lerp(this.sway.y, look.dy * 2.2, Math.min(1, dt * 10));
    const melee = m === 'knife';
    const nade = m === 'smoke' || m === 'flash' || m === 'molotov' || m === 'c4';
    const hip = new THREE.Vector3(melee ? 0.2 : 0.17, melee ? -0.2 : -0.17, melee ? -0.35 : -0.38);
    const adsPos = new THREE.Vector3(0, m === 'pistol' ? -0.075 : m === 'sniper' ? -0.125 : -0.105, m === 'pistol' ? -0.34 : -0.26);
    const pos = hip.clone().lerp(adsPos, nade || melee ? 0 : this.ads);
    pos.x += Math.sin(this.bobT) * 0.012 * bobAmp + this.sway.x * 0.02;
    pos.y += -Math.abs(Math.cos(this.bobT)) * 0.012 * bobAmp + this.sway.y * 0.02 - (crouch ? 0.01 : 0);
    pos.z += this.kick * 0.06;
    let rx = this.kick * 0.12 + this.sway.y * 0.05, ry = this.sway.x * 0.05, rz = Math.sin(this.bobT) * 0.01 * bobAmp;
    // draw (raise from below)
    const dk = 1 - Math.pow(1 - this.drawT, 3);
    pos.y -= (1 - dk) * 0.25;
    rx -= (1 - dk) * 0.6;
    // reload: dip + roll
    if (this.reloadT >= 0) {
      const k = Math.sin(this.reloadT * Math.PI);
      pos.y -= k * 0.08;
      rz += k * 0.6;
      rx += k * 0.25;
    }
    if (melee && this.swingT < 1) {
      const k = Math.sin(this.swingT * Math.PI);
      pos.x -= k * 0.18;
      ry += k * 1.1;
      rz -= k * 0.6;
    }
    if (nade && this.throwT < 1) {
      const k = Math.sin(this.throwT * Math.PI);
      pos.y += k * 0.15;
      pos.z -= k * 0.2;
      rx -= k * 0.8;
    }
    if (this.gun) {
      this.gun.position.copy(pos);
      this.gun.rotation.set(rx, ry, rz);
      this.gun.scale.setScalar(melee ? 1.2 : m === 'c4' ? 1.4 : nade ? 1.6 : 1);
    }
    // arms follow the weapon: right hand on grip, left hand on handguard
    const gq = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
    const grip = pos.clone().add(new THREE.Vector3(0.0, -0.05, 0.03).applyQuaternion(gq));
    const fore = pos.clone().add(new THREE.Vector3(m === 'pistol' ? 0.0 : -0.01, -0.03, m === 'pistol' ? 0.02 : m === 'smg' ? -0.2 : -0.36).applyQuaternion(gq));
    this.armR.position.copy(grip);
    this.armR.quaternion.copy(gq).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25, -0.2, 0)));
    this.armL.visible = !melee && !nade;
    this.armL.position.copy(fore).add(new THREE.Vector3(-0.03, 0, 0));
    this.armL.quaternion.copy(gq).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.45, 0.2)));
    if (this.muzzle) {
      this.muzzle.updateMatrixWorld();
      const mp = new THREE.Vector3();
      this.muzzle.getWorldPosition(mp);
      this.rig.worldToLocal(mp);
      this.flash.position.copy(mp);
      this.flash.visible = fm.opacity > 0.01;
    } else this.flash.visible = false;
  }
}
