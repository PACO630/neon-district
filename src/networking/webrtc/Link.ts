// What the mesh layer needs from a connection to one remote player. Implemented by PeerLink
// (manual-signaling WebRTC) and RelayLink (WebRTC paired through public relays by room code).
export type LinkState = 'new' | 'connecting' | 'open' | 'closed';

export interface Link {
  remoteId: string | null;
  remoteName: string;
  state: LinkState;
  rtt: number;
  lastHeard: number;
  unanswered: number;
  identified: boolean;
  onOpen: (link: Link) => void;
  onClose: (link: Link, reason: string) => void;
  onMessage: (link: Link, data: ArrayBuffer, reliable: boolean) => void;
  send(data: ArrayBuffer, reliable: boolean): boolean;
  close(reason?: string): void;
  routeInfo(): Promise<string>;
}
