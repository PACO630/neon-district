// Dedicated touch layout: floating left joystick, right-side look surface, and context buttons.
import type { Action, Input } from '../player/Input';

interface BtnDef { id: string; label: string; action: Action; cls?: string; toggle?: boolean; modes: ('city' | 'arena')[] }

const BUTTONS: BtnDef[] = [
  { id: 'fire', label: 'FIRE', action: 'fire', cls: 'big fire', modes: ['arena'] },
  { id: 'fire2', label: 'FIRE', action: 'fire', cls: 'fire-left', modes: ['arena'] },
  { id: 'aim', label: 'AIM', action: 'aim', cls: 'aim', toggle: true, modes: ['arena'] },
  { id: 'jump', label: 'JUMP', action: 'jump', cls: 'jump', modes: ['city', 'arena'] },
  { id: 'crouch', label: 'CRCH', action: 'crouch', cls: 'crouch', toggle: true, modes: ['arena', 'city'] },
  { id: 'reload', label: 'R', action: 'reload', cls: 'reload', modes: ['arena'] },
  { id: 'swap', label: '⇄', action: 'nextWeapon', cls: 'swap', modes: ['arena'] },
  { id: 'use', label: 'USE', action: 'interact', cls: 'use', modes: ['city', 'arena'] },
  { id: 'buy', label: 'BUY', action: 'buy', cls: 'buy', modes: ['arena'] },
  { id: 'score', label: 'TAB', action: 'scoreboard', cls: 'score', modes: ['arena'] },
  { id: 'run', label: 'WALK', action: 'walk', cls: 'run', toggle: true, modes: ['city'] },
];

export class TouchControls {
  readonly el: HTMLElement;
  private stick: HTMLElement;
  private knob: HTMLElement;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private buttons = new Map<string, HTMLElement>();
  private toggled = new Set<string>();
  mode: 'city' | 'arena' | 'off' = 'off';

  constructor(private input: Input, parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'touch-layer hidden';
    this.stick = document.createElement('div');
    this.stick.className = 'touch-stick';
    this.knob = document.createElement('div');
    this.knob.className = 'touch-knob';
    this.stick.appendChild(this.knob);
    this.el.appendChild(this.stick);
    const look = document.createElement('div');
    look.className = 'touch-look';
    this.el.appendChild(look);
    const move = document.createElement('div');
    move.className = 'touch-move';
    this.el.appendChild(move);
    for (const b of BUTTONS) {
      const btn = document.createElement('button');
      btn.className = `touch-btn ${b.cls ?? ''}`;
      btn.textContent = b.label;
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (b.toggle) {
          if (this.toggled.has(b.id)) { this.toggled.delete(b.id); this.input.release(b.action); btn.classList.remove('on'); }
          else { this.toggled.add(b.id); this.input.press(b.action); btn.classList.add('on'); }
        } else {
          this.input.press(b.action);
          btn.classList.add('on');
          // fire buttons double as look surfaces so players can aim while shooting
          if (b.action === 'fire') { const t = e.changedTouches[0]; this.lookId = t.identifier; this.lookLast = { x: t.clientX, y: t.clientY }; }
        }
      }, { passive: false });
      const end = (e: TouchEvent) => {
        e.preventDefault();
        if (!b.toggle) { this.input.release(b.action); btn.classList.remove('on'); }
        for (const t of Array.from(e.changedTouches)) if (t.identifier === this.lookId) this.lookId = null;
      };
      btn.addEventListener('touchend', end, { passive: false });
      btn.addEventListener('touchcancel', end, { passive: false });
      btn.addEventListener('touchmove', (e) => this.onLookMove(e), { passive: false });
      this.buttons.set(b.id, btn);
      this.el.appendChild(btn);
    }
    move.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      if (this.stickId !== null) return;
      this.stickId = t.identifier;
      this.stickOrigin = { x: t.clientX, y: t.clientY };
      this.stick.style.left = `${t.clientX - 60}px`;
      this.stick.style.top = `${t.clientY - 60}px`;
      this.stick.classList.add('active');
    }, { passive: false });
    move.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== this.stickId) continue;
        let dx = t.clientX - this.stickOrigin.x, dy = t.clientY - this.stickOrigin.y;
        const len = Math.hypot(dx, dy);
        const max = 52;
        if (len > max) { dx *= max / len; dy *= max / len; }
        this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
        this.input.touchMove = { x: dx / max, y: -dy / max };
        // pushing the stick fully forward runs in the city; otherwise walk speed scales with tilt
      }
    }, { passive: false });
    const endMove = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== this.stickId) continue;
        this.stickId = null;
        this.knob.style.transform = '';
        this.stick.classList.remove('active');
        this.input.touchMove = { x: 0, y: 0 };
      }
    };
    move.addEventListener('touchend', endMove);
    move.addEventListener('touchcancel', endMove);
    look.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      if (this.lookId !== null) return;
      this.lookId = t.identifier;
      this.lookLast = { x: t.clientX, y: t.clientY };
    }, { passive: false });
    look.addEventListener('touchmove', (e) => this.onLookMove(e), { passive: false });
    const endLook = (e: TouchEvent) => { for (const t of Array.from(e.changedTouches)) if (t.identifier === this.lookId) this.lookId = null; };
    look.addEventListener('touchend', endLook);
    look.addEventListener('touchcancel', endLook);
    parent.appendChild(this.el);
  }

  private onLookMove(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== this.lookId) continue;
      const dx = t.clientX - this.lookLast.x, dy = t.clientY - this.lookLast.y;
      this.lookLast = { x: t.clientX, y: t.clientY };
      this.input.addLook(dx * 0.0065, dy * 0.0065);
    }
  }

  setMode(mode: 'city' | 'arena' | 'off'): void {
    this.mode = mode;
    this.el.classList.toggle('hidden', mode === 'off');
    for (const b of BUTTONS) {
      const btn = this.buttons.get(b.id)!;
      btn.style.display = mode !== 'off' && b.modes.includes(mode) ? '' : 'none';
    }
    for (const id of [...this.toggled]) { const b = BUTTONS.find((x) => x.id === id)!; this.input.release(b.action); this.buttons.get(id)!.classList.remove('on'); }
    this.toggled.clear();
  }

  /** Context-sensitive label for USE (e.g. PLANT / DEFUSE / TALK). */
  setUseLabel(label: string | null): void {
    const b = this.buttons.get('use')!;
    b.textContent = label ?? 'USE';
    b.classList.toggle('highlight', !!label);
  }

  setScale(s: number): void { this.el.style.setProperty('--touch-scale', String(s)); }
}
