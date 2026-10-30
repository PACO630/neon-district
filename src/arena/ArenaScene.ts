// TACTICAL ARENA client: first-person movement (client-predicted, host-validated), weapons,
// snapshot interpolation of other players, spectating, grenades/C4 interaction and VFX.
import * as THREE from 'three';
import { MATCH_RULES } from '../config/economy';
import { WEAPONS, type GrenadeId, type WeaponId } from '../config/weapons';
import type { GameContext } from '../core/GameContext';
import { Effects } from '../combat/Effects';
import { Viewmodel } from '../combat/Viewmodel';
import { Assets } from '../engine/Assets';
import { NightEnvironment } from '../engine/Environment';
import {
  ANIM, decodeShotFx, decodeSnapshot, encodeArenaInput, encodeFire, IN_ADS, IN_AIR, IN_CROUCH, IN_WALK, itemCode, itemFromCode, MSG, seqNewer,
  type ArenaInput, type FireMsg, type NetPlayer, type ShotFx, type Snapshot,
} from '../networking/protocol';
import type { Physics } from '../physics/Physics';
import { Avatar } from '../player/Avatar';
import { Mover } from '../player/Mover';
import type { GameEvent } from '../room/Room';
import { playerSide, sideOf, type MatchPlayer, type MatchState, type RoomState, type Side } from '../room/RoomState';
import { buildArenaVisuals, type ArenaBuild } from './ArenaBuilder';
import { addSector09Colliders, ARENA_SHELTERS, BUY_ZONES, inZone, SITES } from './Sector09';
import { RUN_SPEED } from './MatchHost';

interface RemoteP { id: string; avatar: Avatar; buf: { t: number; p: NetPlayer }[]; alive: boolean; stepAcc: number; lastAnim: number }
export interface KillFeedItem { killer: string; victim: string; weapon: string; head: boolean; t: number; mine: boolean; killerSide: Side | null; victimSide: Side | null }

const INTERP = 0.1;
const MODEL_OF = (item: string): string => (item in WEAPONS ? WEAPONS[item as WeaponId].model : item);

export class ArenaScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(75, 1, 0.05, 1200);
  private physics!: Physics;
  private env!: NightEnvironment;
  private build!: ArenaBuild;
  readonly fx: Effects;
  readonly vm = new Viewmodel();
  private mover!: Mover;
  private remotes = new Map<string, RemoteP>();
  private snapHist = new Map<number, Snapshot>();
  private latestSeq = 0;
  private inputSeq = 0;
  private sendAcc = 0;
  private time = 0;
  private unsub: (() => void)[] = [];
  private bombMesh: THREE.Object3D;
  private bombLight: THREE.PointLight;
  private beepAcc = 0;
  private plantedAt = 0;
  private projMeshes = new Map<number, THREE.Object3D>();
  // ---- local combat state
  alive = true;
  hp = 100;
  armor = 0;
  equipped = 'p12';
  private lastWeapon = 'p12';
  ammo: Record<string, [number, number]> = {};
  private nextFire = 0;
  private reloadEnd = 0;
  private drawEnd = 0;
  private lastShotAt = 0;
  private recoil = new THREE.Vector2();
  private bloom = 0;
  private shotSeq = 0;
  ads = false;
  private triggerReleased = true;
  private actionHeld: 'plant' | 'defuse' | null = null;
  actionStartedAt = 0;
  actionDuration = 1;
  phaseRemaining = 0;
  private phaseStamp = 0;
  actionProgress = 0;
  flash = 0;
  damageFlash = 0;
  damageDir: number | null = null;
  damageDirUntil = 0;
  hitmarker = 0;
  hitmarkerHead = false;
  killfeed: KillFeedItem[] = [];
  spectateId: string | null = null;
  private deathAt = 0;
  private respawnedAt = -10;
  prompt: string | null = null;
  centerMsg: { text: string; sub?: string; until: number; color?: string } | null = null;
  scoreboardOpen = false;
  onBuyToggle: () => void = () => {};
  onLeaveRequest: () => void = () => {};
  sendInput: (inp: ArenaInput) => void = () => {};
  sendFire: (f: FireMsg) => void = () => {};
  private puddle: Uint8Array | null = null;
  private puddleSize = 0;
  private stepAcc = 0;

  constructor(private ctx: GameContext) {
    this.fx = new Effects(ctx.settings.graphics.particles);
    this.bombMesh = new THREE.Group();
    this.bombLight = new THREE.PointLight(0xff2020, 0, 4, 2);
  }

  async load(onProgress: (p: number, label: string) => void): Promise<void> {
    this.physics = this.ctx.newPhysics();
    addSector09Colliders(this.physics);
    onProgress(0.2, 'Building SECTOR 09');
    await new Promise((r) => setTimeout(r, 0));
    this.build = buildArenaVisuals(this.ctx.settings.graphics);
    this.scene.add(this.build.group);
    this.env = new NightEnvironment(this.scene, this.ctx.settings.graphics, { fogDensity: 0.009, drips: this.build.drips, shelters: ARENA_SHELTERS, shadowExtent: 40, ambient: 4 });
    this.env.setLights(this.scene, this.build.anchors);
    this.env.rain.setGround(0);
    this.scene.add(this.fx.group);
    this.mover = new Mover(this.physics, new THREE.Vector3(0, 0, 48));
    this.bombMesh = Assets.weapon('c4');
    this.bombMesh.visible = false;
    this.bombMesh.add(this.bombLight);
    this.bombLight.position.y = 0.2;
    this.scene.add(this.bombMesh);
    this.physics.step();
    onProgress(0.8, 'Capturing reflection probe');
    this.env.update(0, this.camera, new THREE.Vector3(0, 0, 0));
    this.env.lightPool?.update(0, new THREE.Vector3(0, 2, 0), true);
    this.env.captureProbe(this.ctx.renderer.gl, new THREE.Vector3(0, 3, 0));
    const mask = this.build.puddleMask as THREE.DataTexture | undefined;
    if (mask) { this.puddle = mask.image.data as Uint8Array; this.puddleSize = mask.image.width; }
    onProgress(1, 'Ready');
  }

  private get room() { return this.ctx.room; }
  private get match(): MatchState | null { return this.room.state?.match ?? null; }
  private get me(): MatchPlayer | null { return this.match?.players[this.room.selfId] ?? null; }
  get mySide(): Side | null { const m = this.match; return m ? playerSide(m, this.room.selfId) : null; }

  enter(): void {
    this.ctx.renderer.setScene(this.scene, this.camera);
    this.vm.initEnvironment(this.ctx.renderer.gl);
    this.ctx.renderer.setViewmodel(this.vm.scene, this.vm.camera);
    this.ctx.renderer.setMenuDof(false);
    this.ctx.renderer.gl.toneMappingExposure = 1.45;
    this.camera.fov = this.ctx.settings.graphics.fov;
    this.ctx.renderer.resize();
    this.ctx.input.wantLock = !this.ctx.mobile;
    this.ctx.touch.setMode(this.ctx.mobile ? 'arena' : 'off');
    this.ctx.audio.startAmbience('arena');
    this.vm.setLook(this.room.self?.look.jacket ?? 0x1c2230);
    const net = this.ctx.net;
    this.unsub.push(
      net.onBin(MSG.ARENA_SNAP, (from, r) => {
        if (from !== this.room.state?.hostId) return;
        const s = decodeSnapshot(r, this.snapHist);
        if (s) this.onSnapshot(s);
      }),
      net.onBin(MSG.SHOT_FX, (from, r) => { if (from === this.room.state?.hostId) this.onShotFx(decodeShotFx(r)); }),
      net.onJson(MSG.CORRECTION, (from, m) => { if (from === this.room.state?.hostId) this.mover.teleport(new THREE.Vector3(m.x, m.y, m.z)); }),
      this.room.on('event', (ev) => this.onEvent(ev)),
      this.room.on('state', (s) => this.onState(s)),
    );
    this.snapHist.clear();
    this.latestSeq = 0;
    const st = this.room.state;
    if (st) this.onState(st);
    this.syncFromState(true);
    this.equipped = '';
    this.equip(this.bestWeapon());
    const sp = this.room.state?.match;
    if (sp && this.me) { this.alive = this.me.alive; this.vm.visible = this.alive; }
  }

  exit(): void {
    this.unsub.forEach((u) => u());
    this.unsub = [];
    for (const r of this.remotes.values()) r.avatar.dispose();
    this.remotes.clear();
    this.fx.clearAreas();
    this.ctx.audio.stopAmbience();
    this.ctx.renderer.setViewmodel(null, null);
    this.ctx.renderer.gl.toneMappingExposure = 1.05;
    this.ctx.renderer.grade.uniforms.uFlash.value = 0;
    this.ctx.renderer.grade.uniforms.uDamage.value = 0;
    this.ctx.renderer.grade.uniforms.uDesat.value = 0;
  }

  // =============================================================== state sync
  private onState(s: RoomState): void {
    const m = s.match;
    if (!m) return;
    for (const p of Object.values(m.players)) {
      if (p.id === this.room.selfId) continue;
      if (!this.remotes.has(p.id) && s.players[p.id]) {
        const info = s.players[p.id];
        const avatar = new Avatar(info.look);
        avatar.setWeapon('pistol', info.finish);
        this.scene.add(avatar.root);
        this.remotes.set(p.id, { id: p.id, avatar, buf: [], alive: p.alive, stepAcc: 0, lastAnim: 0 });
      }
      const r = this.remotes.get(p.id);
      if (!r) continue;
      const mate = m.players[this.room.selfId] && p.team === m.players[this.room.selfId].team;
      const name = s.players[p.id]?.name ?? '???';
      r.avatar.setName(name, mate ? '#8aff3a' : '#ff2a5a', mate ? (m.bomb.carrier === p.id ? 'C4' : '') : '');
      r.avatar.showName(!!mate);
      if (!p.connected) r.avatar.root.visible = false;
    }
    for (const id of [...this.remotes.keys()]) if (!m.players[id]) { this.remotes.get(id)!.avatar.dispose(); this.remotes.delete(id); }
    this.phaseRemaining = m.phaseRemaining;
    this.phaseStamp = this.time;
    this.syncFromState(false);
  }

  /** Pull authoritative inventory / vitals from the match state. */
  private syncFromState(force: boolean): void {
    const me = this.me;
    if (!me) return;
    const settled = force || (this.time - this.lastShotAt > 0.6 && this.time > this.reloadEnd);
    for (const [w, a] of Object.entries(me.ammo)) if (settled || !this.ammo[w]) this.ammo[w] = [a[0], a[1]];
    this.armor = me.armor;
    if (!me.alive && this.alive && this.time - this.respawnedAt > 2) this.die(null);
    if (!this.owns(this.equipped)) this.equip(this.bestWeapon());
  }

  private owns(item: string): boolean {
    const me = this.me;
    if (!me || !me.alive) return false;
    if (item === 'knife') return true;
    if (item === 'c4') return this.match?.bomb.carrier === me.id;
    if (item === 'smoke' || item === 'flash' || item === 'molotov') return me.grenades.includes(item);
    return me.primary === item || me.secondary === item;
  }
  private bestWeapon(): string { const me = this.me; return me?.primary ?? me?.secondary ?? 'knife'; }

  equip(item: string): void {
    if (item === this.equipped && this.vm) return;
    if (!this.owns(item)) return;
    this.lastWeapon = this.equipped !== item && !['smoke', 'flash', 'molotov', 'c4'].includes(this.equipped) ? this.equipped : this.lastWeapon;
    this.equipped = item;
    this.reloadEnd = 0;
    this.vm.cancelReload();
    this.drawEnd = this.time + 0.45;
    this.ads = false;
    this.vm.setWeapon(MODEL_OF(item), this.room.self?.finish ?? 'stock');
    this.cancelAction();
  }

  // =============================================================== network in
  private onSnapshot(s: Snapshot): void {
    this.snapHist.set(s.seq, s);
    if (this.snapHist.size > 64) this.snapHist.delete(this.snapHist.keys().next().value!);
    if (this.latestSeq && !seqNewer(s.seq, this.latestSeq)) return;
    this.latestSeq = s.seq;
    this.phaseRemaining = s.phaseRemaining;
    this.phaseStamp = this.time;
    this.actionProgress = s.actionProgress;
    const st = this.room.state;
    if (!st) return;
    const byOrder = new Map(Object.values(st.players).map((p) => [p.joinOrder, p.id]));
    const now = performance.now() / 1000;
    for (const np of s.players.values()) {
      const id = byOrder.get(np.order);
      if (!id) continue;
      if (id === this.room.selfId) { this.hp = np.hp; this.armor = np.armor; continue; }
      const r = this.remotes.get(id);
      if (!r) continue;
      r.buf.push({ t: now, p: { ...np } });
      if (r.buf.length > 40) r.buf.shift();
    }
    // grenades in flight
    const seen = new Set<number>();
    for (const pr of s.projectiles) {
      seen.add(pr.id);
      let m = this.projMeshes.get(pr.id);
      if (!m) {
        m = Assets.weapon(['smoke', 'flash', 'molotov'][pr.type] ?? 'smoke');
        m.scale.setScalar(1.4);
        this.scene.add(m);
        this.projMeshes.set(pr.id, m);
      }
      m.position.set(pr.x, pr.y, pr.z);
      m.rotation.x += 0.4;
    }
    for (const [id, m] of this.projMeshes) if (!seen.has(id)) { m.removeFromParent(); this.projMeshes.delete(id); }
  }

  private onShotFx(s: ShotFx): void {
    const origin = new THREE.Vector3(s.ox, s.oy, s.oz);
    const item = itemFromCode(s.item);
    const w = WEAPONS[item as WeaponId];
    this.ctx.audio.gunshot(w?.cls ?? 'rifle', origin);
    // muzzle at the shooter's avatar
    const shooterId = Object.values(this.room.state?.players ?? {}).find((p) => p.joinOrder === s.order)?.id;
    const r = shooterId ? this.remotes.get(shooterId) : undefined;
    let muzzle = origin.clone();
    if (r) {
      const fwd = new THREE.Vector3(-Math.sin(r.avatar.yaw), 0, -Math.cos(r.avatar.yaw));
      muzzle = r.avatar.root.position.clone().add(new THREE.Vector3(0, 1.45, 0)).addScaledVector(fwd, 0.7);
      this.fx.muzzle(muzzle, fwd, w?.cls === 'shotgun' ? 1.4 : 1);
    }
    for (const h of s.hits.slice(0, 3)) {
      const p = new THREE.Vector3(h.x, h.y, h.z);
      if (w?.cls !== 'melee') this.fx.tracer(muzzle, p);
      if (h.kind === 0) {
        const n = origin.clone().sub(p).normalize();
        this.fx.impact(p, n, 'world');
        this.ctx.audio.impact(p, 'concrete');
      } else if (h.kind === 1) {
        this.fx.impact(p, origin.clone().sub(p).normalize(), 'flesh');
      }
    }
  }

  private name(id: string | null): string { return (id && this.room.state?.players[id]?.name) || (id ? 'Disconnected' : 'World'); }

  private onEvent(ev: GameEvent): void {
    const self = this.room.selfId;
    switch (ev.e) {
      case 'localSnap': this.onSnapshot(ev.snap as Snapshot); break;
      case 'shotfx': this.onShotFx(ev as unknown as ShotFx); break;
      case 'correction': this.mover.teleport(new THREE.Vector3(ev.x, ev.y, ev.z)); break;
      case 'roundStart': {
        const sp = ev.spawns[self];
        this.fx.clearAreas();
        this.killfeed = [];
        for (const m of this.projMeshes.values()) m.removeFromParent();
        this.projMeshes.clear();
        if (sp) {
          this.alive = true;
          this.respawnedAt = this.time;
          this.hp = 100;
          this.spectateId = null;
          this.mover.teleport(new THREE.Vector3(sp[0], sp[1], sp[2]), sp[3]);
          this.mover.pitch = 0;
          this.vm.visible = true;
          this.recoil.set(0, 0);
          this.syncFromState(true);
          this.equipped = '';
          this.equip(this.bestWeapon());
        }
        for (const r of this.remotes.values()) { r.alive = true; r.buf = []; }
        this.ctx.audio.roundStart();
        const m = this.match;
        const side = this.mySide;
        this.centerMsg = { text: ev.restart ? 'ROUND RESTARTED' : `ROUND ${ev.round}`, sub: side === 'ATK' ? 'ATTACK — plant the C4 at A or B' : side === 'DEF' ? 'DEFEND — stop the plant, defuse the C4' : 'SPECTATING', until: this.time + 3, color: side === 'ATK' ? '#ffa31a' : '#00e5ff' };
        void m;
        break;
      }
      case 'live': this.centerMsg = { text: 'GO GO GO', until: this.time + 1.2, color: '#8aff3a' }; break;
      case 'kill': {
        const m = this.match;
        const ks = ev.killer && m ? playerSide(m, ev.killer) : null;
        const vs = m ? playerSide(m, ev.victim) : null;
        this.killfeed.unshift({ killer: this.name(ev.killer), victim: this.name(ev.victim), weapon: ev.weapon, head: ev.head, t: this.time, mine: ev.killer === self || ev.victim === self, killerSide: ks, victimSide: vs });
        if (this.killfeed.length > 6) this.killfeed.pop();
        if (ev.victim === self) this.die(ev.killer);
        else {
          const r = this.remotes.get(ev.victim);
          if (r) { r.alive = false; r.avatar.play('die', 0.1); }
          if (this.spectateId === ev.victim) this.nextSpectate();
        }
        if (ev.killer === self && ev.victim !== self) this.ctx.audio.killConfirm();
        break;
      }
      case 'hit': {
        this.hitmarker = 0.25;
        this.hitmarkerHead = !!ev.head;
        this.ctx.audio.hitmarker(!!ev.head);
        const r = this.remotes.get(ev.victim);
        if (r) this.fx.impact(r.avatar.root.position.clone().add(new THREE.Vector3(0, ev.head ? 1.6 : 1.1, 0)), this.camera.position.clone().sub(r.avatar.root.position).normalize(), 'flesh');
        break;
      }
      case 'damaged': {
        this.damageFlash = Math.min(1, this.damageFlash + ev.dmg / 60);
        this.ctx.audio.hurt();
        if (ev.fx) {
          const d = new THREE.Vector3(ev.fx[0], ev.fx[1], ev.fx[2]).sub(this.mover.feet);
          this.damageDir = Math.atan2(-d.x, -d.z) - this.mover.yaw;
          this.damageDirUntil = this.time + 1.2;
        }
        this.recoil.x += 0.02; // aim punch
        break;
      }
      case 'reloadStart': break;
      case 'bombDropped': this.ctx.audio.ui('notify'); break;
      case 'bombPicked': if (ev.player === self) { this.centerMsg = { text: 'YOU HAVE THE C4', sub: 'Press 5 to equip, hold FIRE / E on a site to plant', until: this.time + 3, color: '#ffa31a' }; } break;
      case 'actionStart':
        if (ev.player === self) { this.actionStartedAt = this.time; this.actionDuration = ev.kind === 'plant' ? MATCH_RULES.plantTime : ev.kit ? MATCH_RULES.defuseTimeKit : MATCH_RULES.defuseTime; }
        if (ev.kind === 'defuse') this.ctx.audio.defuseTick(new THREE.Vector3(...this.match!.bomb.pos));
        break;
      case 'actionCancel': if (ev.player === self) this.actionHeld = null; break;
      case 'planted': {
        this.plantedAt = this.time;
        this.ctx.audio.c4Armed(new THREE.Vector3(...(ev.pos as [number, number, number])));
        this.centerMsg = { text: 'BOMB PLANTED', sub: `Site ${ev.site} — ${MATCH_RULES.bombTimer} seconds`, until: this.time + 3, color: '#ff2a3a' };
        if (ev.player === self) { this.actionHeld = null; this.equip(this.bestWeapon()); }
        break;
      }
      case 'defused': this.ctx.audio.defused(); this.actionHeld = null; break;
      case 'exploded': {
        const p = new THREE.Vector3(...(ev.pos as [number, number, number]));
        this.fx.explosion(p, 2.2);
        this.ctx.audio.explosion(p, true);
        this.bombMesh.visible = false;
        break;
      }
      case 'roundEnd': {
        const m = this.match;
        const myTeam = m?.players[self]?.team;
        const win = ev.winner === myTeam;
        this.ctx.audio.roundEnd(win);
        const label = ev.winnerSide === 'ATK' ? 'ATTACKERS WIN' : 'DEFENDERS WIN';
        this.centerMsg = { text: label, sub: ev.reason, until: this.time + 5, color: win ? '#8aff3a' : '#ff2a3a' };
        this.cancelAction();
        break;
      }
      case 'halftime': this.centerMsg = { text: 'HALFTIME', sub: 'Teams switch sides. Money resets.', until: this.time + 6, color: '#00e5ff' }; break;
      case 'matchOver': {
        const myTeam = this.me?.team;
        const txt = ev.winner === 'draw' ? 'DRAW' : ev.winner === myTeam ? 'VICTORY' : 'DEFEAT';
        this.centerMsg = { text: txt, sub: `${ev.score.alpha} : ${ev.score.bravo}  —  returning to NEON CITY`, until: this.time + 12, color: txt === 'VICTORY' ? '#8aff3a' : txt === 'DEFEAT' ? '#ff2a3a' : '#00e5ff' };
        this.scoreboardOpen = true;
        break;
      }
      case 'throw': this.ctx.audio.throwWhoosh(); break;
      case 'bounce': this.ctx.audio.bounce(new THREE.Vector3(...(ev.pos as [number, number, number]))); break;
      case 'nade': this.onNade(ev); break;
      case 'extinguish': this.fx.extinguish(new THREE.Vector3(...(ev.pos as [number, number, number]))); this.ctx.audio.smokeHiss(new THREE.Vector3(...(ev.pos as [number, number, number]))); break;
      case 'resync': this.snapHist.clear(); this.latestSeq = 0; break;
    }
  }

  private onNade(ev: GameEvent): void {
    const p = new THREE.Vector3(...(ev.pos as [number, number, number]));
    if (ev.type === 'smoke') { this.fx.smokeArea(p, ev.duration); this.ctx.audio.smokeHiss(p); }
    else if (ev.type === 'molotov') { this.fx.fireArea(p, ev.duration); this.ctx.audio.fire(p, ev.duration); }
    else {
      this.fx.flashPop(p);
      this.ctx.audio.flashbang(p);
      if (!this.alive) return;
      const eye = this.camera.position.clone();
      const d = p.clone().sub(eye);
      const dist = d.length();
      if (dist > 30 || !this.physics.visible(eye, p, this.mover.body.collider)) return;
      const fwd = new THREE.Vector3();
      this.camera.getWorldDirection(fwd);
      const facing = fwd.dot(d.normalize());
      const k = (facing > 0.5 ? 1 : facing > -0.2 ? 0.55 : 0.2) * (1 - dist / 30);
      const dur = 0.4 + k * 4.5;
      this.flash = Math.max(this.flash, dur);
      if (k > 0.5) this.ctx.audio.tinnitus(dur * 0.8);
    }
  }

  private die(killer: string | null): void {
    if (!this.alive) return;
    this.alive = false;
    this.deathAt = this.time;
    this.vm.visible = false;
    this.ads = false;
    this.cancelAction();
    this.spectateId = killer && killer !== this.room.selfId ? killer : null;
  }

  private nextSpectate(): void {
    const m = this.match;
    if (!m) return;
    const myTeam = m.players[this.room.selfId]?.team;
    const ids = [...this.remotes.values()].filter((r) => r.alive && m.players[r.id]?.alive && (!myTeam || m.players[r.id].team === myTeam || this.time - this.deathAt < 3)).map((r) => r.id);
    if (!ids.length) { this.spectateId = null; return; }
    const i = this.spectateId ? ids.indexOf(this.spectateId) : -1;
    this.spectateId = ids[(i + 1) % ids.length];
  }

  // =============================================================== actions (plant/defuse)
  private async beginAction(kind: 'plant' | 'defuse'): Promise<void> {
    if (this.actionHeld) return;
    this.actionHeld = kind;
    const r = await this.room.request(kind === 'plant' ? 'plant.start' : 'defuse.start');
    if (!r.ok) { this.actionHeld = null; this.ctx.toast(r.msg ?? 'Not possible', 'warn'); }
  }
  private cancelAction(): void {
    if (!this.actionHeld) return;
    this.actionHeld = null;
    this.room.notify('action.cancel');
  }

  // =============================================================== frame
  update(dt: number): void {
    this.time += dt;
    const input = this.ctx.input;
    const m = this.match;
    if (!m) return;
    const phase = m.phase;
    const frozen = phase === 'freeze' || !!this.actionHeld || phase === 'halftime' || phase === 'ended';
    this.phaseRemaining = Math.max(0, this.phaseRemaining - dt);
    const me = this.me;
    // fallback only (kill events are authoritative); ignore stale state right after a respawn
    if (me && !me.alive && this.alive && this.time - this.respawnedAt > 2) this.die(null);

    // ---- look (with recoil recovery)
    if (this.alive) {
      const sens = this.ads ? (this.equipped === 'longbow' ? 0.3 : 0.7) : 1;
      const l = input.consumeLook();
      this.mover.yaw -= l.dx * sens;
      this.mover.pitch = THREE.MathUtils.clamp(this.mover.pitch - l.dy * sens, -1.5, 1.5);
      const firing = input.isHeld('fire') && this.time - this.lastShotAt < 0.15;
      if (!firing) this.recoil.multiplyScalar(Math.max(0, 1 - dt * 6));
      this.bloom = Math.max(0, this.bloom - dt * 3);
      this.mover.update(dt, input, { speed: RUN_SPEED * (WEAPONS[this.equipped as WeaponId]?.speedMult ?? 1), walkMult: 0.52, crouchMult: 0.36, frozen, faceMovement: false });
      this.physics.step();
      // landing / footsteps
      if (this.mover.grounded && this.mover.speedNow > 3.5) {
        this.stepAcc += dt * this.mover.speedNow;
        if (this.stepAcc > 2.0) {
          this.stepAcc = 0;
          const wet = this.puddleAt(this.mover.feet) > 0.35;
          this.ctx.audio.footstep(undefined, wet, 0.45);
          if (wet) this.env.rain.splash(this.mover.feet, 0.7);
        }
      }
      this.handleWeapons(dt);
      this.handleInteract();
    } else {
      input.consumeLook();
      if (input.pressed('fire') && this.time - this.deathAt > 1) this.nextSpectate();
      if (!this.spectateId && this.time - this.deathAt > 2.5) this.nextSpectate();
    }
    if (input.pressed('buy')) this.onBuyToggle();
    this.scoreboardOpen = input.isHeld('scoreboard') || m.phase === 'ended';

    // ---- camera
    const eyeH = this.mover.crouching ? 1.08 : 1.62;
    if (this.alive) {
      this.camera.position.copy(this.mover.feet).add(new THREE.Vector3(0, eyeH, 0));
      const shake = this.fx.shake;
      this.camera.rotation.set(this.mover.pitch + this.recoil.x + (Math.random() - 0.5) * shake * 0.02, this.mover.yaw + this.recoil.y + (Math.random() - 0.5) * shake * 0.02, 0, 'YXZ');
    } else this.updateSpectateCamera(dt);
    const wdef = WEAPONS[this.equipped as WeaponId];
    const targetFov = this.ads && wdef && this.alive ? wdef.adsFov : this.ctx.settings.graphics.fov;
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, Math.min(1, dt * 14));
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();

    // ---- viewmodel
    this.vm.ads = THREE.MathUtils.lerp(this.vm.ads, this.ads ? 1 : 0, Math.min(1, dt * 12));
    this.vm.visible = this.alive && !(this.ads && this.equipped === 'longbow' && this.vm.ads > 0.8);
    this.vm.update(dt, this.mover.speedNow, { dx: 0, dy: 0 }, this.mover.grounded, this.mover.crouching);

    // ---- network out (30 Hz)
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / 30) {
      this.sendAcc = 0;
      const f = this.mover.feet;
      let anim: number = ANIM[this.mover.animName()];
      if (this.actionHeld) anim = ANIM.plant;
      if (!this.alive) anim = ANIM.die;
      const flags = (this.mover.crouching ? IN_CROUCH : 0) | (this.mover.walking ? IN_WALK : 0) | (!this.mover.grounded ? IN_AIR : 0) | (this.ads ? IN_ADS : 0);
      this.inputSeq = (this.inputSeq + 1) & 0xffff;
      this.sendInput({ seq: this.inputSeq, ack: this.latestSeq, x: f.x, y: f.y, z: f.z, yaw: this.mover.yaw, pitch: this.mover.pitch, flags, item: itemCode(this.equipped || 'knife'), anim });
    }

    this.updateRemotes(dt);
    this.updateBomb(dt);
    this.fx.update(dt);
    this.env.update(dt, this.camera, this.alive ? this.mover.feet : this.camera.position);
    this.ctx.audio.setOutdoor(ARENA_SHELTERS.some((s) => this.camera.position.x > s.min.x && this.camera.position.x < s.max.x && this.camera.position.z > s.min.z && this.camera.position.z < s.max.z && this.camera.position.y < s.max.y) ? 0 : 1);
    // ---- screen effects
    this.flash = Math.max(0, this.flash - dt);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.5);
    this.hitmarker = Math.max(0, this.hitmarker - dt);
    const g = this.ctx.renderer.grade.uniforms;
    g.uFlash.value = Math.min(1, this.flash * 0.9);
    g.uDamage.value = this.damageFlash * 0.7 + (this.alive && this.hp < 30 ? 0.25 + Math.sin(this.time * 4) * 0.08 : 0);
    g.uDesat.value = this.alive ? 0 : 0.65;
  }

  private puddleAt(p: THREE.Vector3): number {
    if (!this.puddle || p.y > 0.2) return 0;
    const s = this.puddleSize;
    const u = (((p.x / 22) % 1) + 1) % 1, v = (((p.z / 22) % 1) + 1) % 1;
    return this.puddle[(Math.floor(v * s) * s + Math.floor(u * s)) * 4] / 255;
  }

  private updateSpectateCamera(dt: number): void {
    const r = this.spectateId ? this.remotes.get(this.spectateId) : undefined;
    if (r && r.buf.length) {
      const last = r.buf[r.buf.length - 1].p;
      const pos = r.avatar.root.position;
      const eye = pos.clone().add(new THREE.Vector3(0, last.flags & IN_CROUCH ? 1.08 : 1.62, 0));
      const back = new THREE.Vector3(Math.sin(last.yaw), 0.35, Math.cos(last.yaw)).multiplyScalar(2.4);
      const want = eye.clone().add(back);
      const hit = this.physics.raycast(eye, back.clone().normalize(), back.length());
      if (hit) want.copy(eye).addScaledVector(back.normalize(), Math.max(0.3, hit.distance - 0.2));
      this.camera.position.lerp(want, Math.min(1, dt * 8));
      this.camera.lookAt(eye.clone().add(new THREE.Vector3(-Math.sin(last.yaw), Math.sin(last.pitch), -Math.cos(last.yaw)).multiplyScalar(4)));
    } else {
      // death cam: rise above the body
      const k = Math.min(1, (this.time - this.deathAt) / 1.5);
      const target = this.mover.feet.clone().add(new THREE.Vector3(0, 1 + k * 4, 0));
      this.camera.position.lerp(target.clone().add(new THREE.Vector3(2.5 * k, 0, 2.5 * k)), Math.min(1, dt * 3));
      this.camera.lookAt(this.mover.feet);
    }
  }

  private updateRemotes(dt: number): void {
    const renderT = performance.now() / 1000 - INTERP;
    const m = this.match;
    for (const r of this.remotes.values()) {
      const b = r.buf;
      if (!b.length) { r.avatar.root.visible = false; continue; }
      r.avatar.root.visible = !!m?.players[r.id]?.connected;
      let a = b[0], c = b[b.length - 1];
      for (let i = b.length - 1; i > 0; i--) if (b[i - 1].t <= renderT) { a = b[i - 1]; c = b[i]; break; }
      const span = Math.max(1e-3, c.t - a.t);
      let k = (renderT - a.t) / span;
      const lerpAng = (x: number, y: number, t: number) => x + Math.atan2(Math.sin(y - x), Math.cos(y - x)) * t;
      let yaw: number;
      if (k <= 1) {
        k = Math.max(0, k);
        r.avatar.root.position.set(a.p.x + (c.p.x - a.p.x) * k, a.p.y + (c.p.y - a.p.y) * k, a.p.z + (c.p.z - a.p.z) * k);
        yaw = lerpAng(a.p.yaw, c.p.yaw, k);
      } else {
        const ex = Math.min(k - 1, 0.2 / span); // extrapolate at most 200 ms
        r.avatar.root.position.set(c.p.x + (c.p.x - a.p.x) * ex, c.p.y + (c.p.y - a.p.y) * ex, c.p.z + (c.p.z - a.p.z) * ex);
        yaw = c.p.yaw;
      }
      r.avatar.setYaw(yaw);
      r.avatar.setVelocity((c.p.x - a.p.x) / span, (c.p.z - a.p.z) / span);
      const alive = c.p.alive === 1 && r.alive;
      const item = itemFromCode(c.p.item);
      const finish = this.room.state?.players[r.id]?.finish ?? 'stock';
      r.avatar.setWeapon(alive ? MODEL_OF(item) : null, finish);
      if (!alive) r.avatar.play('die', 0.1);
      else r.avatar.playCode(c.p.anim);
      r.avatar.update(dt);
      // audible running footsteps (walking with SHIFT and crouching are silent)
      if (alive && c.p.anim === ANIM.run && !(c.p.flags & IN_AIR)) {
        r.stepAcc += dt;
        if (r.stepAcc > 0.36) { r.stepAcc = 0; this.ctx.audio.footstep(r.avatar.root.position, this.puddleAt(r.avatar.root.position) > 0.35, 1); }
      }
      if (c.p.anim === ANIM.jump && r.lastAnim !== ANIM.jump) this.ctx.audio.footstep(r.avatar.root.position, false, 0.6);
      r.lastAnim = c.p.anim;
    }
  }

  private updateBomb(dt: number): void {
    const m = this.match;
    if (!m) return;
    const b = m.bomb;
    const vis = b.state === 'dropped' || b.state === 'planted' || b.state === 'defused';
    this.bombMesh.visible = vis;
    if (vis) this.bombMesh.position.set(b.pos[0], b.pos[1] + 0.02, b.pos[2]);
    if (b.state === 'planted' && m.phase === 'planted') {
      const left = this.phaseRemaining;
      const interval = THREE.MathUtils.clamp(left / MATCH_RULES.bombTimer, 0.08, 1) * 1.0;
      this.beepAcc -= dt;
      if (this.beepAcc <= 0) {
        this.beepAcc = interval;
        this.ctx.audio.c4Beep(this.bombMesh.position);
        this.bombLight.intensity = 6;
      }
      this.bombLight.intensity = Math.max(0, this.bombLight.intensity - dt * 30);
    } else this.bombLight.intensity = 0;
  }

  // =============================================================== weapons
  private handleWeapons(dt: number): void {
    const input = this.ctx.input;
    const m = this.match!;
    const me = this.me;
    if (!me) return;
    // slot selection
    if (input.pressed('slot1') && me.primary) this.equip(me.primary);
    if (input.pressed('slot2') && me.secondary) this.equip(me.secondary);
    if (input.pressed('slot3')) this.equip('knife');
    if (input.pressed('slot4') && me.grenades.length) {
      const order: GrenadeId[] = ['flash', 'smoke', 'molotov'];
      const owned = order.filter((g) => me.grenades.includes(g));
      const i = owned.indexOf(this.equipped as GrenadeId);
      this.equip(owned[(i + 1) % owned.length]);
    }
    if (input.pressed('slot5') && m.bomb.carrier === me.id) this.equip('c4');
    this.ctx.touch.setGrenadeAvailable(me.grenades.length > 0);
    if (input.pressed('nextWeapon') || input.pressed('prevWeapon')) {
      const cycle = [me.primary, me.secondary, 'knife', ...me.grenades, m.bomb.carrier === me.id ? 'c4' : null].filter(Boolean) as string[];
      const i = cycle.indexOf(this.equipped);
      this.equip(cycle[(i + 1) % cycle.length]);
    }
    if (input.pressed('drop') && m.bomb.carrier === me.id) this.room.request('bomb.drop').then((r) => { if (r.ok) this.equip(this.bestWeapon()); });
    if (!this.owns(this.equipped)) this.equip(this.bestWeapon());

    const item = this.equipped;
    const w = WEAPONS[item as WeaponId];
    this.ads = !!w && w.cls !== 'melee' && input.isHeld('aim') && this.time > this.reloadEnd;
    const canShoot = m.phase !== 'freeze' && m.phase !== 'halftime' && m.phase !== 'ended' && this.time >= this.drawEnd;

    // reload
    // read the trigger edge exactly once per frame (pressed() consumes it)
    const trigger = input.pressed('fire');
    if (w && w.cls !== 'melee' && (input.pressed('reload') || (trigger && (this.ammo[item]?.[0] ?? 0) === 0))) this.tryReload(w);
    if (this.reloadEnd && this.time >= this.reloadEnd) {
      this.reloadEnd = 0;
      const a = this.ammo[item];
      if (a && w) { const take = Math.min(w.magazine - a[0], a[1]); a[0] += take; a[1] -= take; }
    }

    // grenades
    if (item === 'smoke' || item === 'flash' || item === 'molotov') {
      if (trigger && canShoot) this.throwGrenade(item);
      return;
    }
    // C4
    if (item === 'c4') {
      const onSite = (['A', 'B'] as const).some((k) => inZone(SITES[k], this.mover.feet));
      const hold = input.isHeld('fire') || input.isHeld('interact');
      if (hold && onSite && m.phase === 'live' && !this.actionHeld) this.beginAction('plant');
      if (!hold && this.actionHeld === 'plant') this.cancelAction();
      return;
    }
    if (!w || !canShoot) return;
    const semi = !w.auto;
    const firePressed = semi ? trigger : input.isHeld('fire');
    if (!input.isHeld('fire')) this.triggerReleased = true;
    if (!firePressed || this.time < this.nextFire || this.reloadEnd) return;
    if (w.cls !== 'melee') {
      const a = this.ammo[item];
      if (!a || a[0] <= 0) { this.ctx.audio.dryFire(); this.nextFire = this.time + 0.25; return; }
      a[0]--;
    }
    this.triggerReleased = false;
    this.nextFire = this.time + 60 / w.rpm;
    this.lastShotAt = this.time;
    this.shoot(w);
  }

  private tryReload(w: (typeof WEAPONS)[WeaponId]): void {
    const a = this.ammo[w.id];
    if (!a || a[0] >= w.magazine || a[1] <= 0 || this.reloadEnd) return;
    this.reloadEnd = this.time + w.reloadTime;
    this.vm.reload(w.reloadTime);
    this.room.notify('reload');
    this.ctx.audio.reload(0);
    setTimeout(() => this.ctx.audio.reload(1), w.reloadTime * 450);
    setTimeout(() => this.ctx.audio.reload(2), w.reloadTime * 900);
  }

  private shoot(w: (typeof WEAPONS)[WeaponId]): void {
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const origin = this.camera.position.clone();
    const moveK = Math.min(1, this.mover.speedNow / 5);
    let spread = w.spread + w.moveSpread * moveK + (this.mover.grounded ? 0 : 0.08) + this.bloom * w.spread * 4;
    if (this.mover.crouching) spread *= 0.75;
    if (this.ads) spread *= w.adsSpread;
    if (w.cls === 'sniper' && !this.ads) spread += 0.06;
    const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const dirs: [number, number, number][] = [];
    for (let i = 0; i < w.pellets; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
      const d = fwd.clone().addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
      dirs.push([d.x, d.y, d.z]);
    }
    this.shotSeq = (this.shotSeq + 1) & 0xffff;
    this.sendFire({ shot: this.shotSeq, item: itemCode(w.id), ox: origin.x, oy: origin.y, oz: origin.z, dirs });
    // local feedback
    this.bloom = Math.min(3, this.bloom + 0.6);
    this.recoil.x += w.recoil * (this.ads ? 0.7 : 1) * (this.mover.crouching ? 0.8 : 1);
    this.recoil.y += (Math.random() - 0.5) * w.recoilYaw * 2;
    this.recoil.x = Math.min(this.recoil.x, 0.25);
    this.ctx.audio.gunshot(w.cls);
    if (w.cls === 'melee') { this.vm.swing(); return; }
    this.vm.fire(w.cls === 'shotgun' || w.cls === 'sniper' ? 1.2 : 0.5);
    const muzzle = this.vm.muzzleWorld(this.camera);
    this.fx.muzzle(muzzle, fwd, w.cls === 'shotgun' ? 1.4 : 1);
    for (const d of dirs.slice(0, 4)) {
      const dir = new THREE.Vector3(...d);
      const hit = this.physics.raycast(origin, dir, 200, this.mover.body.collider);
      const end = hit ? hit.point : origin.clone().addScaledVector(dir, 200);
      // only show world impacts if no remote player is closer along the ray
      let blocked = false;
      for (const r of this.remotes.values()) {
        if (!r.alive) continue;
        const c = r.avatar.root.position.clone().add(new THREE.Vector3(0, 1.1, 0));
        const t = c.clone().sub(origin).dot(dir);
        if (t > 0 && t < (hit?.distance ?? 200) && origin.clone().addScaledVector(dir, t).distanceTo(c) < 0.5) { blocked = true; break; }
      }
      this.fx.tracer(muzzle, end);
      if (hit && !blocked) {
        this.fx.impact(hit.point, hit.normal, 'world');
        if (hit.point.y < 0.05 && this.puddleAt(hit.point) > 0.35) this.env.rain.splash(hit.point, 0.6);
      }
    }
  }

  private throwGrenade(type: GrenadeId): void {
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const o = this.camera.position.clone().addScaledVector(fwd, 0.4);
    const v = fwd.clone().multiplyScalar(this.ads ? 9 : 16).add(new THREE.Vector3(0, 2.5, 0)).add(this.mover.vel.clone().setY(0));
    this.vm.throwAnim();
    this.room.request('throw', { type, ox: o.x, oy: o.y, oz: o.z, vx: v.x, vy: v.y, vz: v.z }).then((r) => {
      if (!r.ok) this.ctx.toast(r.msg ?? 'Throw failed', 'warn');
    });
    this.drawEnd = this.time + 0.6;
    setTimeout(() => { if (!this.owns(this.equipped)) this.equip(this.lastWeapon && this.owns(this.lastWeapon) ? this.lastWeapon : this.bestWeapon()); }, 450);
  }

  private handleInteract(): void {
    const m = this.match!;
    const me = this.me!;
    const side = this.mySide;
    this.prompt = null;
    const bombPos = new THREE.Vector3(...m.bomb.pos);
    if (side === 'DEF' && m.bomb.state === 'planted' && bombPos.distanceTo(this.mover.feet) < 1.8) {
      this.prompt = this.actionHeld === 'defuse' ? 'DEFUSING…' : `Hold E to DEFUSE${me.kit ? ' (kit)' : ''}`;
      const hold = this.ctx.input.isHeld('interact');
      if (hold && !this.actionHeld) this.beginAction('defuse');
      if (!hold && this.actionHeld === 'defuse') this.cancelAction();
    } else if (m.bomb.carrier === me.id && (['A', 'B'] as const).some((k) => inZone(SITES[k], this.mover.feet)) && m.phase === 'live') {
      this.prompt = this.equipped === 'c4' ? (this.actionHeld ? 'PLANTING…' : 'Hold FIRE or E to PLANT') : 'Press 5 to equip the C4';
      if (this.equipped !== 'c4' && this.ctx.input.pressed('interact')) this.equip('c4');
    } else if (side === 'ATK' && m.bomb.state === 'dropped' && bombPos.distanceTo(this.mover.feet) < 3) {
      this.prompt = 'Walk over the C4 to pick it up';
    }
    this.ctx.touch.setUseLabel(this.prompt ? (this.prompt.includes('DEFUSE') ? 'DEFUSE' : this.prompt.includes('PLANT') ? 'PLANT' : null) : null);
  }

  // =============================================================== HUD accessors
  get inBuyZone(): boolean { const s = this.mySide; return !!s && inZone(BUY_ZONES[s], this.mover.feet); }
  get buyTimeLeft(): number {
    const m = this.match;
    if (!m) return 0;
    if (m.phase === 'freeze') return this.phaseRemaining + MATCH_RULES.buyWindow;
    if (m.phase === 'live') return Math.max(0, MATCH_RULES.buyWindow - (MATCH_RULES.roundTime - this.phaseRemaining));
    return 0;
  }
  setRain(on: boolean): void { this.env?.setRain(on); }
  get position(): THREE.Vector3 { return this.mover.feet; }
  get clock(): number { return this.time; }
  get moveSpeed(): number { return this.mover.speedNow; }
  get yaw(): number { return this.mover.yaw; }
  get actionActive(): 'plant' | 'defuse' | null { return this.actionHeld; }
  teammatePositions(): { id: string; pos: THREE.Vector3; alive: boolean; yaw: number }[] {
    const m = this.match;
    const myTeam = m?.players[this.room.selfId]?.team;
    return [...this.remotes.values()].filter((r) => m?.players[r.id]?.team === myTeam && r.buf.length).map((r) => ({ id: r.id, pos: r.avatar.root.position, alive: r.alive, yaw: r.avatar.yaw }));
  }
  get spectatingName(): string | null { return this.spectateId ? this.name(this.spectateId) : null; }
  sideOfTeam(team: 'alpha' | 'bravo'): Side | null { const m = this.match; return m ? sideOf(m, team) : null; }
}
