// One RTCPeerConnection to one remote player, with a reliable ordered channel and an
// unreliable unordered channel (maxRetransmits: 0). Both are pre-negotiated so no extra
// signaling round trip is needed for the channels themselves.

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export type LinkState = 'new' | 'connecting' | 'open' | 'closed';

export class PeerLink {
  readonly pc: RTCPeerConnection;
  readonly rel: RTCDataChannel;
  readonly unrel: RTCDataChannel;
  remoteId: string | null = null;
  remoteName = '';
  state: LinkState = 'new';
  rtt = 0;
  lastHeard = performance.now();
  /** heartbeats sent since we last heard anything; robust to throttled timers in background tabs */
  unanswered = 0;
  identified = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private openCount = 0;

  onOpen: (link: PeerLink) => void = () => {};
  onClose: (link: PeerLink, reason: string) => void = () => {};
  onMessage: (link: PeerLink, data: ArrayBuffer, reliable: boolean) => void = () => {};
  onCandidate: ((c: RTCIceCandidateInit) => void) | null = null;

  constructor(readonly trickle: boolean) {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: trickle ? 0 : 2 });
    this.rel = this.pc.createDataChannel('rel', { negotiated: true, id: 0, ordered: true });
    this.unrel = this.pc.createDataChannel('unrel', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    for (const [ch, reliable] of [[this.rel, true], [this.unrel, false]] as const) {
      ch.binaryType = 'arraybuffer';
      ch.onopen = () => {
        this.openCount++;
        if (this.openCount === 2 && this.state !== 'closed') {
          this.state = 'open';
          this.lastHeard = performance.now();
          this.onOpen(this);
        }
      };
      ch.onclose = () => this.close('channel closed');
      ch.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return; // only binary frames are valid
        this.lastHeard = performance.now();
        this.unanswered = 0;
        this.onMessage(this, ev.data, reliable);
      };
    }
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate && this.trickle && this.onCandidate) this.onCandidate(ev.candidate.toJSON());
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed') this.close(`connection ${s}`);
    };
  }

  /** Waits for ICE gathering to complete (non-trickle invites) with a safety timeout. */
  private waitIce(timeoutMs = 6000): Promise<void> {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { this.pc.removeEventListener('icegatheringstatechange', check); clearTimeout(timer); resolve(); };
      const check = () => { if (this.pc.iceGatheringState === 'complete') done(); };
      const timer = setTimeout(done, timeoutMs);
      this.pc.addEventListener('icegatheringstatechange', check);
    });
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.state = 'connecting';
    await this.pc.setLocalDescription(await this.pc.createOffer());
    if (!this.trickle) await this.waitIce();
    return this.pc.localDescription!.toJSON();
  }

  async acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    this.state = 'connecting';
    await this.pc.setRemoteDescription(offer);
    this.remoteSet = true;
    await this.flushCandidates();
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    if (!this.trickle) await this.waitIce();
    return this.pc.localDescription!.toJSON();
  }

  async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (this.pc.signalingState !== 'have-local-offer') throw new Error('This invite was already used or expired.');
    await this.pc.setRemoteDescription(answer);
    this.remoteSet = true;
    await this.flushCandidates();
  }

  async addCandidate(c: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteSet) { this.pendingCandidates.push(c); return; }
    try { await this.pc.addIceCandidate(c); } catch { /* stale candidate */ }
  }

  private async flushCandidates(): Promise<void> {
    const list = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of list) { try { await this.pc.addIceCandidate(c); } catch { /* ignore */ } }
  }

  send(data: ArrayBuffer, reliable: boolean): boolean {
    if (this.state !== 'open') return false;
    const ch = reliable ? this.rel : this.unrel;
    if (ch.readyState !== 'open') return false;
    // Drop unreliable traffic under congestion instead of queueing stale positions.
    if (!reliable && ch.bufferedAmount > 64 * 1024) return false;
    if (reliable && ch.bufferedAmount > 8 * 1024 * 1024) { this.close('send buffer overflow'); return false; }
    try { ch.send(data); return true; } catch { return false; }
  }

  close(reason = 'closed'): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    try { this.rel.close(); this.unrel.close(); this.pc.close(); } catch { /* ignore */ }
    this.onClose(this, reason);
  }

  /** Describes the selected candidate pair (direct / via STUN-reflexive / relay) for diagnostics. */
  async routeInfo(): Promise<string> {
    try {
      const stats = await this.pc.getStats();
      let pairId = '';
      stats.forEach((s: any) => { if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId; });
      let local = '';
      stats.forEach((s: any) => {
        if ((s.type === 'candidate-pair' && (s.id === pairId || (!pairId && s.nominated && s.state === 'succeeded')))) {
          const lc = stats.get(s.localCandidateId);
          local = lc?.candidateType ?? '';
        }
      });
      return local === 'host' ? 'LAN direct' : local === 'srflx' || local === 'prflx' ? 'NAT traversal (STUN)' : local || 'unknown';
    } catch { return 'unknown'; }
  }
}
