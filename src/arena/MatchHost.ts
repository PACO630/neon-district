// Host-authoritative match simulation for TACTICAL ARENA (C4 bomb defusal).
// Runs only on the current host (even if the host is idling in the city). It validates client
// movement and fire events, performs lag-compensated hit detection, owns money / purchases / bomb /
// rounds, simulates grenades in its own Rapier world, and streams delta-compressed snapshots.
// NOTE: a player-hosted authority is not anti-cheat; it only rejects obviously invalid input.
import * as THREE from 'three';
import { ECONOMY, MATCH_RULES } from '../config/economy';
import { GEAR, WEAPONS, type GearId, type GrenadeId, type WeaponId } from '../config/weapons';
import { testHitbox, type HitPart } from '../combat/hitTest';
import { Physics } from '../physics/Physics';
import {
  decodeArenaInput, decodeFire, encodeShotFx, encodeSnapshot, IN_CROUCH, itemCode, itemFromCode, MSG, seqNewer,
  type ArenaInput, type FireMsg, type NetPlayer, type Snapshot,
} from '../networking/protocol';
import type { Room, ReqResult } from '../room/Room';
import { sideOf, teamOnSide, type MatchPlayer, type MatchState, type Side, type TeamKey } from '../room/RoomState';
import { addSector09Colliders, BUY_ZONES, inZone, SITES, SPAWNS } from './Sector09';

interface PState {
  feet: THREE.Vector3; yaw: number; pitch: number; flags: number; item: number; anim: number;
  lastInput: number; lastSeq: number; ack: number;
  hist: { t: number; feet: THREE.Vector3; crouch: boolean }[];
}
interface Projectile { id: number; type: GrenadeId; body: import('@dimforge/rapier3d-compat').RigidBody; owner: string; born: number; fuse: number; lastVel: number; bounced: number }
interface Area { pos: THREE.Vector3; until: number; owner: string; radius: number }

const TICK = 1 / 30;
/** Base run speed (m/s); shared with the client controller so validation matches movement. */
export const RUN_SPEED = 6.6;
const ok = (msg?: string, data?: any): ReqResult => ({ ok: true, msg, data });
const fail = (msg: string): ReqResult => ({ ok: false, msg });
const NADE_CODE: Record<GrenadeId, number> = { smoke: 0, flash: 1, molotov: 2 };

export class MatchHost {
  private physics = new Physics();
  private ps = new Map<string, PState>();
  private timer = 0;
  private now = 0;
  private phaseEnds = 0;
  private liveStartedAt = 0;
  private snapSeq = 1;
  private snapAcc = 0;
  private sentSnaps = new Map<string, Map<number, Snapshot>>();
  private lastShot = new Map<string, number>();
  private reloadUntil = new Map<string, { until: number; weapon: string }>();
  private projectiles: Projectile[] = [];
  private nextProj = 1;
  private fires: Area[] = [];
  private smokes: Area[] = [];
  private fireTick = 0;
  private action: { player: string; kind: 'plant' | 'defuse'; start: number; pos: THREE.Vector3; dur: number } | null = null;
  private dmgLog = new Map<string, Map<string, number>>(); // victim -> attacker -> damage this round
  private commitAcc = 0;
  private unsub: (() => void)[] = [];
  private bombPlantedAt = 0;
  private beepAcc = 0;
  disposed = false;

  constructor(private room: Room) {
    addSector09Colliders(this.physics);
    const r = room;
    this.unsub.push(
      r.registerHandler('buy', (from, a) => this.buy(from, a.item)),
      r.registerHandler('reload', (from) => this.reload(from)),
      r.registerHandler('plant.start', (from) => this.startAction(from, 'plant')),
      r.registerHandler('defuse.start', (from) => this.startAction(from, 'defuse')),
      r.registerHandler('action.cancel', (from) => { if (this.action?.player === from) this.cancelAction(); return ok(); }),
      r.registerHandler('bomb.drop', (from) => this.dropBomb(from)),
      r.registerHandler('throw', (from, a) => this.throwNade(from, a)),
      r.registerHandler('match.abort', (from) => (from === r.state?.hostId ? (this.endMatch('Host ended the match.'), ok()) : fail('Host only.'))),
      r.net.onBin(MSG.ARENA_INPUT, (from, rd) => this.onInput(from, decodeArenaInput(rd))),
      r.net.onBin(MSG.FIRE, (from, rd) => this.onFire(from, decodeFire(rd))),
    );
    r.hostHooks.onLeave.push(this.onLeave);
    this.timer = window.setInterval(() => this.tick(), TICK * 1000);
  }

  private get m(): MatchState { return this.room.state!.match!; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.unsub.forEach((u) => u());
    const i = this.room.hostHooks.onLeave.indexOf(this.onLeave);
    if (i >= 0) this.room.hostHooks.onLeave.splice(i, 1);
    this.physics.dispose();
  }

  // =============================================================== lifecycle
  static create(room: Room): ReqResult {
    const s = room.state!;
    const alpha = s.setup.alpha.filter((id) => s.players[id]);
    const bravo = s.setup.bravo.filter((id) => s.players[id]);
    if (alpha.length + bravo.length < 1) return fail('Assign at least one player to a team.');
    if (alpha.length > 5 || bravo.length > 5) return fail('Max 5 players per team.');
    const players: Record<string, MatchPlayer> = {};
    const mk = (id: string, team: TeamKey): MatchPlayer => ({
      id, team, money: ECONOMY.startMoney, hp: 100, armor: 0, helmet: false, kit: false, alive: true,
      primary: null, secondary: 'p12', ammo: { p12: [WEAPONS.p12.magazine, WEAPONS.p12.reserve] }, grenades: [],
      kills: 0, deaths: 0, assists: 0, plants: 0, defuses: 0, damage: 0, connected: true,
    });
    alpha.forEach((id) => (players[id] = mk(id, 'alpha')));
    bravo.forEach((id) => (players[id] = mk(id, 'bravo')));
    s.match = {
      id: Math.random().toString(36).slice(2, 8), map: 'sector09', round: 1, maxRounds: s.setup.rounds, alphaSide: 'ATK',
      score: { alpha: 0, bravo: 0 }, lossStreak: { alpha: 0, bravo: 0 }, phase: 'freeze', phaseRemaining: MATCH_RULES.freezeTime,
      roundStartRemaining: MATCH_RULES.roundTime, players,
      bomb: { state: 'carried', carrier: null, pos: [0, 0, 0], site: null, planter: null, defuser: null, progress: 0, action: null },
      history: [], lastRoundWinner: null, lastRoundReason: '', winner: null,
    };
    return ok('Match created.');
  }

  /** Start (fresh) or resume (after host migration) the simulation. */
  begin(fresh: boolean, staleMs = 0): void {
    this.now = performance.now() / 1000;
    const m = this.m;
    if (fresh) { this.startRound(true); return; }
    // ---- resume after migration: best-effort, honest about failure
    const live = Object.values(m.players).filter((p) => p.connected && this.room.state!.players[p.id]);
    if (!live.length) { this.endMatch('Match could not be recovered: no players remain.'); return; }
    for (const p of Object.values(m.players)) {
      if (!this.room.state!.players[p.id]) { p.connected = false; p.alive = false; }
    }
    if (m.phase === 'ended') { this.phaseEnds = this.now + 3; return; }
    const stale = staleMs / 1000;
    if ((m.phase === 'live' || m.phase === 'planted') && stale > 5) {
      this.room.systemChat(`Host migration: last snapshot was ${stale.toFixed(1)} s old — the round is restarted to stay consistent.`);
      this.startRound(false, true);
      return;
    }
    this.phaseEnds = this.now + Math.max(0.5, m.phaseRemaining - stale);
    if (m.phase === 'live') this.liveStartedAt = this.now - (MATCH_RULES.roundTime - (m.phaseRemaining - stale));
    if (m.bomb.state === 'planted') this.bombPlantedAt = this.now - (MATCH_RULES.bombTimer - (m.phaseRemaining - stale));
    m.bomb.action = null;
    m.bomb.progress = 0;
    this.room.systemChat('Host migration complete — match resumed from the latest snapshot.');
    this.room.hostEvent({ e: 'resync' });
    this.room.commit();
  }

  private onLeave = (id: string) => {
    if (!this.room.state?.match) return;
    const p = this.m.players[id];
    if (!p) return;
    p.connected = false;
    if (p.alive) { p.alive = false; this.onDeath(id, null, 'disconnect', false); }
    this.ps.delete(id);
    this.sentSnaps.delete(id);
  };

  // =============================================================== rounds
  private side(id: string): Side | null { const p = this.m.players[id]; return p ? sideOf(this.m, p.team) : null; }
  private teamPlayers(side: Side): MatchPlayer[] { return Object.values(this.m.players).filter((p) => p.connected && sideOf(this.m, p.team) === side); }

  private startRound(first: boolean, restart = false): void {
    const m = this.m;
    this.projectiles.forEach((p) => this.physics.removeBody(p.body));
    this.projectiles = [];
    this.fires = [];
    this.smokes = [];
    this.action = null;
    this.dmgLog.clear();
    this.reloadUntil.clear();
    m.phase = 'freeze';
    m.phaseRemaining = MATCH_RULES.freezeTime;
    this.phaseEnds = this.now + MATCH_RULES.freezeTime;
    const spawns: Record<string, [number, number, number, number]> = {};
    const idx: Record<Side, number> = { ATK: 0, DEF: 0 };
    for (const p of Object.values(m.players)) {
      if (!p.connected) continue;
      const side = sideOf(m, p.team);
      if (!p.alive || first || restart) {
        // dead players lose their gear
        if (!p.alive && !restart) { p.primary = null; p.secondary = 'p12'; p.grenades = []; p.armor = 0; p.helmet = false; p.kit = false; p.ammo = {}; }
        p.alive = true;
      }
      p.hp = 100;
      if (side === 'ATK') p.kit = false;
      if (!p.secondary) p.secondary = 'p12';
      for (const w of [p.primary, p.secondary]) if (w && !p.ammo[w]) p.ammo[w] = [WEAPONS[w].magazine, WEAPONS[w].reserve];
      const sp = SPAWNS[side][idx[side]++ % SPAWNS[side].length];
      const yaw = side === 'ATK' ? 0 : Math.PI;
      spawns[p.id] = [sp[0], sp[1], sp[2], yaw];
      this.ps.set(p.id, this.freshPState(new THREE.Vector3(sp[0], sp[1], sp[2]), yaw));
    }
    const atk = this.teamPlayers('ATK');
    const carrier = atk.length ? atk[Math.floor(Math.random() * atk.length)].id : null;
    m.bomb = { state: carrier ? 'carried' : 'dropped', carrier, pos: carrier ? spawns[carrier].slice(0, 3) as [number, number, number] : [0, 0, 44], site: null, planter: null, defuser: null, progress: 0, action: null };
    // State first, then the event: clients must receive alive=true before they respawn, otherwise
    // the previous round's state (alive=false) would immediately kill them again.
    this.room.commit();
    queueMicrotask(() => this.room.hostEvent({ e: 'roundStart', round: m.round, spawns, carrier, restart }));
  }

  private freshPState(feet: THREE.Vector3, yaw: number): PState {
    return { feet: feet.clone(), yaw, pitch: 0, flags: 0, item: itemCode('p12'), anim: 0, lastInput: this.now, lastSeq: -1, ack: 0, hist: [] };
  }

  private endRound(winnerSide: Side, reason: string): void {
    const m = this.m;
    if (m.phase === 'roundEnd' || m.phase === 'ended' || m.phase === 'halftime') return;
    this.cancelAction();
    const winner = teamOnSide(m, winnerSide);
    const loser: TeamKey = winner === 'alpha' ? 'bravo' : 'alpha';
    m.score[winner]++;
    m.history.push({ round: m.round, winner, reason });
    m.lastRoundWinner = winner;
    m.lastRoundReason = reason;
    const winAmt = reason === 'Target destroyed' ? ECONOMY.roundWinBombExplode : reason === 'Bomb defused' ? ECONOMY.roundWinDefuse : ECONOMY.roundWin;
    const lossAmt = Math.min(ECONOMY.lossMax, ECONOMY.lossBase + ECONOMY.lossStep * m.lossStreak[loser]);
    const plantedBonus = sideOf(m, loser) === 'ATK' && m.bomb.planter ? ECONOMY.plantTeamLossBonus : 0;
    for (const p of Object.values(m.players)) {
      if (!p.connected) continue;
      const amt = p.team === winner ? winAmt : lossAmt + plantedBonus;
      p.money = Math.min(ECONOMY.maxMoney, p.money + amt);
    }
    m.lossStreak[winner] = Math.max(0, m.lossStreak[winner] - 1);
    m.lossStreak[loser] = Math.min(4, m.lossStreak[loser] + 1);
    const half = m.maxRounds / 2;
    const toWin = half + 1;
    const decided = m.score.alpha >= toWin || m.score.bravo >= toWin || m.round >= m.maxRounds;
    m.phase = 'roundEnd';
    m.phaseRemaining = MATCH_RULES.roundEndTime;
    this.phaseEnds = this.now + MATCH_RULES.roundEndTime;
    this.room.hostEvent({ e: 'roundEnd', winner, winnerSide, reason, score: m.score, decided });
    this.room.commit();
  }

  private advanceAfterRoundEnd(): void {
    const m = this.m;
    const half = m.maxRounds / 2;
    const toWin = half + 1;
    if (m.score.alpha >= toWin || m.score.bravo >= toWin || m.round >= m.maxRounds) {
      m.winner = m.score.alpha === m.score.bravo ? 'draw' : m.score.alpha > m.score.bravo ? 'alpha' : 'bravo';
      m.phase = 'ended';
      m.phaseRemaining = MATCH_RULES.matchEndTime;
      this.phaseEnds = this.now + MATCH_RULES.matchEndTime;
      this.room.hostEvent({ e: 'matchOver', winner: m.winner, score: m.score });
      this.room.commit();
      return;
    }
    if (m.round === half) {
      m.phase = 'halftime';
      m.phaseRemaining = MATCH_RULES.halftimeTime;
      this.phaseEnds = this.now + MATCH_RULES.halftimeTime;
      this.room.hostEvent({ e: 'halftime' });
      this.room.commit();
      return;
    }
    m.round++;
    this.startRound(false);
  }

  private doHalftime(): void {
    const m = this.m;
    m.alphaSide = m.alphaSide === 'ATK' ? 'DEF' : 'ATK';
    m.lossStreak = { alpha: 0, bravo: 0 };
    for (const p of Object.values(m.players)) {
      p.money = ECONOMY.halftimeMoney;
      p.primary = null; p.secondary = 'p12'; p.grenades = []; p.armor = 0; p.helmet = false; p.kit = false;
      p.ammo = {};
      p.alive = false; // forces full reset in startRound
    }
    m.round++;
    this.startRound(false);
  }

  endMatch(reason: string): void {
    const s = this.room.state;
    if (!s?.match) return;
    this.room.hostEvent({ e: 'matchEnd', reason });
    s.match = null;
    this.room.commit();
    this.dispose();
  }

  // =============================================================== tick
  private tick(): void {
    if (this.disposed || !this.room.state?.match || !this.room.isHost) return;
    this.now = performance.now() / 1000;
    const m = this.m;
    m.phaseRemaining = Math.max(0, this.phaseEnds - this.now);
    this.physics.step();
    this.updateProjectiles();
    // phase transitions
    if (m.phase === 'freeze' && m.phaseRemaining <= 0) {
      m.phase = 'live';
      this.phaseEnds = this.now + MATCH_RULES.roundTime;
      this.liveStartedAt = this.now;
      this.room.hostEvent({ e: 'live' });
      this.room.commit();
    } else if (m.phase === 'live' && m.phaseRemaining <= 0) {
      this.endRound('DEF', 'Time expired');
    } else if (m.phase === 'planted') {
      this.beepAcc -= TICK;
      if (m.phaseRemaining <= 0) this.explode();
    } else if (m.phase === 'roundEnd' && m.phaseRemaining <= 0) this.advanceAfterRoundEnd();
    else if (m.phase === 'halftime' && m.phaseRemaining <= 0) this.doHalftime();
    else if (m.phase === 'ended' && m.phaseRemaining <= 0) { this.endMatch('Match complete.'); return; }

    if (m.phase === 'live' || m.phase === 'planted') {
      this.checkElimination();
      this.updateAction();
      this.updateBombPickup();
      this.updateFires();
    }
    for (const [id, r] of this.reloadUntil) {
      if (this.now >= r.until) {
        this.reloadUntil.delete(id);
        const p = m.players[id];
        const a = p?.ammo[r.weapon];
        if (a) {
          const need = WEAPONS[r.weapon as WeaponId].magazine - a[0];
          const take = Math.min(need, a[1]);
          a[0] += take;
          a[1] -= take;
          this.room.commit();
        }
      }
    }
    this.snapAcc += TICK;
    if (this.snapAcc >= 0.05) { this.snapAcc = 0; this.sendSnapshots(); }
    this.commitAcc += TICK;
    if (this.commitAcc >= 1) { this.commitAcc = 0; this.room.commit(); }
  }

  private checkElimination(): void {
    const m = this.m;
    const atk = this.teamPlayers('ATK'), def = this.teamPlayers('DEF');
    const atkAlive = atk.filter((p) => p.alive).length, defAlive = def.filter((p) => p.alive).length;
    if (def.length > 0 && defAlive === 0) { this.endRound('ATK', 'Defenders eliminated'); return; }
    if (atk.length > 0 && atkAlive === 0 && m.phase === 'live') this.endRound('DEF', 'Attackers eliminated');
  }

  // =============================================================== input & movement validation
  private onInput(from: string, inp: ArenaInput): void {
    if (!this.room.state?.match) return;
    const p = this.m.players[from];
    if (!p) return;
    let st = this.ps.get(from);
    if (!st) { st = this.freshPState(new THREE.Vector3(inp.x, inp.y, inp.z), inp.yaw); this.ps.set(from, st); }
    if (st.lastSeq >= 0 && !seqNewer(inp.seq, st.lastSeq)) return; // out of order
    st.lastSeq = inp.seq;
    st.ack = inp.ack;
    const dt = Math.max(0.016, Math.min(0.5, this.now - st.lastInput));
    st.lastInput = this.now;
    st.yaw = inp.yaw;
    st.pitch = THREE.MathUtils.clamp(inp.pitch, -1.55, 1.55);
    st.flags = inp.flags;
    st.anim = inp.anim;
    const item = itemFromCode(inp.item);
    if (this.owns(p, item)) st.item = inp.item;
    if (!p.alive) return;
    const next = new THREE.Vector3(inp.x, inp.y, inp.z);
    const horiz = Math.hypot(next.x - st.feet.x, next.z - st.feet.z);
    const vert = Math.abs(next.y - st.feet.y);
    const frozen = this.m.phase === 'freeze';
    const maxH = frozen ? 0.6 : RUN_SPEED * 1.15 * dt * 1.7 + 0.6;
    if (horiz > maxH || vert > 12 * dt + 1.2) {
      this.room.net.sendJson(from, MSG.CORRECTION, { x: st.feet.x, y: st.feet.y, z: st.feet.z });
      if (from === this.room.selfId) this.room.emit('event', { e: 'correction', x: st.feet.x, y: st.feet.y, z: st.feet.z });
      return;
    }
    st.feet.copy(next);
    st.hist.push({ t: this.now, feet: next.clone(), crouch: !!(inp.flags & IN_CROUCH) });
    while (st.hist.length && this.now - st.hist[0].t > 1) st.hist.shift();
  }
  /** Host's own player feeds input without the network. */
  localInput(inp: ArenaInput): void { this.onInput(this.room.selfId, inp); }
  localFire(f: FireMsg): void { this.onFire(this.room.selfId, f); }

  private owns(p: MatchPlayer, item: string): boolean {
    if (item === 'knife') return true;
    if (item === 'c4') return this.m.bomb.carrier === p.id;
    if (item === 'smoke' || item === 'flash' || item === 'molotov') return p.grenades.includes(item);
    return p.primary === item || p.secondary === item;
  }

  private rewound(id: string, rewind: number): { feet: THREE.Vector3; crouch: boolean } | null {
    const st = this.ps.get(id);
    if (!st) return null;
    const t = this.now - rewind;
    const h = st.hist;
    if (!h.length) return { feet: st.feet, crouch: !!(st.flags & IN_CROUCH) };
    if (t >= h[h.length - 1].t) return { feet: h[h.length - 1].feet, crouch: h[h.length - 1].crouch };
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= t) {
        const a = h[i - 1], b = h[i];
        const k = (t - a.t) / Math.max(1e-4, b.t - a.t);
        return { feet: a.feet.clone().lerp(b.feet, k), crouch: k < 0.5 ? a.crouch : b.crouch };
      }
    }
    return { feet: h[0].feet, crouch: h[0].crouch };
  }

  // =============================================================== shooting
  private onFire(from: string, f: FireMsg): void {
    if (!this.room.state?.match) return;
    const m = this.m;
    const p = m.players[from];
    const st = this.ps.get(from);
    if (!p || !st || !p.alive) return;
    if (m.phase === 'freeze' || m.phase === 'halftime' || m.phase === 'ended') return;
    const item = itemFromCode(f.item) as WeaponId;
    const w = WEAPONS[item];
    if (!w || !this.owns(p, item)) return;
    if (this.reloadUntil.has(from)) return;
    const last = this.lastShot.get(from) ?? 0;
    if (this.now - last < (60 / w.rpm) * 0.75) return; // fire-rate check (25% jitter tolerance)
    if (w.pellets > 1 ? f.dirs.length > w.pellets : f.dirs.length !== 1) return;
    if (w.cls !== 'melee') {
      const a = p.ammo[item];
      if (!a || a[0] <= 0) return;
      a[0]--;
    }
    this.lastShot.set(from, this.now);
    const origin = new THREE.Vector3(f.ox, f.oy, f.oz);
    const eye = st.feet.clone().add(new THREE.Vector3(0, st.flags & IN_CROUCH ? 1.1 : 1.6, 0));
    if (origin.distanceTo(eye) > 2.0) origin.copy(eye); // don't trust a far-away origin
    const rewind = THREE.MathUtils.clamp(this.room.net.rtt(from) / 2000 + 0.1, 0, 0.3);
    const hits: { x: number; y: number; z: number; kind: number }[] = [];
    const dmgTo = new Map<string, { dmg: number; head: boolean; part: HitPart }>();
    const maxRange = w.cls === 'melee' ? w.range : 250;
    for (const d0 of f.dirs) {
      const dir = new THREE.Vector3(...d0).normalize();
      const wall = this.physics.raycast(origin, dir, maxRange);
      const wallDist = wall ? wall.distance : maxRange;
      let best: { id: string; t: number; part: HitPart } | null = null;
      for (const [id, op] of Object.entries(m.players)) {
        if (id === from || !op.alive || !op.connected) continue;
        const hb = this.rewound(id, rewind);
        if (!hb) continue;
        const r = testHitbox(origin, dir, hb, wallDist);
        if (r && (!best || r.t < best.t)) best = { id, t: r.t, part: r.part };
      }
      // smoke blocks nothing physically, flames don't block shots
      if (best) {
        const pt = origin.clone().addScaledVector(dir, best.t);
        hits.push({ x: pt.x, y: pt.y, z: pt.z, kind: 1 });
        let dmg = w.damage;
        if (best.t > w.range) dmg *= Math.pow(w.falloff, (best.t - w.range) / 10);
        if (best.part === 'head') dmg *= w.headMult;
        else if (best.part === 'legs') dmg *= 0.75;
        const prev = dmgTo.get(best.id);
        dmgTo.set(best.id, { dmg: (prev?.dmg ?? 0) + dmg, head: (prev?.head ?? false) || best.part === 'head', part: best.part });
      } else if (wall) {
        hits.push({ x: wall.point.x, y: wall.point.y, z: wall.point.z, kind: 0 });
      } else {
        const end = origin.clone().addScaledVector(dir, maxRange);
        hits.push({ x: end.x, y: end.y, z: end.z, kind: 2 });
      }
    }
    const order = this.room.state!.players[from]?.joinOrder ?? 0;
    this.room.net.broadcast(encodeShotFx({ order, item: f.item, ox: origin.x, oy: origin.y, oz: origin.z, hits: hits.slice(0, 12) }), false, from);
    if (from !== this.room.selfId) {
      // the host's own client renders remote shots from SHOT_FX too
      this.room.emit('event', { e: 'shotfx', order, item: f.item, ox: origin.x, oy: origin.y, oz: origin.z, hits });
    }
    for (const [vid, d] of dmgTo) this.applyDamage(vid, from, d.dmg, item, d.head, w.armorPen, origin);
  }

  private applyDamage(victimId: string, attacker: string | null, raw: number, weapon: string, head: boolean, armorPen: number, from?: THREE.Vector3): void {
    const m = this.m;
    const v = m.players[victimId];
    if (!v || !v.alive) return;
    let hpDmg = raw;
    const armored = v.armor > 0 && (!head || v.helmet);
    if (armored) {
      hpDmg = raw * armorPen;
      const armorDmg = (raw - hpDmg) * 0.5;
      if (armorDmg > v.armor) { hpDmg += (armorDmg - v.armor) * 2; v.armor = 0; }
      else v.armor = Math.round(v.armor - armorDmg);
    }
    hpDmg = Math.round(Math.max(1, hpDmg));
    const applied = Math.min(v.hp, hpDmg);
    v.hp -= applied;
    if (attacker && m.players[attacker]) {
      const a = m.players[attacker];
      if (a.team !== v.team) a.damage += applied;
      const log = this.dmgLog.get(victimId) ?? new Map<string, number>();
      log.set(attacker, (log.get(attacker) ?? 0) + applied);
      this.dmgLog.set(victimId, log);
    }
    if (attacker) this.room.hostEventTo(attacker, { e: 'hit', victim: victimId, dmg: applied, head, kill: v.hp <= 0 });
    this.room.hostEventTo(victimId, { e: 'damaged', from: attacker, dmg: applied, fx: from ? [from.x, from.y, from.z] : null, weapon });
    if (v.hp <= 0) this.onDeath(victimId, attacker, weapon, head);
  }

  private onDeath(victimId: string, killer: string | null, weapon: string, head: boolean): void {
    const m = this.m;
    const v = m.players[victimId];
    v.alive = false;
    v.hp = 0;
    v.deaths++;
    if (this.action?.player === victimId) this.cancelAction();
    const st = this.ps.get(victimId);
    if (m.bomb.carrier === victimId) {
      m.bomb.state = 'dropped';
      m.bomb.carrier = null;
      if (st) m.bomb.pos = [st.feet.x, st.feet.y, st.feet.z];
      this.room.hostEvent({ e: 'bombDropped', pos: m.bomb.pos });
    }
    if (killer && killer !== victimId && m.players[killer]) {
      const k = m.players[killer];
      if (k.team !== v.team) {
        k.kills++;
        const reward = weapon in WEAPONS ? WEAPONS[weapon as WeaponId].killReward : 300;
        k.money = Math.min(ECONOMY.maxMoney, k.money + reward);
      } else {
        k.kills--;
        k.money = Math.max(0, k.money - 300);
      }
    }
    const log = this.dmgLog.get(victimId);
    let assister: string | null = null;
    if (log) for (const [aid, dmg] of log) if (aid !== killer && dmg >= 40 && m.players[aid]?.team !== v.team) { m.players[aid].assists++; assister = aid; break; }
    this.room.hostEvent({ e: 'kill', killer, victim: victimId, weapon, head, assister, pos: st ? [st.feet.x, st.feet.y, st.feet.z] : null });
    this.room.commit();
  }

  // =============================================================== reload / buy
  private reload(from: string): ReqResult {
    const p = this.m?.players[from];
    const st = this.ps.get(from);
    if (!p || !st || !p.alive) return fail('Cannot reload.');
    const item = itemFromCode(st.item) as WeaponId;
    const w = WEAPONS[item];
    const a = p.ammo[item];
    if (!w || !a || w.cls === 'melee') return fail('Nothing to reload.');
    if (a[0] >= w.magazine || a[1] <= 0) return fail('Magazine full or no reserve.');
    if (this.reloadUntil.has(from)) return ok();
    this.reloadUntil.set(from, { until: this.now + w.reloadTime, weapon: item });
    this.room.hostEvent({ e: 'reloadStart', player: from }, from);
    return ok();
  }

  private canBuy(from: string): string | null {
    const m = this.m;
    const p = m.players[from];
    const st = this.ps.get(from);
    if (!p || !p.alive) return 'Dead players cannot buy.';
    const side = this.side(from)!;
    const inTime = m.phase === 'freeze' || (m.phase === 'live' && this.now - this.liveStartedAt < MATCH_RULES.buyWindow);
    if (!inTime) return 'Buy time is over.';
    if (!st || !inZone(BUY_ZONES[side], st.feet)) return 'You must be in your spawn buy zone.';
    return null;
  }

  private buy(from: string, item: unknown): ReqResult {
    if (!this.room.state?.match) return fail('No match running.');
    const deny = this.canBuy(from);
    if (deny) return fail(deny);
    const p = this.m.players[from];
    const side = this.side(from)!;
    if (typeof item !== 'string') return fail('Unknown item.');
    if (item in WEAPONS) {
      const w = WEAPONS[item as WeaponId];
      if (w.cls === 'melee') return fail('Not for sale.');
      const slot = w.slot === 1 ? 'primary' : 'secondary';
      if (p[slot] === w.id) return fail('You already own this weapon.');
      if (p.money < w.price) return fail(`Not enough money ($${w.price}).`);
      p.money -= w.price;
      p[slot] = w.id;
      p.ammo[w.id] = [w.magazine, w.reserve];
      this.room.commit();
      return ok(`Purchased ${w.name}.`, { slot, item: w.id });
    }
    if (item in GEAR) {
      const g = GEAR[item as GearId];
      if (g.side && g.side !== side) return fail('Defuse kits are for defenders only.');
      let price = g.price;
      if (item === 'kevlar') { if (p.armor >= 100) return fail('Armor already full.'); }
      if (item === 'helmet') {
        if (p.helmet && p.armor >= 100) return fail('Already fully armored.');
        if (p.armor >= 100 && !p.helmet) price = 350;
      }
      if (item === 'kit' && p.kit) return fail('You already have a kit.');
      if (item === 'smoke' || item === 'flash' || item === 'molotov') {
        if (p.grenades.includes(item)) return fail('You already carry one.');
        if (p.grenades.length >= 3) return fail('Grenade limit reached (3).');
      }
      if (p.money < price) return fail(`Not enough money ($${price}).`);
      p.money -= price;
      if (item === 'kevlar') p.armor = 100;
      else if (item === 'helmet') { p.armor = 100; p.helmet = true; }
      else if (item === 'kit') p.kit = true;
      else p.grenades.push(item as GrenadeId);
      this.room.commit();
      return ok(`Purchased ${g.name}.`);
    }
    return fail('Unknown item.');
  }

  // =============================================================== bomb
  private startAction(from: string, kind: 'plant' | 'defuse'): ReqResult {
    if (!this.room.state?.match) return fail('No match.');
    const m = this.m;
    const p = m.players[from];
    const st = this.ps.get(from);
    if (!p || !st || !p.alive) return fail('You are dead.');
    if (this.action) return fail(this.action.player === from ? 'Already in progress.' : 'Someone else is on the bomb.');
    if (kind === 'plant') {
      if (m.phase !== 'live') return fail('Cannot plant now.');
      if (m.bomb.carrier !== from) return fail('You are not carrying the C4.');
      const site = (['A', 'B'] as const).find((k) => inZone(SITES[k], st.feet));
      if (!site) return fail('Plant the C4 inside bomb site A or B.');
      this.action = { player: from, kind, start: this.now, pos: st.feet.clone(), dur: MATCH_RULES.plantTime };
      m.bomb.action = 'plant';
      m.bomb.site = site;
      this.room.hostEvent({ e: 'actionStart', kind, player: from });
      return ok();
    }
    if (m.bomb.state !== 'planted' || m.phase !== 'planted') return fail('No planted bomb.');
    if (this.side(from) !== 'DEF') return fail('Only defenders can defuse.');
    const bp = new THREE.Vector3(...m.bomb.pos);
    if (bp.distanceTo(st.feet) > 1.8) return fail('Get closer to the bomb.');
    this.action = { player: from, kind, start: this.now, pos: st.feet.clone(), dur: p.kit ? MATCH_RULES.defuseTimeKit : MATCH_RULES.defuseTime };
    m.bomb.action = 'defuse';
    m.bomb.defuser = from;
    this.room.hostEvent({ e: 'actionStart', kind, player: from, kit: p.kit });
    return ok();
  }

  private cancelAction(): void {
    if (!this.action) return;
    const a = this.action;
    this.action = null;
    const m = this.m;
    m.bomb.action = null;
    m.bomb.progress = 0;
    if (a.kind === 'defuse') m.bomb.defuser = null;
    this.room.hostEvent({ e: 'actionCancel', kind: a.kind, player: a.player });
  }

  private updateAction(): void {
    const a = this.action;
    if (!a) return;
    const m = this.m;
    const p = m.players[a.player];
    const st = this.ps.get(a.player);
    if (!p || !p.alive || !st || st.feet.distanceTo(a.pos) > 0.5) { this.cancelAction(); return; }
    const prog = (this.now - a.start) / a.dur;
    m.bomb.progress = Math.min(1, prog);
    if (prog < 1) return;
    this.action = null;
    m.bomb.action = null;
    m.bomb.progress = 0;
    if (a.kind === 'plant') {
      m.bomb.state = 'planted';
      m.bomb.carrier = null;
      m.bomb.planter = a.player;
      m.bomb.pos = [a.pos.x, a.pos.y, a.pos.z];
      p.plants++;
      p.money = Math.min(ECONOMY.maxMoney, p.money + ECONOMY.plantReward);
      m.phase = 'planted';
      this.phaseEnds = this.now + MATCH_RULES.bombTimer;
      m.phaseRemaining = MATCH_RULES.bombTimer;
      this.bombPlantedAt = this.now;
      this.room.hostEvent({ e: 'planted', site: m.bomb.site, pos: m.bomb.pos, player: a.player });
      this.room.commit();
    } else {
      m.bomb.state = 'defused';
      p.defuses++;
      p.money = Math.min(ECONOMY.maxMoney, p.money + ECONOMY.defuseReward);
      this.room.hostEvent({ e: 'defused', player: a.player });
      this.endRound('DEF', 'Bomb defused');
    }
  }

  private explode(): void {
    const m = this.m;
    m.bomb.state = 'exploded';
    const bp = new THREE.Vector3(...m.bomb.pos);
    this.room.hostEvent({ e: 'exploded', pos: m.bomb.pos });
    for (const p of Object.values(m.players)) {
      if (!p.alive) continue;
      const st = this.ps.get(p.id);
      if (!st) continue;
      const d = st.feet.distanceTo(bp);
      if (d < 20) this.applyDamage(p.id, null, Math.round(500 * Math.pow(1 - d / 20, 2)), 'c4', false, 0.5);
    }
    this.endRound('ATK', 'Target destroyed');
  }

  private updateBombPickup(): void {
    const m = this.m;
    if (m.bomb.state !== 'dropped') return;
    const bp = new THREE.Vector3(...m.bomb.pos);
    for (const p of Object.values(m.players)) {
      if (!p.alive || this.side(p.id) !== 'ATK') continue;
      const st = this.ps.get(p.id);
      if (st && st.feet.distanceTo(bp) < 1.4) {
        m.bomb.state = 'carried';
        m.bomb.carrier = p.id;
        this.room.hostEvent({ e: 'bombPicked', player: p.id });
        this.room.commit();
        return;
      }
    }
  }

  private dropBomb(from: string): ReqResult {
    const m = this.m;
    if (!m || m.bomb.carrier !== from) return fail('You are not carrying the C4.');
    const st = this.ps.get(from);
    if (!st) return fail('Unknown position.');
    const yaw = st.yaw;
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const pos = st.feet.clone().addScaledVector(fwd, 1.6);
    // keep it on the floor (ray down) and not inside walls
    const down = this.physics.raycast(pos.clone().add(new THREE.Vector3(0, 1.2, 0)), new THREE.Vector3(0, -1, 0), 4);
    const wall = this.physics.raycast(st.feet.clone().add(new THREE.Vector3(0, 0.5, 0)), fwd, 1.7);
    const final = wall ? st.feet.clone() : down ? down.point : st.feet.clone();
    m.bomb.state = 'dropped';
    m.bomb.carrier = null;
    m.bomb.pos = [final.x, final.y, final.z];
    this.room.hostEvent({ e: 'bombDropped', pos: m.bomb.pos });
    // block instant re-pickup by the dropper for a moment
    st.feet.addScaledVector(fwd, -0.01);
    this.room.commit();
    return ok('C4 dropped.');
  }

  // =============================================================== grenades
  private throwNade(from: string, a: any): ReqResult {
    if (!this.room.state?.match) return fail('No match.');
    const m = this.m;
    const p = m.players[from];
    const st = this.ps.get(from);
    const type = a.type as GrenadeId;
    if (!p || !st || !p.alive || !['smoke', 'flash', 'molotov'].includes(type)) return fail('Cannot throw.');
    if (m.phase === 'freeze' || m.phase === 'ended' || m.phase === 'halftime') return fail('Cannot throw now.');
    if (!p.grenades.includes(type)) return fail('You do not have that grenade.');
    const o = new THREE.Vector3(Number(a.ox), Number(a.oy), Number(a.oz));
    const v = new THREE.Vector3(Number(a.vx), Number(a.vy), Number(a.vz));
    if (![o.x, o.y, o.z, v.x, v.y, v.z].every(Number.isFinite)) return fail('Bad throw.');
    if (o.distanceTo(st.feet) > 2.5) o.copy(st.feet).add(new THREE.Vector3(0, 1.5, 0));
    if (v.length() > 22) v.setLength(22);
    p.grenades.splice(p.grenades.indexOf(type), 1);
    const body = this.physics.createBall(o, v, 0.07);
    const fuse = type === 'smoke' ? 2.2 : type === 'flash' ? 1.5 : 3.0;
    this.projectiles.push({ id: this.nextProj++ & 0xffff, type, body, owner: from, born: this.now, fuse, lastVel: v.length(), bounced: 0 });
    this.room.hostEvent({ e: 'throw', player: from, type }, from);
    this.room.commit();
    return ok();
  }

  private updateProjectiles(): void {
    for (const pr of [...this.projectiles]) {
      const t = pr.body.translation();
      const v = pr.body.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      const pos = new THREE.Vector3(t.x, t.y, t.z);
      if (speed < pr.lastVel * 0.6 && pr.lastVel > 1.5) { pr.bounced++; this.room.hostEvent({ e: 'bounce', pos: [t.x, t.y, t.z] }); }
      pr.lastVel = speed;
      const age = this.now - pr.born;
      const landedFire = pr.type === 'molotov' && pr.bounced > 0 && Math.abs(v.y) < 3 && age > 0.15;
      if (age >= pr.fuse || landedFire || t.y < -20) this.detonate(pr, pos);
    }
  }

  private detonate(pr: Projectile, pos: THREE.Vector3): void {
    this.projectiles.splice(this.projectiles.indexOf(pr), 1);
    this.physics.removeBody(pr.body);
    if (pr.type === 'smoke') {
      this.smokes.push({ pos, until: this.now + 18, owner: pr.owner, radius: 4.2 });
      const before = this.fires.length;
      this.fires = this.fires.filter((f) => f.pos.distanceTo(pos) > f.radius + 3);
      if (before !== this.fires.length) this.room.hostEvent({ e: 'extinguish', pos: [pos.x, pos.y, pos.z] });
      this.room.hostEvent({ e: 'nade', type: 'smoke', pos: [pos.x, pos.y, pos.z], owner: pr.owner, duration: 18 });
    } else if (pr.type === 'flash') {
      this.room.hostEvent({ e: 'nade', type: 'flash', pos: [pos.x, pos.y, pos.z], owner: pr.owner });
    } else {
      // fire spreads on the floor below the impact point
      const down = this.physics.raycast(pos.clone().add(new THREE.Vector3(0, 0.3, 0)), new THREE.Vector3(0, -1, 0), 8);
      const ground = down ? down.point : pos;
      if (this.smokes.some((s) => s.pos.distanceTo(ground) < s.radius + 1 && this.now < s.until)) {
        this.room.hostEvent({ e: 'extinguish', pos: [ground.x, ground.y, ground.z] });
        return;
      }
      this.fires.push({ pos: ground, until: this.now + 7, owner: pr.owner, radius: 3.2 });
      this.room.hostEvent({ e: 'nade', type: 'molotov', pos: [ground.x, ground.y, ground.z], owner: pr.owner, duration: 7 });
    }
  }

  private updateFires(): void {
    this.fires = this.fires.filter((f) => this.now < f.until);
    this.smokes = this.smokes.filter((s) => this.now < s.until);
    this.fireTick -= TICK;
    if (this.fireTick > 0 || !this.fires.length) return;
    this.fireTick = 0.25;
    for (const f of this.fires) {
      for (const p of Object.values(this.m.players)) {
        if (!p.alive) continue;
        const st = this.ps.get(p.id);
        if (!st) continue;
        const dx = st.feet.x - f.pos.x, dz = st.feet.z - f.pos.z;
        if (Math.hypot(dx, dz) < f.radius && Math.abs(st.feet.y - f.pos.y) < 1.6) this.applyDamage(p.id, f.owner, 10, 'molotov', false, 0.9);
      }
    }
  }

  // =============================================================== snapshots
  private sendSnapshots(): void {
    const m = this.m;
    const s = this.room.state!;
    const players = new Map<number, NetPlayer>();
    for (const p of Object.values(m.players)) {
      const info = s.players[p.id];
      const st = this.ps.get(p.id);
      if (!info || !st) continue;
      players.set(info.joinOrder, {
        order: info.joinOrder, x: st.feet.x, y: st.feet.y, z: st.feet.z, yaw: st.yaw, pitch: st.pitch, anim: st.anim, flags: st.flags,
        hp: Math.max(0, Math.round(p.hp)), armor: Math.round(p.armor), item: st.item, alive: p.alive ? 1 : 0,
      });
    }
    const projectiles = this.projectiles.map((pr) => { const t = pr.body.translation(); return { id: pr.id, type: NADE_CODE[pr.type], x: t.x, y: t.y, z: t.z }; });
    const seq = this.snapSeq;
    this.snapSeq = this.snapSeq >= 0xfffe ? 1 : this.snapSeq + 1;
    const snap: Snapshot = { seq, base: 0, phaseRemaining: m.phaseRemaining, actionProgress: m.bomb.progress, players, projectiles };
    for (const id of Object.keys(m.players)) {
      if (id === this.room.selfId) { this.room.emit('event', { e: 'localSnap', snap }); continue; }
      if (!this.room.net.isConnected(id)) continue;
      let hist = this.sentSnaps.get(id);
      if (!hist) this.sentSnaps.set(id, (hist = new Map()));
      const st = this.ps.get(id);
      const baseline = st?.ack ? hist.get(st.ack) : undefined;
      this.room.net.send(id, encodeSnapshot(snap, baseline), false);
      hist.set(seq, snap);
      if (hist.size > 40) hist.delete(hist.keys().next().value!);
    }
  }
}
