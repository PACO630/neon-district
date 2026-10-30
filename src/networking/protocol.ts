import { PacketError, Reader, Writer } from './binary';
import type { WeaponId, GrenadeId } from '../config/weapons';

/** Message type ids (first byte of every DataChannel frame). */
export const MSG = {
  // JSON-in-binary (reliable channel)
  IDENT: 1, ROOM_STATE: 2, SIG: 3, CHAT: 4, REQ: 5, RESULT: 6, EVENT: 7,
  HOST_CLAIM: 8, HOST_ACK: 9, STATE_REQ: 10, STATE_RES: 11, BYE: 12, CONNECT_TO: 13, CORRECTION: 14,
  // compact binary
  PING: 32, PONG: 33, CITY_STATE: 34, ARENA_INPUT: 35, ARENA_SNAP: 36, FIRE: 37, SHOT_FX: 38,
} as const;
export type MsgType = (typeof MSG)[keyof typeof MSG];
const JSON_TYPES = new Set<number>([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
const BIN_TYPES = new Set<number>([32, 33, 34, 35, 36, 37, 38]);

export const PROTOCOL_VERSION = 3;
export const MAX_FRAME = 256 * 1024;

export function encodeJson(type: MsgType, payload: unknown): ArrayBuffer {
  return new Writer(128).u8w(type).text(JSON.stringify(payload)).finish();
}

export interface Decoded { type: number; json?: any; reader?: Reader }

export function decodeFrame(buf: ArrayBuffer): Decoded {
  if (buf.byteLength < 1 || buf.byteLength > MAX_FRAME) throw new PacketError('bad frame size');
  const r = new Reader(buf);
  const type = r.u8r();
  if (JSON_TYPES.has(type)) {
    const json = JSON.parse(r.text(MAX_FRAME));
    if (json === null || typeof json !== 'object') throw new PacketError('payload not object');
    return { type, json };
  }
  if (BIN_TYPES.has(type)) return { type, reader: r };
  throw new PacketError(`unknown message type ${type}`);
}

// ---------------------------------------------------------------- equipped item codes
export const ITEM_CODES: (WeaponId | GrenadeId | 'c4')[] = ['knife', 'p12', 'vx9', 'wasp', 'kestrel', 'raptor', 'longbow', 'breacher', 'smoke', 'flash', 'molotov', 'c4'];
export const itemCode = (id: string): number => Math.max(0, ITEM_CODES.indexOf(id as WeaponId));
export const itemFromCode = (c: number): string => ITEM_CODES[c] ?? 'knife';

// ---------------------------------------------------------------- animation codes
export const ANIM = { idle: 0, walk: 1, run: 2, jump: 3, crouch: 4, crouchWalk: 5, sit: 6, drink: 7, wave: 8, dance: 9, die: 10, plant: 11 } as const;
export type AnimName = keyof typeof ANIM;
export const ANIM_NAMES = Object.keys(ANIM) as AnimName[];

// ---------------------------------------------------------------- ping
export const encodePing = (type: 32 | 33, t: number) => new Writer(16).u8w(type).f64(t).finish();

// ---------------------------------------------------------------- city state (peer → all peers, unreliable)
export interface CityState { seq: number; x: number; y: number; z: number; yaw: number; anim: number; flags: number }
export function encodeCity(s: CityState): ArrayBuffer {
  return new Writer(24).u8w(MSG.CITY_STATE).u16(s.seq).f32(s.x).f32(s.y).f32(s.z).angle(s.yaw).u8w(s.anim).u8w(s.flags).finish();
}
export function decodeCity(r: Reader): CityState {
  const s = { seq: r.u16(), x: r.f32(), y: r.f32(), z: r.f32(), yaw: r.angle(), anim: r.u8r(), flags: r.u8r() };
  if (Math.abs(s.x) > 2000 || Math.abs(s.y) > 500 || Math.abs(s.z) > 2000 || s.anim > 11) throw new PacketError('city state out of range');
  return s;
}

// ---------------------------------------------------------------- arena input (client → host, unreliable)
export const IN_CROUCH = 1, IN_WALK = 2, IN_AIR = 4, IN_ADS = 8;
export interface ArenaInput { seq: number; ack: number; x: number; y: number; z: number; yaw: number; pitch: number; flags: number; item: number; anim: number }
export function encodeArenaInput(s: ArenaInput): ArrayBuffer {
  return new Writer(32).u8w(MSG.ARENA_INPUT).u16(s.seq).u16(s.ack).f32(s.x).f32(s.y).f32(s.z).angle(s.yaw)
    .i16(s.pitch * 10000).u8w(s.flags).u8w(s.item).u8w(s.anim).finish();
}
export function decodeArenaInput(r: Reader): ArenaInput {
  const s = { seq: r.u16(), ack: r.u16(), x: r.f32(), y: r.f32(), z: r.f32(), yaw: r.angle(), pitch: r.i16() / 10000, flags: r.u8r(), item: r.u8r(), anim: r.u8r() };
  if (Math.abs(s.x) > 500 || Math.abs(s.y) > 200 || Math.abs(s.z) > 500 || s.item >= ITEM_CODES.length || s.anim > 11) throw new PacketError('input out of range');
  return s;
}

// ---------------------------------------------------------------- arena snapshot (host → client, unreliable, delta compressed)
export interface NetPlayer { order: number; x: number; y: number; z: number; yaw: number; pitch: number; anim: number; flags: number; hp: number; armor: number; item: number; alive: number }
export interface NetProjectile { id: number; type: number; x: number; y: number; z: number }
export interface Snapshot { seq: number; base: number; phaseRemaining: number; actionProgress: number; players: Map<number, NetPlayer>; projectiles: NetProjectile[] }

const F_POS = 1, F_ROT = 2, F_ANIM = 4, F_VITAL = 8, F_ITEM = 16, F_ALIVE = 32;
export const NO_BASE = 0xffff;

function diffMask(a: NetPlayer | undefined, b: NetPlayer): number {
  if (!a) return F_POS | F_ROT | F_ANIM | F_VITAL | F_ITEM | F_ALIVE;
  let m = 0;
  if (Math.abs(a.x - b.x) > 0.003 || Math.abs(a.y - b.y) > 0.003 || Math.abs(a.z - b.z) > 0.003) m |= F_POS;
  if (Math.abs(a.yaw - b.yaw) > 0.001 || Math.abs(a.pitch - b.pitch) > 0.001) m |= F_ROT;
  if (a.anim !== b.anim || a.flags !== b.flags) m |= F_ANIM;
  if (a.hp !== b.hp || a.armor !== b.armor) m |= F_VITAL;
  if (a.item !== b.item) m |= F_ITEM;
  if (a.alive !== b.alive) m |= F_ALIVE;
  return m;
}

/** Encode `snap` as a delta against `baseline` (or full when baseline is undefined). */
export function encodeSnapshot(snap: Snapshot, baseline: Snapshot | undefined): ArrayBuffer {
  const w = new Writer(256).u8w(MSG.ARENA_SNAP).u16(snap.seq).u16(baseline ? baseline.seq : NO_BASE)
    .f32(snap.phaseRemaining).u8w(Math.round(snap.actionProgress * 255));
  const entries: [NetPlayer, number][] = [];
  for (const p of snap.players.values()) {
    const m = diffMask(baseline?.players.get(p.order), p);
    if (m) entries.push([p, m]);
  }
  // players present in baseline but gone now
  const removed: number[] = [];
  if (baseline) for (const o of baseline.players.keys()) if (!snap.players.has(o)) removed.push(o);
  w.u8w(entries.length);
  for (const [p, m] of entries) {
    w.u8w(p.order).u8w(m);
    if (m & F_POS) w.f32(p.x).f32(p.y).f32(p.z);
    if (m & F_ROT) w.angle(p.yaw).i16(p.pitch * 10000);
    if (m & F_ANIM) w.u8w(p.anim).u8w(p.flags);
    if (m & F_VITAL) w.u8w(p.hp).u8w(p.armor);
    if (m & F_ITEM) w.u8w(p.item);
    if (m & F_ALIVE) w.u8w(p.alive);
  }
  w.u8w(removed.length);
  for (const o of removed) w.u8w(o);
  w.u8w(snap.projectiles.length);
  for (const pr of snap.projectiles) w.u16(pr.id).u8w(pr.type).f32(pr.x).f32(pr.y).f32(pr.z);
  return w.finish();
}

/** Decode and reconstruct a full snapshot. Returns null when the baseline is unknown (dropped). */
export function decodeSnapshot(r: Reader, history: Map<number, Snapshot>): Snapshot | null {
  const seq = r.u16();
  const baseSeq = r.u16();
  const phaseRemaining = r.f32();
  const actionProgress = r.u8r() / 255;
  let base: Snapshot | undefined;
  if (baseSeq !== NO_BASE) {
    base = history.get(baseSeq);
    if (!base) return null;
  }
  const players = new Map<number, NetPlayer>();
  if (base) for (const [k, v] of base.players) players.set(k, { ...v });
  const n = r.u8r();
  if (n > 10) throw new PacketError('too many entries');
  for (let i = 0; i < n; i++) {
    const order = r.u8r();
    const m = r.u8r();
    const p: NetPlayer = players.get(order) ?? { order, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, anim: 0, flags: 0, hp: 100, armor: 0, item: 0, alive: 1 };
    if (m & F_POS) { p.x = r.f32(); p.y = r.f32(); p.z = r.f32(); }
    if (m & F_ROT) { p.yaw = r.angle(); p.pitch = r.i16() / 10000; }
    if (m & F_ANIM) { p.anim = r.u8r(); p.flags = r.u8r(); }
    if (m & F_VITAL) { p.hp = r.u8r(); p.armor = r.u8r(); }
    if (m & F_ITEM) p.item = r.u8r();
    if (m & F_ALIVE) p.alive = r.u8r();
    players.set(order, p);
  }
  const removed = r.u8r();
  for (let i = 0; i < removed; i++) players.delete(r.u8r());
  const pc = r.u8r();
  const projectiles: NetProjectile[] = [];
  for (let i = 0; i < pc; i++) projectiles.push({ id: r.u16(), type: r.u8r(), x: r.f32(), y: r.f32(), z: r.f32() });
  return { seq, base: baseSeq, phaseRemaining, actionProgress, players, projectiles };
}

/** Sequence comparison with 16-bit wraparound. */
export const seqNewer = (a: number, b: number) => ((a - b + 65536) % 65536) < 32768 && a !== b;

// ---------------------------------------------------------------- fire (client → host, reliable)
export interface FireMsg { shot: number; item: number; ox: number; oy: number; oz: number; dirs: [number, number, number][] }
export function encodeFire(f: FireMsg): ArrayBuffer {
  const w = new Writer(64).u8w(MSG.FIRE).u16(f.shot).u8w(f.item).f32(f.ox).f32(f.oy).f32(f.oz).u8w(f.dirs.length);
  for (const d of f.dirs) w.f32(d[0]).f32(d[1]).f32(d[2]);
  return w.finish();
}
export function decodeFire(r: Reader): FireMsg {
  const f: FireMsg = { shot: r.u16(), item: r.u8r(), ox: r.f32(), oy: r.f32(), oz: r.f32(), dirs: [] };
  const n = r.u8r();
  if (n < 1 || n > 12) throw new PacketError('bad pellet count');
  for (let i = 0; i < n; i++) {
    const d: [number, number, number] = [r.f32(), r.f32(), r.f32()];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 0.9 || len > 1.1) throw new PacketError('direction not normalized');
    f.dirs.push(d);
  }
  return f;
}

// ---------------------------------------------------------------- shot fx (host → peers, unreliable)
export interface ShotFx { order: number; item: number; ox: number; oy: number; oz: number; hits: { x: number; y: number; z: number; kind: number }[] }
export function encodeShotFx(s: ShotFx): ArrayBuffer {
  const w = new Writer(64).u8w(MSG.SHOT_FX).u8w(s.order).u8w(s.item).f32(s.ox).f32(s.oy).f32(s.oz).u8w(s.hits.length);
  for (const h of s.hits) w.f32(h.x).f32(h.y).f32(h.z).u8w(h.kind);
  return w.finish();
}
export function decodeShotFx(r: Reader): ShotFx {
  const s: ShotFx = { order: r.u8r(), item: r.u8r(), ox: r.f32(), oy: r.f32(), oz: r.f32(), hits: [] };
  const n = r.u8r();
  if (n > 12) throw new PacketError('too many hits');
  for (let i = 0; i < n; i++) s.hits.push({ x: r.f32(), y: r.f32(), z: r.f32(), kind: r.u8r() });
  return s;
}

/** Generates short random ids (not cryptographic identity — just session-unique). */
export function randomId(len = 8): string {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => (b % 36).toString(36)).join('');
}
