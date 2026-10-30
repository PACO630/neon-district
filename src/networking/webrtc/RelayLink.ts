// Room-code connections. Trystero finds the other players of a room through public Nostr relays
// (free shared WebSocket relays, nothing self-hosted) and then opens a direct WebRTC connection;
// game traffic never goes through the relays. Each remote player becomes a RelayLink with the same
// interface as a manually signaled PeerLink, so the room / host / migration logic is unchanged.
import { joinRoom, type Room as TRoom } from 'trystero';
import type { Link, LinkState } from './Link';
import { ICE_SERVERS } from './PeerLink';

export const TRYSTERO_APP_ID = 'neon-district-p2p-v3';

export class RelayLink implements Link {
  remoteId: string | null = null;
  remoteName = '';
  state: LinkState = 'new';
  rtt = 0;
  lastHeard = performance.now();
  unanswered = 0;
  identified = false;
  onOpen: (link: Link) => void = () => {};
  onClose: (link: Link, reason: string) => void = () => {};
  onMessage: (link: Link, data: ArrayBuffer, reliable: boolean) => void = () => {};

  constructor(readonly peerId: string, private sendFn: (data: ArrayBuffer, peerId: string) => Promise<void>, private pcOf: () => RTCPeerConnection | undefined) {}

  open(): void {
    if (this.state !== 'new') return;
    this.state = 'open';
    this.lastHeard = performance.now();
    this.onOpen(this);
  }

  deliver(data: ArrayBuffer): void {
    if (this.state !== 'open') return;
    this.lastHeard = performance.now();
    this.unanswered = 0;
    this.onMessage(this, data, true);
  }

  send(data: ArrayBuffer, _reliable: boolean): boolean {
    if (this.state !== 'open') return false;
    // Trystero's channel is reliable/ordered; it is used for every message type
    this.sendFn(data, this.peerId).catch(() => {});
    return true;
  }

  close(reason = 'closed'): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.onClose(this, reason);
  }

  async routeInfo(): Promise<string> {
    const pc = this.pcOf();
    if (!pc) return 'P2P (room code)';
    try {
      const stats = await pc.getStats();
      let type = '';
      stats.forEach((s: any) => {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') type = stats.get(s.localCandidateId)?.candidateType ?? '';
      });
      return type === 'host' ? 'LAN direct' : type === 'relay' ? 'TURN relay' : 'NAT traversal (STUN)';
    } catch { return 'P2P (room code)'; }
  }
}

/** A Trystero room for one room code; creates a RelayLink per remote player. */
export class CodeRoom {
  private room: TRoom;
  private links = new Map<string, RelayLink>();
  private send: (data: ArrayBuffer, opts?: { target?: string }) => Promise<void>;

  constructor(code: string, onLink: (link: RelayLink) => void) {
    this.room = joinRoom({ appId: TRYSTERO_APP_ID, rtcConfig: { iceServers: ICE_SERVERS } }, code);
    const action = this.room.makeAction<ArrayBuffer>('nd');
    this.send = (data, opts) => action.send(data, opts);
    action.onMessage = (data, { peerId }) => {
      let buf: ArrayBuffer | null = null;
      if (data instanceof ArrayBuffer) buf = data;
      else if (ArrayBuffer.isView(data)) buf = (data as ArrayBufferView).buffer.slice((data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteOffset + (data as ArrayBufferView).byteLength) as ArrayBuffer;
      if (buf) this.links.get(peerId)?.deliver(buf);
    };
    this.room.onPeerJoin = (peerId) => {
      if (this.links.has(peerId)) return;
      const link = new RelayLink(peerId, (d, p) => this.send(d, { target: p }), () => this.room.getPeers()[peerId]);
      this.links.set(peerId, link);
      onLink(link);
      link.open();
    };
    this.room.onPeerLeave = (peerId) => {
      const l = this.links.get(peerId);
      this.links.delete(peerId);
      l?.close('peer left');
    };
  }

  leave(): void {
    for (const l of this.links.values()) { l.onClose = () => {}; l.close('leave'); }
    this.links.clear();
    this.room.leave().catch(() => {});
  }
}

/** Short, unambiguous room codes (no 0/O/1/I/L). */
export function newRoomCode(len = 6): string {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const r = new Uint8Array(len);
  crypto.getRandomValues(r);
  return Array.from(r, (b) => A[b % A.length]).join('');
}

export function normalizeRoomCode(input: string): string {
  // accept pasted links (…#room=ABC123) as well as bare codes typed in any case
  const m = input.match(/room=([A-Za-z0-9]+)/);
  return (m ? m[1] : input).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}
