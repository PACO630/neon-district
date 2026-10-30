// Web Audio engine. All sounds are synthesized at runtime (noise shaping, oscillators, convolution
// reverb) — no audio files are downloaded. Four buses: music, sfx, ambient (+ master), with HRTF
// positional sources for world sounds.
import * as THREE from 'three';
import type { AudioSettings } from '../config/settings';

type Bus = 'sfx' | 'music' | 'ambient';

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses!: Record<Bus, GainNode>;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private noise!: { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer };
  private listenerPos = new THREE.Vector3();
  private ambience: { stop: () => void; setLevel: (outdoor: number) => void } | null = null;
  private music: BarMusic | null = null;
  private pending: AudioSettings | null = null;
  private lastStep = 0;

  /** Must be called from a user gesture (browser autoplay policy). */
  unlock(): void {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx: AudioContext = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.buses = { sfx: ctx.createGain(), music: ctx.createGain(), ambient: ctx.createGain() };
    for (const b of Object.values(this.buses)) b.connect(this.master);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.6, 2.2);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.35;
    this.reverbSend.connect(this.reverb).connect(this.buses.sfx);
    this.noise = { white: this.noiseBuffer('white'), pink: this.noiseBuffer('pink'), brown: this.noiseBuffer('brown') };
    if (this.pending) this.setVolumes(this.pending);
  }

  setVolumes(v: AudioSettings): void {
    this.pending = v;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(v.master, t, 0.05);
    this.buses.music.gain.setTargetAtTime(v.music, t, 0.05);
    this.buses.sfx.gain.setTargetAtTime(v.sfx, t, 0.05);
    this.buses.ambient.gain.setTargetAtTime(v.ambient, t, 0.05);
  }

  setListener(cam: THREE.Camera): void {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const p = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    this.listenerPos.copy(p);
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setValueAtTime(p.x, t); l.positionY.setValueAtTime(p.y, t); l.positionZ.setValueAtTime(p.z, t);
      l.forwardX.setValueAtTime(f.x, t); l.forwardY.setValueAtTime(f.y, t); l.forwardZ.setValueAtTime(f.z, t);
      l.upX.setValueAtTime(u.x, t); l.upY.setValueAtTime(u.y, t); l.upZ.setValueAtTime(u.z, t);
    } else {
      (l as any).setPosition(p.x, p.y, p.z);
      (l as any).setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
    if (this.music) this.music.updateDistance(p);
  }

  // ------------------------------------------------------------ building blocks
  private noiseBuffer(kind: 'white' | 'pink' | 'brown'): AudioBuffer {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else if (kind === 'pink') { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
      else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    }
    return buf;
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  private dest(bus: Bus, pos?: THREE.Vector3, refDist = 4, reverb = 0): AudioNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    if (pos) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = refDist;
      p.maxDistance = 400;
      p.rolloffFactor = 1.2;
      p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
      g.connect(p).connect(this.buses[bus]);
    } else g.connect(this.buses[bus]);
    if (reverb > 0) {
      const s = ctx.createGain();
      s.gain.value = reverb;
      g.connect(s).connect(this.reverbSend);
    }
    return g;
  }

  private noiseBurst(kind: 'white' | 'pink' | 'brown', out: AudioNode, opts: { t?: number; dur: number; attack?: number; gain: number; filter?: BiquadFilterType; freq?: number; q?: number; freqEnd?: number }): void {
    const ctx = this.ctx!;
    const t = opts.t ?? ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise[kind];
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(opts.gain, t + (opts.attack ?? 0.002));
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    let node: AudioNode = src;
    if (opts.filter) {
      const f = ctx.createBiquadFilter();
      f.type = opts.filter;
      f.frequency.setValueAtTime(opts.freq ?? 1000, t);
      if (opts.freqEnd) f.frequency.exponentialRampToValueAtTime(opts.freqEnd, t + opts.dur);
      f.Q.value = opts.q ?? 0.7;
      node.connect(f);
      node = f;
    }
    node.connect(g).connect(out);
    src.start(t, Math.random() * 1.5);
    src.stop(t + opts.dur + 0.05);
  }

  private tone(out: AudioNode, opts: { t?: number; type?: OscillatorType; freq: number; freqEnd?: number; dur: number; gain: number; attack?: number }): void {
    const ctx = this.ctx!;
    const t = opts.t ?? ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqEnd) o.frequency.exponentialRampToValueAtTime(opts.freqEnd, t + opts.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(opts.gain, t + (opts.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + opts.dur + 0.05);
  }

  private ok(): boolean { return !!this.ctx && this.ctx.state === 'running'; }

  // ------------------------------------------------------------ combat
  gunshot(cls: string, pos?: THREE.Vector3, suppressed = false): void {
    if (!this.ok()) return;
    const out = this.dest('sfx', pos, 6, pos ? 0.6 : 0.3);
    const p = { pistol: [0.9, 2600, 0.18], smg: [0.75, 3200, 0.12], rifle: [1.0, 2200, 0.22], sniper: [1.3, 1500, 0.45], shotgun: [1.3, 1200, 0.35], melee: [0, 0, 0] }[cls] ?? [1, 2000, 0.2];
    if (cls === 'melee') { this.noiseBurst('white', out, { dur: 0.12, gain: 0.25, filter: 'bandpass', freq: 3500, freqEnd: 1200, q: 2 }); return; }
    const g = suppressed ? 0.4 : 1;
    this.noiseBurst('white', out, { dur: p[2], gain: 0.9 * p[0] * g, filter: 'lowpass', freq: p[1], freqEnd: 300 });
    this.noiseBurst('brown', out, { dur: p[2] * 1.6, gain: 0.8 * p[0] * g, filter: 'lowpass', freq: 400 });
    this.tone(out, { type: 'sine', freq: 120, freqEnd: 40, dur: 0.18, gain: 0.7 * p[0] * g });
    this.tone(out, { type: 'square', freq: 3000 + Math.random() * 400, freqEnd: 900, dur: 0.03, gain: 0.08 });
  }
  dryFire(): void { if (!this.ok()) return; this.noiseBurst('white', this.dest('sfx'), { dur: 0.04, gain: 0.25, filter: 'highpass', freq: 3000 }); }
  reload(stage: 0 | 1 | 2, pos?: THREE.Vector3): void {
    if (!this.ok()) return;
    const out = this.dest('sfx', pos, 2);
    const f = [1800, 2600, 1200][stage];
    this.noiseBurst('white', out, { dur: 0.07, gain: 0.35, filter: 'bandpass', freq: f, q: 4 });
    this.tone(out, { type: 'triangle', freq: f * 0.5, dur: 0.06, gain: 0.12 });
  }
  footstep(pos: THREE.Vector3 | undefined, wet: boolean, loud = 1): void {
    if (!this.ok()) return;
    const out = this.dest('sfx', pos, 3);
    this.noiseBurst('brown', out, { dur: 0.09, gain: 0.35 * loud, filter: 'lowpass', freq: 700 });
    this.noiseBurst('white', out, { dur: 0.05, gain: 0.08 * loud, filter: 'bandpass', freq: 2200, q: 1.5 });
    if (wet) this.noiseBurst('white', out, { dur: 0.16, gain: 0.12 * loud, filter: 'highpass', freq: 2500, attack: 0.01 });
  }
  /** Throttled local footsteps from the movement controller. */
  localStep(wet: boolean, speed: number, crouched: boolean): void {
    const now = performance.now();
    const interval = 380 * (5 / Math.max(2, speed));
    if (now - this.lastStep < interval || crouched || speed < 1) return;
    this.lastStep = now;
    this.footstep(undefined, wet, speed > 4.5 ? 0.6 : 0.35);
  }
  impact(pos: THREE.Vector3, kind: 'metal' | 'concrete' | 'flesh' | 'water'): void {
    if (!this.ok()) return;
    const out = this.dest('sfx', pos, 2.5);
    if (kind === 'metal') { this.tone(out, { type: 'triangle', freq: 2400 + Math.random() * 1500, freqEnd: 1800, dur: 0.12, gain: 0.15 }); this.noiseBurst('white', out, { dur: 0.05, gain: 0.2, filter: 'highpass', freq: 3000 }); }
    else if (kind === 'flesh') this.noiseBurst('brown', out, { dur: 0.08, gain: 0.5, filter: 'lowpass', freq: 600 });
    else if (kind === 'water') this.noiseBurst('white', out, { dur: 0.2, gain: 0.2, filter: 'bandpass', freq: 1800, q: 0.8 });
    else this.noiseBurst('white', out, { dur: 0.06, gain: 0.25, filter: 'bandpass', freq: 1400, q: 1.2 });
  }
  hitmarker(head: boolean): void {
    if (!this.ok()) return;
    const out = this.dest('sfx');
    this.tone(out, { type: 'square', freq: head ? 1800 : 1200, dur: 0.05, gain: 0.08 });
    if (head) this.tone(out, { type: 'sine', freq: 2600, dur: 0.12, gain: 0.08, t: this.ctx!.currentTime + 0.03 });
  }
  killConfirm(): void {
    if (!this.ok()) return;
    const out = this.dest('sfx');
    const t = this.ctx!.currentTime;
    this.tone(out, { type: 'triangle', freq: 880, dur: 0.12, gain: 0.15, t });
    this.tone(out, { type: 'triangle', freq: 1320, dur: 0.2, gain: 0.15, t: t + 0.07 });
  }
  hurt(): void { if (!this.ok()) return; this.noiseBurst('brown', this.dest('sfx'), { dur: 0.18, gain: 0.5, filter: 'lowpass', freq: 300 }); }
  explosion(pos: THREE.Vector3, big = true): void {
    if (!this.ok()) return;
    const out = this.dest('sfx', pos, big ? 25 : 8, 1);
    this.noiseBurst('brown', out, { dur: big ? 3 : 1.2, gain: 1.6, filter: 'lowpass', freq: 900, freqEnd: 80 });
    this.noiseBurst('white', out, { dur: 0.6, gain: 0.8, filter: 'lowpass', freq: 5000, freqEnd: 200 });
    this.tone(out, { type: 'sine', freq: 70, freqEnd: 22, dur: big ? 2 : 0.8, gain: 1.2 });
  }
  flashbang(pos: THREE.Vector3): void {
    if (!this.ok()) return;
    const out = this.dest('sfx', pos, 10, 0.8);
    this.noiseBurst('white', out, { dur: 0.5, gain: 1.2, filter: 'highpass', freq: 1500 });
    this.tone(out, { type: 'sine', freq: 90, freqEnd: 30, dur: 0.4, gain: 0.8 });
  }
  tinnitus(seconds: number): void {
    if (!this.ok() || seconds <= 0) return;
    this.tone(this.dest('sfx'), { type: 'sine', freq: 4100, dur: seconds, gain: 0.05, attack: 0.05 });
  }
  smokeHiss(pos: THREE.Vector3): void { if (!this.ok()) return; this.noiseBurst('white', this.dest('sfx', pos, 4), { dur: 3.5, gain: 0.3, filter: 'highpass', freq: 2500, attack: 0.1 }); }
  fire(pos: THREE.Vector3, seconds: number): void {
    if (!this.ok()) return;
    const out = this.dest('sfx', pos, 5);
    this.noiseBurst('brown', out, { dur: seconds, gain: 0.5, filter: 'lowpass', freq: 600, attack: 0.2 });
    for (let i = 0; i < seconds * 6; i++) this.noiseBurst('white', out, { t: this.ctx!.currentTime + Math.random() * seconds, dur: 0.03, gain: 0.15, filter: 'bandpass', freq: 3000 });
  }
  bounce(pos: THREE.Vector3): void { if (!this.ok()) return; this.tone(this.dest('sfx', pos, 2), { type: 'triangle', freq: 900, freqEnd: 500, dur: 0.08, gain: 0.15 }); }
  throwWhoosh(): void { if (!this.ok()) return; this.noiseBurst('pink', this.dest('sfx'), { dur: 0.25, gain: 0.25, filter: 'bandpass', freq: 600, freqEnd: 1800, q: 1 }); }
  c4Beep(pos: THREE.Vector3 | undefined): void { if (!this.ok()) return; this.tone(this.dest('sfx', pos, 6), { type: 'sine', freq: 1950, dur: 0.11, gain: 0.25 }); }
  c4Armed(pos: THREE.Vector3): void {
    if (!this.ok()) return;
    const out = this.dest('sfx', pos, 6);
    const t = this.ctx!.currentTime;
    [0, 0.12, 0.24].forEach((d, i) => this.tone(out, { type: 'square', freq: 1400 + i * 300, dur: 0.1, gain: 0.12, t: t + d }));
  }
  defuseTick(pos?: THREE.Vector3): void { if (!this.ok()) return; this.noiseBurst('white', this.dest('sfx', pos, 2), { dur: 0.03, gain: 0.2, filter: 'bandpass', freq: 4200, q: 6 }); }
  defused(): void {
    if (!this.ok()) return;
    const out = this.dest('sfx');
    const t = this.ctx!.currentTime;
    this.tone(out, { type: 'sine', freq: 1200, freqEnd: 300, dur: 0.6, gain: 0.25, t });
  }
  roundStart(): void {
    if (!this.ok()) return;
    const out = this.dest('music');
    const t = this.ctx!.currentTime;
    [0, 0.09, 0.18].forEach((d, i) => this.tone(out, { type: 'sawtooth', freq: [220, 330, 440][i], dur: 0.5, gain: 0.08, t: t + d }));
  }
  roundEnd(win: boolean): void {
    if (!this.ok()) return;
    const out = this.dest('music');
    const t = this.ctx!.currentTime;
    const notes = win ? [392, 494, 587, 784] : [392, 349, 311, 233];
    notes.forEach((f, i) => this.tone(out, { type: 'triangle', freq: f, dur: 0.9, gain: 0.12, t: t + i * 0.14 }));
  }
  ui(kind: 'click' | 'hover' | 'error' | 'success' | 'buy' | 'notify'): void {
    if (!this.ok()) return;
    const out = this.dest('sfx');
    const t = this.ctx!.currentTime;
    switch (kind) {
      case 'hover': this.tone(out, { type: 'sine', freq: 2200, dur: 0.03, gain: 0.025 }); break;
      case 'click': this.tone(out, { type: 'square', freq: 1400, freqEnd: 900, dur: 0.05, gain: 0.05 }); break;
      case 'error': this.tone(out, { type: 'sawtooth', freq: 180, dur: 0.18, gain: 0.08 }); break;
      case 'success': this.tone(out, { type: 'sine', freq: 880, dur: 0.1, gain: 0.08, t }); this.tone(out, { type: 'sine', freq: 1320, dur: 0.15, gain: 0.08, t: t + 0.07 }); break;
      case 'buy': this.noiseBurst('white', out, { dur: 0.08, gain: 0.15, filter: 'bandpass', freq: 2500, q: 3 }); this.tone(out, { type: 'triangle', freq: 1500, dur: 0.12, gain: 0.08, t: t + 0.04 }); break;
      case 'notify': this.tone(out, { type: 'sine', freq: 1046, dur: 0.12, gain: 0.07, t }); this.tone(out, { type: 'sine', freq: 1568, dur: 0.18, gain: 0.07, t: t + 0.1 }); break;
    }
  }
  drink(pos?: THREE.Vector3): void { if (!this.ok()) return; this.noiseBurst('pink', this.dest('sfx', pos, 2), { dur: 0.6, gain: 0.2, filter: 'bandpass', freq: 900, q: 3 }); }

  // ------------------------------------------------------------ ambience
  /** City or arena ambience: rain, wind, traffic hum, distant sirens and jingles. */
  startAmbience(kind: 'city' | 'arena', jinglePoints: THREE.Vector3[] = [], chatterPoints: THREE.Vector3[] = []): void {
    if (!this.ctx) return;
    this.stopAmbience();
    const ctx = this.ctx;
    const nodes: AudioScheduledSourceNode[] = [];
    const loop = (kind2: 'white' | 'pink' | 'brown', filter: BiquadFilterType, freq: number, gain: number, q = 0.7) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise[kind2];
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = filter;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(f).connect(g).connect(this.buses.ambient);
      src.start();
      nodes.push(src);
      return { g, f };
    };
    const rainHi = loop('pink', 'highpass', 1200, 0.35);
    const rainLo = loop('brown', 'lowpass', 500, kind === 'city' ? 0.25 : 0.15);
    const wind = loop('brown', 'bandpass', 300, 0.25, 0.6);
    const traffic = kind === 'city' ? loop('brown', 'lowpass', 120, 0.3) : null;
    // modulate wind
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(wind.f.frequency);
    lfo.start();
    nodes.push(lfo);
    let alive = true;
    const timers: number[] = [];
    const schedule = (fn: () => void, min: number, max: number) => {
      const tick = () => { if (!alive) return; fn(); timers.push(window.setTimeout(tick, min + Math.random() * (max - min))); };
      timers.push(window.setTimeout(tick, Math.random() * max));
    };
    // individual droplets / gutter drips
    schedule(() => this.tone(this.buses.ambient, { type: 'sine', freq: 1500 + Math.random() * 2500, freqEnd: 800, dur: 0.04, gain: 0.02 }), 120, 500);
    if (kind === 'city') {
      // flying car fly-bys
      schedule(() => {
        const t = ctx.currentTime;
        const src = ctx.createBufferSource();
        src.buffer = this.noise.pink;
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass'; f.Q.value = 2;
        f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(1400, t + 1.5); f.frequency.exponentialRampToValueAtTime(250, t + 3.5);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 1.5); g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
        const pan = ctx.createStereoPanner();
        pan.pan.setValueAtTime(-1, t); pan.pan.linearRampToValueAtTime(1, t + 3.5);
        src.connect(f).connect(g).connect(pan).connect(this.buses.ambient);
        src.start(t); src.stop(t + 3.6);
      }, 4000, 11000);
      // distant siren
      schedule(() => {
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        o.type = 'triangle';
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.025, t + 1); g.gain.exponentialRampToValueAtTime(0.0001, t + 6);
        for (let i = 0; i < 12; i++) o.frequency.setValueAtTime(i % 2 ? 640 : 820, t + i * 0.5);
        o.connect(g).connect(this.buses.ambient);
        o.start(t); o.stop(t + 6.1);
      }, 25000, 60000);
      // billboard jingles (positional)
      for (const p of jinglePoints) {
        schedule(() => {
          const out = this.dest('ambient', p, 8);
          const t = ctx.currentTime;
          const base = [523, 587, 659, 784, 880][Math.floor(Math.random() * 5)];
          [0, 4, 7, 12, 7].forEach((st, i) => this.tone(out, { type: 'square', freq: base * Math.pow(2, st / 12), dur: 0.14, gain: 0.05, t: t + i * 0.13 }));
        }, 9000, 22000);
      }
      // crowd chatter (formant-filtered noise bursts)
      for (const p of chatterPoints) {
        schedule(() => {
          const out = this.dest('ambient', p, 3);
          const t = ctx.currentTime;
          for (let i = 0; i < 5; i++) {
            this.noiseBurst('pink', out, { t: t + i * 0.16, dur: 0.14, gain: 0.08, filter: 'bandpass', freq: 500 + Math.random() * 900, q: 5, attack: 0.03 });
          }
        }, 1200, 4000);
      }
    }
    this.ambience = {
      stop: () => {
        alive = false;
        timers.forEach(clearTimeout);
        for (const n of nodes) { try { n.stop(); } catch { /* ignore */ } }
      },
      setLevel: (outdoor) => {
        const t = ctx.currentTime;
        rainHi.g.gain.setTargetAtTime(0.06 + 0.29 * outdoor, t, 0.3);
        rainHi.f.frequency.setTargetAtTime(outdoor > 0.5 ? 1200 : 600, t, 0.3);
        rainLo.g.gain.setTargetAtTime(0.08 + 0.17 * outdoor, t, 0.3);
        wind.g.gain.setTargetAtTime(0.05 + 0.2 * outdoor, t, 0.3);
        if (traffic) traffic.g.gain.setTargetAtTime(0.1 + 0.2 * outdoor, t, 0.3);
      },
    };
  }
  setOutdoor(v: number): void { this.ambience?.setLevel(v); }
  stopAmbience(): void { this.ambience?.stop(); this.ambience = null; }

  startBarMusic(pos: THREE.Vector3): void {
    if (!this.ctx) return;
    this.music?.stop();
    this.music = new BarMusic(this.ctx, this.buses.music, pos, this.noise.white);
  }
  stopMusic(): void { this.music?.stop(); this.music = null; }
}

/** Procedural synthwave loop played from the AFTERLIFE bar (positional, distance-attenuated). */
class BarMusic {
  private timer = 0;
  private step = 0;
  private out: GainNode;
  private lp: BiquadFilterNode;
  private nextTime: number;
  private stopped = false;
  private readonly bpm = 96;

  constructor(private ctx: AudioContext, dest: AudioNode, private pos: THREE.Vector3, private noise: AudioBuffer) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 800;
    this.out.connect(this.lp).connect(dest);
    this.nextTime = ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 50);
  }

  updateDistance(listener: THREE.Vector3): void {
    const d = listener.distanceTo(this.pos);
    const inside = d < 9;
    const g = d > 70 ? 0 : inside ? 0.55 : Math.max(0, 0.32 * (1 - d / 70));
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(g, t, 0.4);
    this.lp.frequency.setTargetAtTime(inside ? 12000 : 900, t, 0.4); // muffled through walls
  }

  private schedule(): void {
    if (this.stopped) return;
    const spb = 60 / this.bpm / 4; // 16th notes
    while (this.nextTime < this.ctx.currentTime + 0.2) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += spb;
      this.step = (this.step + 1) % 64;
    }
  }

  private note(type: OscillatorType, freq: number, t: number, dur: number, gain: number, cutoff = 4000): void {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(200, cutoff * 0.2), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private playStep(s: number, t: number): void {
    const bar = Math.floor(s / 16);
    const roots = [55, 43.65, 49, 41.2]; // A1 F1 G1 E1
    const root = roots[bar];
    const i = s % 16;
    if (i % 4 === 0) { // kick
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g).connect(this.out);
      o.start(t); o.stop(t + 0.3);
    }
    if (i % 8 === 4) { // snare
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.35, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1800;
      src.connect(f).connect(g).connect(this.out);
      src.start(t, Math.random()); src.stop(t + 0.2);
    }
    if (i % 2 === 1) { // hat
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.06, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      const f = this.ctx.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = 7000;
      src.connect(f).connect(g).connect(this.out);
      src.start(t, Math.random()); src.stop(t + 0.06);
    }
    // bass: octave pulse
    this.note('sawtooth', root * (i % 2 ? 2 : 1), t, 0.14, 0.18, 900);
    // arp
    const arp = [0, 7, 12, 15, 19, 15, 12, 7];
    if (i % 2 === 0) this.note('square', root * 4 * Math.pow(2, arp[(i / 2) % 8] / 12), t, 0.12, 0.035, 2500);
    // pad on bar start
    if (i === 0) for (const st of [0, 3, 7, 10]) this.note('sawtooth', root * 4 * Math.pow(2, st / 12), t, 2.4, 0.025, 1500);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.out.disconnect();
  }
}
