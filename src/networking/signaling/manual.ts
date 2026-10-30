// Manual (copy / paste / QR / file) signaling. There is no signaling server: the host's offer and the
// joiner's answer must be carried between the two devices by the players themselves.
import { packText, unpackText } from '../binary';
import { PROTOCOL_VERSION } from '../protocol';

export interface InvitePayload {
  v: number;
  k: 'offer';
  room: string;
  host: string;
  hostName: string;
  inv: string;
  sdp: string;
  t: number;
}
export interface AnswerPayload {
  v: number;
  k: 'answer';
  room: string;
  inv: string;
  id: string;
  name: string;
  sdp: string;
}

const OFFER_PREFIX = 'NDX-INVITE.';
const ANSWER_PREFIX = 'NDX-REPLY.';

export async function encodeInvite(p: Omit<InvitePayload, 'v' | 'k' | 't'>): Promise<string> {
  return OFFER_PREFIX + (await packText(JSON.stringify({ ...p, v: PROTOCOL_VERSION, k: 'offer', t: Date.now() })));
}
export async function encodeAnswer(p: Omit<AnswerPayload, 'v' | 'k'>): Promise<string> {
  return ANSWER_PREFIX + (await packText(JSON.stringify({ ...p, v: PROTOCOL_VERSION, k: 'answer' })));
}

function clean(code: string): string {
  return code.trim().replace(/\s+/g, '');
}

export async function decodeInvite(code: string): Promise<InvitePayload> {
  const c = clean(code);
  if (c.startsWith(ANSWER_PREFIX)) throw new Error('This is a REPLY code. Paste it on the host device, not here.');
  if (!c.startsWith(OFFER_PREFIX)) throw new Error('Not a NEON DISTRICT invite code.');
  let p: InvitePayload;
  try { p = JSON.parse(await unpackText(c.slice(OFFER_PREFIX.length))); } catch { throw new Error('Invite code is damaged or incomplete. Copy the full code again.'); }
  if (p.k !== 'offer' || typeof p.sdp !== 'string' || typeof p.room !== 'string') throw new Error('Invite code is malformed.');
  if (p.v !== PROTOCOL_VERSION) throw new Error(`Version mismatch (invite v${p.v}, this client v${PROTOCOL_VERSION}). Reload both devices.`);
  return p;
}

export async function decodeAnswer(code: string): Promise<AnswerPayload> {
  const c = clean(code);
  if (c.startsWith(OFFER_PREFIX)) throw new Error('This is an INVITE code. The joining player must paste it, then send you their REPLY code.');
  if (!c.startsWith(ANSWER_PREFIX)) throw new Error('Not a NEON DISTRICT reply code.');
  let p: AnswerPayload;
  try { p = JSON.parse(await unpackText(c.slice(ANSWER_PREFIX.length))); } catch { throw new Error('Reply code is damaged or incomplete.'); }
  if (p.k !== 'answer' || typeof p.sdp !== 'string' || typeof p.id !== 'string') throw new Error('Reply code is malformed.');
  if (p.v !== PROTOCOL_VERSION) throw new Error('Version mismatch between devices. Reload both.');
  return p;
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function pickTextFile(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.ndx,text/plain';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return reject(new Error('No file selected'));
      if (f.size > 64 * 1024) return reject(new Error('File too large to be an invite'));
      resolve(await f.text());
    };
    input.click();
  });
}
