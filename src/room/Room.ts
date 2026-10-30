// Replicated room state + host authority + host migration.
// The host owns RoomState; every change bumps `version` and is broadcast reliably. Every peer
// keeps the latest copy, which doubles as the migration snapshot if the host disappears.
import { Emitter } from '../core/Emitter';
import { Net } from '../networking/Net';
import { MSG, randomId } from '../networking/protocol';
import { newRoomCode } from '../networking/webrtc/RelayLink';
import { ECONOMY } from '../config/economy';
import { emptyRoom, sortedPlayers, validateRoomState, type Device, type Look, type PlayerInfo, type RoomState } from './RoomState';

export interface Profile { name: string; device: Device; look: Look; finish: string }
export interface ReqResult { ok: boolean; msg?: string; data?: any }
export type ReqHandler = (from: string, args: any) => ReqResult;
export interface GameEvent { e: string; [k: string]: any }
export interface ChatLine { from: string; name: string; ch: 'all' | 'party' | 'system'; text: string; ts: number }

type RoomEvents = {
  state: [RoomState];
  event: [GameEvent];
  chat: [ChatLine];
  hostChanged: [string, boolean];      // hostId, isSelf
  migrating: [string];                 // message
  migrationFailed: [string];
  closed: [string];
  joined: [];
  peerLeft: [string, string];          // id, name
};

const CLAIM_WAIT_MS = 4500;
const ACK_WAIT_MS = 1500;

export class Room extends Emitter<RoomEvents> {
  state: RoomState | null = null;
  stateReceivedAt = 0;
  migrating = false;
  private handlers = new Map<string, ReqHandler>();
  private pending = new Map<string, { resolve: (r: ReqResult) => void; timer: number }>();
  private commitQueued = false;
  private chatRate = new Map<string, number[]>();
  private excludedSuccessors = new Set<string>();
  private claimTimer = 0;
  private acks = new Map<string, { version: number; state?: RoomState }>();
  /** Host hooks used by authorities to react to roster changes. */
  hostHooks: { onJoin: ((p: PlayerInfo) => void)[]; onLeave: ((id: string) => void)[]; onBecameHost: ((staleMs: number) => void)[] } = { onJoin: [], onLeave: [], onBecameHost: [] };

  constructor(readonly net: Net, public profile: Profile) {
    super();
    net.identInfo = () => ({ device: this.profile.device, look: this.profile.look, finish: this.profile.finish });
    net.admit = (info) => {
      if (!this.state) return 'Room not ready.';
      if (Object.keys(this.state.players).length >= 10) return 'Room is full (10 players).';
      if (this.state.match && this.state.match.phase !== 'ended') return null; // may join city while match runs
      return null;
    };
    net.onInviteJoined = (id, info) => this.hostAddPlayer(id, info);
    net.isMember = (id) => !!this.state?.players[id];
    net.onJoined = () => this.emit('joined');
    net.onPeerClose = (id, reason) => this.handlePeerClose(id, reason);

    net.onJson(MSG.ROOM_STATE, (from, m) => this.handleRoomState(from, m));
    net.onJson(MSG.REQ, (from, m) => this.handleReq(from, m));
    net.onJson(MSG.RESULT, (from, m) => this.handleResult(from, m));
    net.onJson(MSG.EVENT, (from, m) => { if (from === this.state?.hostId && typeof m.e === 'string') this.emit('event', m as GameEvent); });
    net.onJson(MSG.CHAT, (from, m) => this.handleChat(from, m));
    net.onJson(MSG.HOST_CLAIM, (from, m) => this.handleClaim(from, m));
    net.onJson(MSG.HOST_ACK, (from, m) => this.handleAck(from, m));
    net.onJson(MSG.STATE_REQ, (from) => { if (this.state) net.sendJson(from, MSG.STATE_RES, { state: this.state }); });
    net.onJson(MSG.BYE, () => {});
  }

  get selfId(): string { return this.net.selfId; }
  get isHost(): boolean { return !!this.state && this.state.hostId === this.selfId; }
  get self(): PlayerInfo | undefined { return this.state?.players[this.selfId]; }
  player(id: string): PlayerInfo | undefined { return this.state?.players[id]; }

  // ------------------------------------------------------------ lifecycle
  createRoom(): void {
    const roomId = newRoomCode();
    this.net.selfName = this.profile.name;
    this.state = emptyRoom(roomId, this.selfId);
    this.net.openCodeRoom(roomId, true);
    this.hostAddPlayer(this.selfId, { name: this.profile.name, info: this.net.identInfo() });
    this.net.start();
    this.emit('hostChanged', this.selfId, true);
  }

  /** Join a room by its short code; resolves via the 'joined' / 'state' events. */
  joinByCode(code: string): void {
    this.net.selfName = this.profile.name;
    this.net.start();
    this.net.openCodeRoom(code, false);
  }

  leave(reason = 'You left the room.'): void {
    this.net.shutdown();
    this.state = null;
    this.migrating = false;
    clearTimeout(this.claimTimer);
    this.emit('closed', reason);
  }

  registerHandler(kind: string, fn: ReqHandler): () => void {
    this.handlers.set(kind, fn);
    return () => { if (this.handlers.get(kind) === fn) this.handlers.delete(kind); };
  }

  // ------------------------------------------------------------ host: state commits
  /** Host-only: mark state changed; broadcast at most once per microtask burst. */
  commit(): void {
    if (!this.isHost || !this.state) return;
    this.state.version++;
    if (this.commitQueued) return;
    this.commitQueued = true;
    queueMicrotask(() => {
      this.commitQueued = false;
      if (!this.state) return;
      this.net.broadcastJson(MSG.ROOM_STATE, this.state);
      this.stateReceivedAt = performance.now();
      this.emit('state', this.state);
    });
  }

  /** Host-only: broadcast an event to everyone (including self). */
  hostEvent(ev: GameEvent, except?: string): void {
    if (!this.isHost) return;
    this.net.broadcastJson(MSG.EVENT, ev, except);
    this.emit('event', ev);
  }
  /** Host-only: event to one player. */
  hostEventTo(id: string, ev: GameEvent): void {
    if (id === this.selfId) this.emit('event', ev);
    else this.net.sendJson(id, MSG.EVENT, ev);
  }

  private hostAddPlayer(id: string, m: any): void {
    if (!this.state) return;
    const info = m.info ?? {};
    const look: Look = {
      jacket: Number.isInteger(info.look?.jacket) ? info.look.jacket : 0x1c2230,
      visor: Number.isInteger(info.look?.visor) ? info.look.visor : 0x00e5ff,
      trim: Number.isInteger(info.look?.trim) ? info.look.trim : 0x00e5ff,
    };
    const p: PlayerInfo = {
      id, name: sanitizeName(m.name), joinOrder: this.state.nextJoinOrder++,
      device: info.device === 'mobile' ? 'mobile' : 'pc', look, credits: ECONOMY.cityStartCredits, owned: [],
      finish: typeof info.finish === 'string' ? info.finish.slice(0, 16) : 'stock', partyId: null, ready: false,
    };
    this.state.players[id] = p;
    // tell everyone already present to open a direct link to the newcomer (full mesh)
    // manually invited peers are only linked to the host: ask everyone else to open a direct link
    // (players who came by room code are already meshed by the relay pairing)
    if (this.net.isManualPeer(id)) {
      for (const other of Object.keys(this.state.players)) {
        if (other !== id && other !== this.selfId) this.net.sendJson(other, MSG.CONNECT_TO, { id, manual: true });
      }
    }
    for (const fn of this.hostHooks.onJoin) fn(p);
    if (id !== this.selfId) this.systemChat(`${p.name} joined the room.`);
    this.commit();
  }

  private handlePeerClose(id: string, reason: string): void {
    if (!this.state) return;
    const name = this.state.players[id]?.name ?? 'Player';
    if (id === this.state.hostId && !this.isHost) {
      this.emit('peerLeft', id, name);
      this.beginMigration(`Host ${name} disconnected (${reason}).`);
      return;
    }
    if (this.isHost) {
      if (!this.state.players[id]) return;
      this.hostRemovePlayer(id);
      this.systemChat(`${name} left the room.`);
    }
    this.emit('peerLeft', id, name);
  }

  hostRemovePlayer(id: string): void {
    if (!this.state) return;
    delete this.state.players[id];
    for (const fn of this.hostHooks.onLeave) fn(id);
    this.commit();
  }

  // ------------------------------------------------------------ client: state replication
  private handleRoomState(from: string, m: any): void {
    if (!validateRoomState(m)) { console.warn('[room] invalid room state'); return; }
    const cur = this.state;
    if (cur) {
      if (m.roomId !== cur.roomId) return;
      if (m.epoch < cur.epoch) return;                              // stale host
      if (m.epoch === cur.epoch && from !== cur.hostId) return;      // not the current host
      if (m.epoch === cur.epoch && m.version <= cur.version) return; // out of date
      if (m.hostId !== from) return;
    } else if (from !== this.net.hostId || m.hostId !== from) return;
    const hostChanged = !cur || cur.hostId !== m.hostId;
    if (cur && this.isHost && m.epoch > cur.epoch) console.warn('[room] stepping down: newer host epoch observed');
    this.state = m;
    this.net.hostId = m.hostId;
    this.net.roomId = m.roomId;
    this.stateReceivedAt = performance.now();
    if (this.migrating) { this.migrating = false; clearTimeout(this.claimTimer); }
    if (hostChanged) this.emit('hostChanged', m.hostId, m.hostId === this.selfId);
    if (!this.state.players[this.selfId] && cur?.players[this.selfId]) {
      this.leave('You were removed from the room.');
      return;
    }
    this.emit('state', this.state);
  }

  // ------------------------------------------------------------ requests
  request(kind: string, args: Record<string, unknown> = {}): Promise<ReqResult> {
    if (!this.state) return Promise.resolve({ ok: false, msg: 'Not in a room.' });
    if (this.isHost) return Promise.resolve(this.execute(this.selfId, kind, args));
    if (this.migrating) return Promise.resolve({ ok: false, msg: 'Host migration in progress — try again in a moment.' });
    const rid = randomId(6);
    this.net.sendJson(this.state.hostId, MSG.REQ, { rid, kind, args });
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => { this.pending.delete(rid); resolve({ ok: false, msg: 'Host did not respond (timeout).' }); }, 6000);
      this.pending.set(rid, { resolve, timer });
    });
  }
  /** Fire-and-forget request (no pending promise), used for high-rate actions. */
  notify(kind: string, args: Record<string, unknown> = {}): void {
    if (!this.state) return;
    if (this.isHost) { this.execute(this.selfId, kind, args); return; }
    this.net.sendJson(this.state.hostId, MSG.REQ, { rid: '', kind, args });
  }

  private execute(from: string, kind: string, args: any): ReqResult {
    const fn = this.handlers.get(kind);
    if (!fn) return { ok: false, msg: `Unknown action ${kind}` };
    if (!this.state?.players[from]) return { ok: false, msg: 'Not a room member.' };
    try { return fn(from, args && typeof args === 'object' ? args : {}); } catch (e) { console.error(e); return { ok: false, msg: 'Host error.' }; }
  }

  private handleReq(from: string, m: any): void {
    if (!this.isHost || typeof m.kind !== 'string') return;
    const res = this.execute(from, m.kind, m.args);
    if (m.rid) this.net.sendJson(from, MSG.RESULT, { rid: m.rid, ...res });
  }
  private handleResult(from: string, m: any): void {
    const p = this.pending.get(m.rid);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(m.rid);
    p.resolve({ ok: !!m.ok, msg: typeof m.msg === 'string' ? m.msg : undefined, data: m.data });
  }

  // ------------------------------------------------------------ chat (direct mesh, no host relay)
  sendChat(text: string, ch: 'all' | 'party'): string | null {
    const t = text.trim().slice(0, 200);
    if (!t || !this.state) return null;
    const self = this.self;
    if (!self) return null;
    let targets = Object.keys(this.state.players).filter((id) => id !== this.selfId);
    if (ch === 'party') {
      if (!self.partyId || !this.state.parties[self.partyId]) return 'You are not in a party.';
      targets = this.state.parties[self.partyId].members.filter((id) => id !== this.selfId);
    }
    const line: ChatLine = { from: this.selfId, name: self.name, ch, text: t, ts: Date.now() };
    for (const id of targets) this.net.sendJson(id, MSG.CHAT, { ch, text: t });
    this.emit('chat', line);
    return null;
  }

  private handleChat(from: string, m: any): void {
    if (!this.state || typeof m.text !== 'string') return;
    const sender = this.state.players[from];
    if (!sender) return;
    const now = performance.now();
    const hist = (this.chatRate.get(from) ?? []).filter((t) => now - t < 4000);
    if (hist.length >= 6) return; // flood protection
    hist.push(now);
    this.chatRate.set(from, hist);
    const ch = m.ch === 'party' ? 'party' : 'all';
    if (ch === 'party') {
      const me = this.self;
      if (!me?.partyId || me.partyId !== sender.partyId) return;
    }
    this.emit('chat', { from, name: sender.name, ch, text: m.text.slice(0, 200), ts: Date.now() });
  }

  systemChat(text: string): void {
    this.hostEvent({ e: 'system', text });
  }

  // ------------------------------------------------------------ host migration
  private successor(): string | null {
    if (!this.state) return null;
    const oldHost = this.state.hostId;
    for (const p of sortedPlayers(this.state)) {
      if (p.id === oldHost || this.excludedSuccessors.has(p.id)) continue;
      if (this.net.isConnected(p.id)) return p.id;
    }
    return null;
  }

  private beginMigration(reason: string): void {
    if (!this.state) return;
    this.migrating = true;
    this.excludedSuccessors.clear();
    this.emit('migrating', reason);
    this.tryMigration();
  }

  private tryMigration(): void {
    if (!this.state || !this.migrating) return;
    const next = this.successor();
    if (!next) {
      this.migrating = false;
      this.emit('migrationFailed', 'No other player is reachable. The room has closed.');
      this.leave('Host left and no successor could be reached.');
      return;
    }
    if (next === this.selfId) { this.claimHost(); return; }
    clearTimeout(this.claimTimer);
    this.claimTimer = window.setTimeout(() => {
      if (!this.migrating) return;
      this.excludedSuccessors.add(next);
      this.tryMigration();
    }, CLAIM_WAIT_MS);
  }

  private claimHost(): void {
    if (!this.state) return;
    const old = this.state.hostId;
    const staleMs = performance.now() - this.stateReceivedAt;
    this.state.epoch += 1;
    this.state.hostId = this.selfId;
    this.net.hostId = this.selfId;
    delete this.state.players[old];
    this.acks.clear();
    this.net.broadcastJson(MSG.HOST_CLAIM, { epoch: this.state.epoch, version: this.state.version, roomId: this.state.roomId });
    this.emit('migrating', 'You are taking over as host…');
    clearTimeout(this.claimTimer);
    this.claimTimer = window.setTimeout(() => this.finishClaim(old, staleMs), ACK_WAIT_MS);
  }

  private finishClaim(oldHost: string, staleMs: number): void {
    if (!this.state || this.state.hostId !== this.selfId) return;
    // Adopt the freshest snapshot any peer reported (only from the same previous epoch).
    let best: RoomState | null = null;
    for (const a of this.acks.values()) if (a.state && a.version > (best?.version ?? this.state.version)) best = a.state;
    if (best && validateRoomState(best)) {
      const epoch = this.state.epoch;
      this.state = { ...best, epoch, hostId: this.selfId };
      delete this.state.players[oldHost];
      staleMs = 0; // a peer had a fresher copy; still conservative below
    }
    // prune players that are not connected to us (they cannot be served by this host)
    for (const id of Object.keys(this.state.players)) {
      if (id !== this.selfId && !this.net.isConnected(id)) delete this.state.players[id];
    }
    for (const fn of this.hostHooks.onLeave) fn(oldHost);
    this.migrating = false;
    this.emit('hostChanged', this.selfId, true);
    for (const fn of this.hostHooks.onBecameHost) fn(staleMs);
    this.systemChat(`${this.profile.name} is now the host (epoch ${this.state.epoch}).`);
    this.commit();
  }

  private handleClaim(from: string, m: any): void {
    if (!this.state || m.roomId !== this.state.roomId || !Number.isInteger(m.epoch)) return;
    const claimant = this.state.players[from];
    if (!claimant) return;
    const curHost = this.state.players[this.state.hostId];
    const accept = m.epoch > this.state.epoch ||
      (m.epoch === this.state.epoch && this.state.hostId !== from && (!curHost || claimant.joinOrder < curHost.joinOrder));
    if (!accept) return;
    const wasHost = this.isHost;
    const old = this.state.hostId;
    const myVersion = this.state.version;
    const prevEpochState = JSON.parse(JSON.stringify(this.state)) as RoomState;
    this.state.epoch = m.epoch;
    this.state.hostId = from;
    this.net.hostId = from;
    if (old !== from && !this.net.isConnected(old)) delete this.state.players[old];
    this.migrating = false;
    clearTimeout(this.claimTimer);
    this.net.sendJson(from, MSG.HOST_ACK, { epoch: m.epoch, version: myVersion, state: myVersion > m.version ? prevEpochState : undefined });
    if (wasHost) console.warn('[room] yielded host role to', from);
    this.emit('hostChanged', from, false);
  }

  private handleAck(from: string, m: any): void {
    if (!this.isHost || !this.state || m.epoch !== this.state.epoch) return;
    this.acks.set(from, { version: m.version, state: m.state });
  }
}

export function sanitizeName(n: unknown): string {
  const s = String(n ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return s || 'Runner';
}
