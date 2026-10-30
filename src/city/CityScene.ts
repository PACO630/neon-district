// NEON CITY runtime: third-person exploration, remote players (interpolated), NPCs, interactions.
import * as THREE from 'three';
import type { GameContext } from '../core/GameContext';
import { NightEnvironment } from '../engine/Environment';
import { ANIM, ANIM_NAMES, decodeCity, encodeCity, MSG, type AnimName, type CityState } from '../networking/protocol';
import { Avatar } from '../player/Avatar';
import { Mover } from '../player/Mover';
import type { Physics } from '../physics/Physics';
import type { RoomState } from '../room/RoomState';
import { buildCity, type CityBuild, type Interactable } from './CityBuilder';
import { NpcSystem, type Npc } from './NPCs';

interface Remote { avatar: Avatar; buf: { t: number; s: CityState }[]; lastSeq: number; name: string; key: string }

const INTERP_DELAY = 0.12;

export class CityScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1500);
  private physics!: Physics;
  private env!: NightEnvironment;
  build!: CityBuild;
  private npcs!: NpcSystem;
  private mover!: Mover;
  private me!: Avatar;
  private remotes = new Map<string, Remote>();
  private time = 0;
  private sendAcc = 0;
  private seq = 0;
  private emote: AnimName | null = null;
  private emoteUntil = 0;
  private stepAcc = 0;
  private bobT = 0;
  active = false;
  menuMode = true;
  prompt: { label: string; key: string } | null = null;
  private focusInteract: Interactable | Npc | null = null;
  onInteract: (kind: string, data?: any) => void = () => {};
  onSpeech: (name: string, line: string) => void = () => {};
  private unsub: (() => void)[] = [];
  private puddleData: Uint8Array | null = null;
  private puddleSize = 0;

  constructor(private ctx: GameContext) {}

  async load(onProgress: (p: number, label: string) => void): Promise<void> {
    this.physics = this.ctx.newPhysics();
    onProgress(0.1, 'Synthesizing PBR materials');
    await new Promise((r) => setTimeout(r, 0));
    this.build = buildCity(this.physics, this.ctx.settings.graphics);
    onProgress(0.6, 'Raising the skyline');
    this.scene.add(this.build.group);
    this.env = new NightEnvironment(this.scene, this.ctx.settings.graphics, { fogDensity: 0.0085, drips: this.build.drips, shelters: this.build.shelters, shadowExtent: 45, ambient: 2.2, fogColor: 0x1a2236 });
    this.env.setLights(this.scene, this.build.anchors);
    this.env.rain.setGround(0);
    onProgress(0.75, 'Spawning citizens');
    this.npcs = new NpcSystem(this.scene, this.build.npcs);
    this.mover = new Mover(this.physics, this.build.spawn);
    this.me = new Avatar(this.ctx.settings.look);
    this.me.showName(false);
    this.me.root.visible = false; // first person: the local body is only seen by others
    this.scene.add(this.me.root);
    this.physics.step();
    onProgress(0.85, 'Capturing reflection probe');
    this.env.update(0, this.camera, this.build.spawn);
    this.camera.position.set(0, 6, 30);
    this.camera.lookAt(0, 4, 0);
    this.env.lightPool?.update(0, this.build.probePoint, true);
    this.env.captureProbe(this.ctx.renderer.gl, this.build.probePoint);
    // puddle mask on the CPU for footstep splashes
    const mask = (this.build.group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh | undefined);
    void mask;
    onProgress(1, 'Ready');
  }

  setPuddleMask(tex: THREE.DataTexture | undefined): void {
    if (!tex) return;
    this.puddleData = tex.image.data as Uint8Array;
    this.puddleSize = tex.image.width;
  }

  private puddleAt(x: number, z: number): number {
    if (!this.puddleData) return 0;
    const s = this.puddleSize;
    const u = (((x / 22) % 1) + 1) % 1, v = (((z / 22) % 1) + 1) % 1;
    return this.puddleData[(Math.floor(v * s) * s + Math.floor(u * s)) * 4] / 255;
  }

  enter(): void {
    this.active = true;
    this.menuMode = false;
    this.ctx.renderer.setScene(this.scene, this.camera);
    this.ctx.renderer.setViewmodel(null, null);
    this.ctx.renderer.setMenuDof(false);
    this.ctx.renderer.gl.toneMappingExposure = 1.18;
    this.ctx.input.wantLock = !this.ctx.mobile;
    this.ctx.touch.setMode(this.ctx.mobile ? 'city' : 'off');
    this.ctx.audio.startAmbience('city', this.build.jinglePoints, this.build.chatterPoints);
    this.ctx.audio.startBarMusic(this.build.barPos);
    this.me.setLook(this.ctx.room.self?.look ?? this.ctx.settings.look);
    const net = this.ctx.net;
    this.unsub.push(net.onBin(MSG.CITY_STATE, (from, r) => this.onRemoteState(from, decodeCity(r))));
    this.unsub.push(this.ctx.room.on('state', (s) => this.syncRoster(s)));
    this.unsub.push(this.ctx.room.on('event', (ev) => {
      if (ev.e === 'drink') {
        const av = ev.player === this.ctx.room.selfId ? this.me : this.remotes.get(ev.player)?.avatar;
        if (ev.player === this.ctx.room.selfId) { this.emote = 'drink'; this.emoteUntil = this.time + 3; }
        this.ctx.audio.drink(av?.root.position);
      }
    }));
    if (this.ctx.room.state) this.syncRoster(this.ctx.room.state);
  }

  exit(): void {
    this.active = false;
    this.unsub.forEach((u) => u());
    this.unsub = [];
    this.ctx.audio.stopAmbience();
    this.ctx.audio.stopMusic();
    for (const id of [...this.remotes.keys()]) this.removeRemote(id);
  }

  /** Background for the main menu: slow cinematic orbit with depth of field. */
  enterMenu(): void {
    this.menuMode = true;
    this.active = false;
    this.ctx.renderer.setScene(this.scene, this.camera);
    this.ctx.renderer.setViewmodel(null, null);
    this.ctx.renderer.setMenuDof(true);
    this.ctx.renderer.gl.toneMappingExposure = 1.18;
    this.ctx.input.wantLock = false;
    this.ctx.input.exitLock();
    this.ctx.touch.setMode('off');
  }

  respawnAtGate(): void {
    this.mover.teleport(new THREE.Vector3(0, 0.15, -92), 0);
  }

  // ------------------------------------------------------------- remote players
  syncRoster(s: RoomState): void {
    const inArena = new Set(s.match ? Object.keys(s.match.players) : []);
    for (const p of Object.values(s.players)) {
      if (p.id === this.ctx.room.selfId) { this.me.setLook(p.look); continue; }
      const hidden = inArena.has(p.id) && !!s.match;
      let r = this.remotes.get(p.id);
      if (!r) {
        const avatar = new Avatar(p.look);
        avatar.root.visible = false;
        this.scene.add(avatar.root);
        r = { avatar, buf: [], lastSeq: -1, name: '', key: '' };
        this.remotes.set(p.id, r);
      }
      const party = p.partyId ? s.parties[p.partyId] : null;
      const sameParty = !!party && party.id === s.players[this.ctx.room.selfId]?.partyId;
      const key = `${p.name}|${party?.name ?? ''}|${sameParty}|${p.device}|${p.id === s.hostId}|${hidden}`;
      if (key !== r.key) {
        r.key = key;
        const sub = [p.id === s.hostId ? 'HOST' : '', party ? `[${party.name}]` : '', p.device === 'mobile' ? '📱' : '', hidden ? 'IN ARENA' : ''].filter(Boolean).join(' · ');
        r.avatar.setName(p.name, sameParty ? '#8aff3a' : '#00e5ff', sub);
        r.avatar.setLook(p.look);
      }
      r.avatar.setLook(p.look);
      r.avatar.root.userData.hidden = hidden;
    }
    for (const id of [...this.remotes.keys()]) if (!s.players[id]) this.removeRemote(id);
  }

  removeRemote(id: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    r.avatar.dispose();
    this.remotes.delete(id);
  }

  private onRemoteState(from: string, s: CityState): void {
    const r = this.remotes.get(from);
    if (!r) return;
    if (r.lastSeq >= 0 && ((s.seq - r.lastSeq + 65536) % 65536) > 32768) return; // stale
    r.lastSeq = s.seq;
    r.buf.push({ t: performance.now() / 1000, s });
    if (r.buf.length > 30) r.buf.shift();
  }

  private updateRemotes(dt: number): void {
    const renderT = performance.now() / 1000 - INTERP_DELAY;
    for (const r of this.remotes.values()) {
      const b = r.buf;
      if (!b.length || r.avatar.root.userData.hidden) { r.avatar.root.visible = false; continue; }
      r.avatar.root.visible = true;
      let a = b[0], c = b[b.length - 1];
      for (let i = b.length - 1; i > 0; i--) if (b[i - 1].t <= renderT) { a = b[i - 1]; c = b[i]; break; }
      const span = Math.max(1e-3, c.t - a.t);
      let k = (renderT - a.t) / span;
      const pos = new THREE.Vector3();
      if (k <= 1) {
        k = Math.max(0, k);
        pos.set(a.s.x + (c.s.x - a.s.x) * k, a.s.y + (c.s.y - a.s.y) * k, a.s.z + (c.s.z - a.s.z) * k);
      } else {
        // extrapolate briefly (max 250 ms) when packets are late
        const ex = Math.min(k - 1, 0.25 / span);
        pos.set(c.s.x + (c.s.x - a.s.x) * ex, c.s.y + (c.s.y - a.s.y) * ex, c.s.z + (c.s.z - a.s.z) * ex);
      }
      r.avatar.root.position.copy(pos);
      r.avatar.setYaw(c.s.yaw);
      r.avatar.setVelocity((c.s.x - a.s.x) / span, (c.s.z - a.s.z) / span);
      r.avatar.playCode(c.s.anim);
      r.avatar.update(dt);
    }
  }

  // ------------------------------------------------------------- interactions
  private findFocus(): void {
    const p = this.mover.feet;
    let best: Interactable | Npc | null = null;
    let bd = Infinity;
    for (const it of this.build.interactables) {
      const d = Math.hypot(it.pos.x - p.x, it.pos.z - p.z);
      if (d < it.radius && Math.abs(it.pos.y - p.y) < 2.5 && d < bd) { bd = d; best = it; }
    }
    if (!best) {
      const n = this.npcs.nearest(p, 2.4);
      if (n) best = n;
    }
    this.focusInteract = best;
    if (!best) this.prompt = null;
    else if ('kind' in best) this.prompt = { label: best.label, key: 'E' };
    else this.prompt = { label: `Talk to ${best.spot.name}`, key: 'E' };
  }

  private interact(): void {
    const f = this.focusInteract;
    if (!f) return;
    if ('kind' in f) { this.onInteract(f.kind); return; }
    const line = this.npcs.talk(f, this.mover.feet, this.time);
    this.onSpeech(f.spot.name, line);
    if (f.spot.shop) this.onInteract(f.spot.shop);
  }

  // ------------------------------------------------------------- frame
  update(dt: number): void {
    this.time += dt;
    for (const fn of this.build.animate) fn(this.time, dt);
    if (this.menuMode) {
      const a = this.time * 0.04;
      this.camera.position.set(Math.sin(a) * 26, 7 + Math.sin(this.time * 0.1) * 2, Math.cos(a) * 26);
      this.camera.lookAt(0, 5, 0);
      this.npcs.update(dt, this.camera.position, this.time);
      this.env.update(dt, this.camera, this.camera.position);
      return;
    }
    const input = this.ctx.input;
    this.mover.look(input, 1.45);
    this.mover.update(dt, input, { speed: 7.2, walkMult: 0.42, crouchMult: 0.4, frozen: false, faceMovement: false });
    this.physics.step();
    // emotes
    if (input.pressed('emote1')) { this.emote = 'wave'; this.emoteUntil = this.time + 2.4; }
    if (input.pressed('emote2')) { this.emote = this.emote === 'dance' ? null : 'dance'; this.emoteUntil = this.time + 600; }
    const moving = this.mover.speedNow > 0.4;
    if (moving && this.emote) this.emote = null;
    if (this.emote && this.time > this.emoteUntil) this.emote = null;
    const anim: AnimName = this.emote ?? this.mover.animName();
    this.me.root.position.copy(this.mover.feet);
    this.me.setYaw(this.mover.bodyYaw);
    this.me.play(anim);
    // first-person camera with a gentle head bob
    const eye = this.mover.crouching ? 1.15 : 1.66;
    if (this.mover.grounded) this.bobT += dt * this.mover.speedNow * 1.9;
    const bob = Math.min(1, this.mover.speedNow / 5);
    this.camera.position.set(this.mover.feet.x, this.mover.feet.y + eye + Math.abs(Math.sin(this.bobT)) * 0.035 * bob, this.mover.feet.z);
    this.camera.rotation.set(this.mover.pitch, this.mover.yaw, Math.sin(this.bobT) * 0.004 * bob, 'YXZ');
    this.camera.updateMatrixWorld();
    // footsteps + puddle splashes
    if (moving && this.mover.grounded) {
      this.stepAcc += dt * this.mover.speedNow;
      if (this.stepAcc > 1.6) {
        this.stepAcc = 0;
        const wet = this.puddleAt(this.mover.feet.x, this.mover.feet.z) > 0.35 && this.mover.feet.y < 0.1;
        if (wet) this.env.rain.splash(this.mover.feet, this.mover.speedNow > 4 ? 1 : 0.6);
        this.ctx.audio.footstep(undefined, wet || !this.isIndoor(this.mover.feet), this.mover.speedNow > 4 ? 0.5 : 0.3);
      }
    }
    if (this.mover.justLanded) this.env.rain.splash(this.mover.feet, 1.2);
    // network send (15 Hz)
    this.sendAcc += dt;
    if (this.sendAcc > 1 / 15) {
      this.sendAcc = 0;
      const f = this.mover.feet;
      this.ctx.net.broadcast(encodeCity({ seq: (this.seq = (this.seq + 1) & 0xffff), x: f.x, y: f.y, z: f.z, yaw: this.mover.bodyYaw, anim: ANIM[anim], flags: 0 }), false);
    }
    this.updateRemotes(dt);
    this.npcs.update(dt, this.camera.position, this.time);
    this.findFocus();
    if (input.pressed('interact')) this.interact();
    this.ctx.touch.setUseLabel(this.prompt ? 'USE' : null);
    this.env.update(dt, this.camera, this.mover.feet);
    this.ctx.audio.setOutdoor(this.isIndoor(this.camera.position) ? 0 : 1);
    void ANIM_NAMES;
  }

  setRain(on: boolean): void { this.env?.setRain(on); }
  isIndoor(p: THREE.Vector3): boolean { return this.build.indoor.some((b) => b.containsPoint(p)); }
  get playerPos(): THREE.Vector3 { return this.mover.feet; }
  get playerYaw(): number { return this.mover.yaw; }
  get remoteCount(): number { return this.remotes.size; }
  /** Locations for the city map HUD */
  remotePositions(): { id: string; pos: THREE.Vector3 }[] {
    return [...this.remotes.entries()].filter(([, r]) => r.avatar.root.visible).map(([id, r]) => ({ id, pos: r.avatar.root.position }));
  }
}
