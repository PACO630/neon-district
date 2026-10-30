// Full-mesh P2P transport. The host's invite links are signaled manually; every other pair of
// players is connected automatically by relaying SDP/ICE through the host over existing DataChannels.
import { PacketError, Reader } from './binary';
import { decodeFrame, encodeJson, encodePing, MSG, PROTOCOL_VERSION, randomId } from './protocol';
import { PeerLink } from './webrtc/PeerLink';
import { decodeAnswer, decodeInvite, encodeAnswer, encodeInvite } from './signaling/manual';

export type JsonHandler = (from: string, msg: any) => void;
export type BinHandler = (from: string, r: Reader) => void;

interface PendingInvite { id: string; link: PeerLink; code: string; created: number; status: 'waiting' | 'connecting' | 'joined' | 'failed'; joinerName?: string }

const HEARTBEAT_MS = 1000;
const TIMEOUT_MS = 6000;
const MAX_PEERS = 9;

export class Net {
  readonly selfId = randomId(8);
  selfName = 'Runner';
  roomId = '';
  hostId = '';
  readonly links = new Map<string, PeerLink>();
  readonly invites = new Map<string, PendingInvite>();
  private jsonHandlers = new Map<number, JsonHandler[]>();
  private binHandlers = new Map<number, BinHandler[]>();
  private heartbeat = 0;
  private joinLink: PeerLink | null = null;
  bytesIn = 0;
  bytesOut = 0;
  /** Invoked when a link to an identified peer opens / closes. */
  onPeerOpen: (id: string) => void = () => {};
  onPeerClose: (id: string, reason: string) => void = () => {};
  /** Host-side: a peer joined via an invite and identified itself. */
  onInviteJoined: (id: string, info: any) => void = () => {};
  /** Client-side: the join link to the host opened. */
  onJoined: () => void = () => {};
  onInvitesChanged: () => void = () => {};
  /** Asked when an IDENT arrives on an invite link; return a reason string to refuse. */
  admit: (info: any) => string | null = () => null;

  constructor() {
    this.onJson(MSG.SIG, (from, m) => this.handleSig(from, m));
    this.onJson(MSG.CONNECT_TO, (from, m) => { if (from === this.hostId && typeof m.id === 'string') this.connectTo(m.id); });
    this.onBin(MSG.PING, (from, r) => { const t = r.f64(); this.links.get(from)?.send(encodePing(MSG.PONG, t), false); });
    this.onBin(MSG.PONG, (from, r) => {
      const l = this.links.get(from);
      const t = r.f64();
      if (l) l.rtt = l.rtt ? l.rtt * 0.8 + (performance.now() - t) * 0.2 : performance.now() - t;
    });
  }

  get isHost(): boolean { return this.hostId === this.selfId; }

  start(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = window.setInterval(() => this.tickHeartbeat(), HEARTBEAT_MS);
  }

  shutdown(): void {
    clearInterval(this.heartbeat);
    for (const l of this.links.values()) { l.send(encodeJson(MSG.BYE, { reason: 'leave' }), true); }
    const all = [...this.links.values(), ...[...this.invites.values()].map((i) => i.link)];
    if (this.joinLink) all.push(this.joinLink);
    this.links.clear();
    this.invites.clear();
    this.joinLink = null;
    for (const l of all) { l.onClose = () => {}; l.close('shutdown'); }
    this.roomId = '';
    this.hostId = '';
  }

  // ------------------------------------------------------------- handlers
  onJson(type: number, fn: JsonHandler): () => void {
    const list = this.jsonHandlers.get(type) ?? [];
    list.push(fn);
    this.jsonHandlers.set(type, list);
    return () => list.splice(list.indexOf(fn), 1);
  }
  onBin(type: number, fn: BinHandler): () => void {
    const list = this.binHandlers.get(type) ?? [];
    list.push(fn);
    this.binHandlers.set(type, list);
    return () => list.splice(list.indexOf(fn), 1);
  }

  private dispatch(link: PeerLink, data: ArrayBuffer): void {
    this.bytesIn += data.byteLength;
    let d;
    try { d = decodeFrame(data); } catch (e) { console.warn('[net] dropped packet from', link.remoteId, (e as Error).message); return; }
    if (d.type === MSG.IDENT) { this.handleIdent(link, d.json); return; }
    if (!link.identified || !link.remoteId) return; // nothing is accepted before identification
    const from = link.remoteId;
    if (d.type === MSG.BYE) { link.close('peer left'); return; }
    try {
      if (d.json) for (const fn of this.jsonHandlers.get(d.type) ?? []) fn(from, d.json);
      else if (d.reader) {
        for (const fn of this.binHandlers.get(d.type) ?? []) {
          // each handler gets its own reader positioned after the type byte
          const r = new Reader(data);
          r.u8r();
          fn(from, r);
        }
      }
    } catch (e) {
      if (e instanceof PacketError) console.warn('[net] invalid payload', d.type, e.message);
      else console.error(e);
    }
  }

  // ------------------------------------------------------------- sending
  send(to: string, data: ArrayBuffer, reliable = true): boolean {
    const l = this.links.get(to);
    if (!l) return false;
    const ok = l.send(data, reliable);
    if (ok) this.bytesOut += data.byteLength;
    return ok;
  }
  sendJson(to: string, type: number, payload: unknown): boolean {
    return this.send(to, encodeJson(type as any, payload), true);
  }
  broadcast(data: ArrayBuffer, reliable = true, except?: string): void {
    for (const [id, l] of this.links) if (id !== except && l.identified) { if (l.send(data, reliable)) this.bytesOut += data.byteLength; }
  }
  broadcastJson(type: number, payload: unknown, except?: string): void {
    this.broadcast(encodeJson(type as any, payload), true, except);
  }
  isConnected(id: string): boolean {
    if (id === this.selfId) return true;
    const l = this.links.get(id);
    return !!l && l.state === 'open' && l.identified;
  }
  rtt(id: string): number { return this.links.get(id)?.rtt ?? 0; }
  peerIds(): string[] { return [...this.links.keys()].filter((id) => this.isConnected(id)); }

  // ------------------------------------------------------------- link wiring
  private wire(link: PeerLink): void {
    link.onMessage = (l, data) => this.dispatch(l, data);
    link.onOpen = (l) => {
      l.send(encodeJson(MSG.IDENT, { v: PROTOCOL_VERSION, id: this.selfId, name: this.selfName, room: this.roomId, info: this.identInfo() }), true);
    };
    link.onClose = (l, reason) => {
      for (const inv of this.invites.values()) if (inv.link === l && inv.status !== 'joined') { inv.status = 'failed'; this.onInvitesChanged(); }
      if (l.remoteId && this.links.get(l.remoteId) === l) {
        this.links.delete(l.remoteId);
        if (l.identified) this.onPeerClose(l.remoteId, reason);
      }
    };
  }

  /** Extra data sent in IDENT (player profile). Set by the room layer. */
  identInfo: () => any = () => ({});

  private handleIdent(link: PeerLink, m: any): void {
    if (link.identified) return;
    if (m.v !== PROTOCOL_VERSION || typeof m.id !== 'string' || typeof m.name !== 'string' || m.id.length > 16) { link.close('bad ident'); return; }
    if (link.remoteId && link.remoteId !== m.id) { link.close('identity mismatch'); return; }
    if (this.roomId && m.room && m.room !== this.roomId) { link.close('wrong room'); return; }
    // Invite link on host side: run admission
    const inv = [...this.invites.values()].find((i) => i.link === link);
    if (inv) {
      const refuse = this.links.size >= MAX_PEERS ? 'Room is full (10 players).' : this.admit(m);
      if (refuse) {
        link.send(encodeJson(MSG.BYE, { reason: refuse }), true);
        setTimeout(() => link.close('refused'), 300);
        inv.status = 'failed';
        this.onInvitesChanged();
        return;
      }
    }
    link.remoteId = m.id;
    link.remoteName = String(m.name).slice(0, 24);
    link.identified = true;
    const old = this.links.get(m.id);
    if (old && old !== link) { old.onClose = () => {}; old.close('replaced'); }
    this.links.set(m.id, link);
    if (inv) { inv.status = 'joined'; inv.joinerName = link.remoteName; this.onInvitesChanged(); this.onInviteJoined(m.id, m); }
    if (link === this.joinLink) { this.joinLink = null; this.onJoined(); }
    this.onPeerOpen(m.id);
  }

  // ------------------------------------------------------------- host: manual invites
  async createInvite(): Promise<PendingInvite> {
    const link = new PeerLink(false);
    this.wire(link);
    const offer = await link.createOffer();
    const id = randomId(6);
    const code = await encodeInvite({ room: this.roomId, host: this.selfId, hostName: this.selfName, inv: id, sdp: offer.sdp! });
    const inv: PendingInvite = { id, link, code, created: Date.now(), status: 'waiting' };
    this.invites.set(id, inv);
    this.onInvitesChanged();
    return inv;
  }

  async acceptReply(code: string): Promise<string> {
    const a = await decodeAnswer(code);
    if (a.room !== this.roomId) throw new Error('That reply belongs to a different room.');
    const inv = this.invites.get(a.inv);
    if (!inv) throw new Error('No matching invite. It may have been cancelled — create a new one.');
    if (inv.status !== 'waiting') throw new Error(`This invite was already ${inv.status === 'joined' ? 'used' : inv.status}. Create a new invite.`);
    inv.link.remoteId = a.id;
    inv.status = 'connecting';
    inv.joinerName = a.name;
    this.onInvitesChanged();
    await inv.link.acceptAnswer({ type: 'answer', sdp: a.sdp });
    setTimeout(() => {
      if (inv.status === 'connecting') { inv.status = 'failed'; inv.link.close('timeout'); this.onInvitesChanged(); }
    }, 20000);
    return a.name;
  }

  cancelInvite(id: string): void {
    const inv = this.invites.get(id);
    if (!inv) return;
    if (inv.status !== 'joined') { inv.link.onClose = () => {}; inv.link.close('cancelled'); }
    this.invites.delete(id);
    this.onInvitesChanged();
  }

  // ------------------------------------------------------------- joiner
  async answerInvite(code: string): Promise<{ answer: string; hostName: string; room: string; host: string }> {
    const inv = await decodeInvite(code);
    if (Date.now() - inv.t > 1000 * 60 * 60 * 6) throw new Error('This invite is older than 6 hours and has almost certainly expired. Ask the host for a new one.');
    this.joinLink?.close('replaced');
    const link = new PeerLink(false);
    link.remoteId = inv.host;
    this.roomId = inv.room;
    this.hostId = inv.host;
    this.wire(link);
    this.joinLink = link;
    const answer = await link.acceptOffer({ type: 'offer', sdp: inv.sdp });
    const code2 = await encodeAnswer({ room: inv.room, inv: inv.inv, id: this.selfId, name: this.selfName, sdp: answer.sdp! });
    return { answer: code2, hostName: inv.hostName, room: inv.room, host: inv.host };
  }

  cancelJoin(): void {
    if (this.joinLink) { this.joinLink.onClose = () => {}; this.joinLink.close('cancelled'); this.joinLink = null; }
  }

  // ------------------------------------------------------------- mesh via relayed signaling
  /** Called on an existing peer (instructed by the host) to open a direct link to a newcomer. */
  async connectTo(id: string): Promise<void> {
    if (id === this.selfId || this.isConnected(id)) return;
    const link = new PeerLink(true);
    link.remoteId = id;
    this.wire(link);
    this.links.set(id, link);
    link.onCandidate = (c) => this.sendSig(id, 'cand', c);
    const offer = await link.createOffer();
    this.sendSig(id, 'offer', offer);
    setTimeout(() => { if (link.state !== 'open') link.close('mesh timeout'); }, 20000);
  }

  private sendSig(to: string, kind: string, data: unknown): void {
    const payload = { from: this.selfId, to, kind, data };
    if (this.isHost || !this.isConnected(this.hostId)) { this.sendJson(to, MSG.SIG, payload); }
    else this.sendJson(this.hostId, MSG.SIG, payload);
  }

  private async handleSig(from: string, m: any): Promise<void> {
    if (typeof m.to !== 'string' || typeof m.kind !== 'string') return;
    if (m.to !== this.selfId) {
      // only the host relays, and it stamps the true sender
      if (this.isHost) this.sendJson(m.to, MSG.SIG, { ...m, from });
      return;
    }
    const origin = from === this.hostId && typeof m.from === 'string' ? m.from : from;
    let link = this.links.get(origin);
    if (m.kind === 'offer') {
      if (link && link.state === 'open') return;
      if (link) { link.onClose = () => {}; link.close('re-offer'); }
      link = new PeerLink(true);
      link.remoteId = origin;
      this.wire(link);
      this.links.set(origin, link);
      link.onCandidate = (c) => this.sendSig(origin, 'cand', c);
      const answer = await link.acceptOffer(m.data);
      this.sendSig(origin, 'answer', answer);
    } else if (m.kind === 'answer' && link) {
      try { await link.acceptAnswer(m.data); } catch { /* duplicate */ }
    } else if (m.kind === 'cand' && link) {
      await link.addCandidate(m.data);
    }
  }

  // ------------------------------------------------------------- heartbeat
  private tickHeartbeat(): void {
    const now = performance.now();
    for (const l of [...this.links.values()]) {
      if (l.state !== 'open') continue;
      // A background tab may only run this timer once a minute, so wall-clock silence alone is not
      // proof of a dead peer: require several consecutive unanswered heartbeats as well.
      if (now - l.lastHeard > TIMEOUT_MS && l.unanswered >= TIMEOUT_MS / HEARTBEAT_MS) { l.close('heartbeat timeout'); continue; }
      l.unanswered++;
      l.send(encodePing(MSG.PING, now), true);
    }
  }
}
