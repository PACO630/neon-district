// Compact little-endian binary serialization with strict bounds checking.
// Every read is validated; a malformed packet throws PacketError and is dropped by the caller.

export class PacketError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export class Writer {
  private buf: ArrayBuffer;
  private view: DataView;
  private u8: Uint8Array;
  offset = 0;

  constructor(initial = 256) {
    this.buf = new ArrayBuffer(initial);
    this.view = new DataView(this.buf);
    this.u8 = new Uint8Array(this.buf);
  }

  private ensure(n: number): void {
    if (this.offset + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.offset + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.u8);
    this.buf = next;
    this.view = new DataView(next);
    this.u8 = new Uint8Array(next);
  }

  u8w(v: number): this { this.ensure(1); this.view.setUint8(this.offset, v); this.offset += 1; return this; }
  u16(v: number): this { this.ensure(2); this.view.setUint16(this.offset, v, true); this.offset += 2; return this; }
  i16(v: number): this { this.ensure(2); this.view.setInt16(this.offset, Math.max(-32768, Math.min(32767, Math.round(v))), true); this.offset += 2; return this; }
  u32(v: number): this { this.ensure(4); this.view.setUint32(this.offset, v >>> 0, true); this.offset += 4; return this; }
  f32(v: number): this { this.ensure(4); this.view.setFloat32(this.offset, v, true); this.offset += 4; return this; }
  f64(v: number): this { this.ensure(8); this.view.setFloat64(this.offset, v, true); this.offset += 8; return this; }
  bool(v: boolean): this { return this.u8w(v ? 1 : 0); }
  /** angle in radians quantized to 16 bits */
  angle(rad: number): this {
    const a = ((rad % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return this.u16(Math.round((a / (Math.PI * 2)) * 65535));
  }
  str(s: string): this {
    const b = enc.encode(s);
    if (b.length > 65535) throw new PacketError('string too long');
    this.u16(b.length);
    this.ensure(b.length);
    this.u8.set(b, this.offset);
    this.offset += b.length;
    return this;
  }
  /** Long UTF-8 blob (JSON payloads), 32-bit length prefix */
  text(s: string): this {
    const b = enc.encode(s);
    this.u32(b.length);
    this.ensure(b.length);
    this.u8.set(b, this.offset);
    this.offset += b.length;
    return this;
  }
  finish(): ArrayBuffer { return this.buf.slice(0, this.offset); }
}

export class Reader {
  private view: DataView;
  private u8: Uint8Array;
  offset = 0;

  constructor(buf: ArrayBuffer) {
    this.view = new DataView(buf);
    this.u8 = new Uint8Array(buf);
  }
  get remaining(): number { return this.view.byteLength - this.offset; }
  private need(n: number): void {
    if (this.offset + n > this.view.byteLength) throw new PacketError('read past end');
  }
  u8r(): number { this.need(1); const v = this.view.getUint8(this.offset); this.offset += 1; return v; }
  u16(): number { this.need(2); const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
  i16(): number { this.need(2); const v = this.view.getInt16(this.offset, true); this.offset += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    if (!Number.isFinite(v)) throw new PacketError('non-finite float');
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    if (!Number.isFinite(v)) throw new PacketError('non-finite float');
    return v;
  }
  bool(): boolean { return this.u8r() !== 0; }
  angle(): number { return (this.u16() / 65535) * Math.PI * 2; }
  str(max = 4096): string {
    const len = this.u16();
    if (len > max) throw new PacketError('string exceeds limit');
    this.need(len);
    const s = dec.decode(this.u8.subarray(this.offset, this.offset + len));
    this.offset += len;
    return s;
  }
  text(max = 1 << 20): string {
    const len = this.u32();
    if (len > max) throw new PacketError('text exceeds limit');
    this.need(len);
    const s = dec.decode(this.u8.subarray(this.offset, this.offset + len));
    this.offset += len;
    return s;
  }
}

/** Deflate + base64url for invite codes. Falls back to plain base64url if CompressionStream is missing. */
export async function packText(s: string): Promise<string> {
  const raw = enc.encode(s);
  let bytes: Uint8Array;
  let tag: string;
  if (typeof CompressionStream !== 'undefined') {
    const cs = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(cs).arrayBuffer());
    tag = 'z';
  } else {
    bytes = raw;
    tag = 'p';
  }
  return tag + toB64Url(bytes);
}

export async function unpackText(s: string): Promise<string> {
  const tag = s[0];
  const bytes = fromB64Url(s.slice(1));
  if (tag === 'p') return dec.decode(bytes);
  if (tag !== 'z') throw new PacketError('unknown encoding');
  if (typeof DecompressionStream === 'undefined') throw new PacketError('This browser cannot decompress invite codes');
  const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return dec.decode(new Uint8Array(await new Response(ds).arrayBuffer()));
}

function toB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64Url(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9\-_]/g, '');
  const b64 = clean.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((clean.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
