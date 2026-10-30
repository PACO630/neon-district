// Touch layout modelled on established mobile shooters (CoD Mobile / PUBG Mobile conventions):
// floating move stick on the left, free look on the right half, a large right-thumb FIRE button that
// also steers the aim while held, a second FIRE for the left thumb, and scope / jump / crouch /
// reload / grenade clustered around the right thumb. Context actions (USE / PLANT / DEFUSE) only
// light up when available.
import type { Action, Input } from '../player/Input';

type Mode = 'city' | 'arena';
interface BtnDef { id: string; icon: string; label?: string; action: Action; cls: string; toggle?: boolean; look?: boolean; modes: Mode[] }

const svg = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  fire: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
  scope: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4v5M12 15v5M4 12h5M15 12h5"/>'),
  jump: svg('<path d="M6 14l6-6 6 6"/><path d="M6 19l6-6 6 6"/>'),
  crouch: svg('<circle cx="12" cy="5" r="2"/><path d="M12 7v5l-4 3v4M12 12l4 2v5"/>'),
  reload: svg('<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>'),
  grenade: svg('<circle cx="12" cy="14" r="6"/><path d="M10 8V6h4v2M14 6l3-2"/>'),
  use: svg('<path d="M7 12l3 3 7-7"/><rect x="3" y="3" width="18" height="18" rx="3"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  buy: svg('<path d="M5 7h14l-1.5 9h-11z"/><path d="M9 7a3 3 0 0 1 6 0"/>'),
  score: svg('<path d="M5 19V9M12 19V5M19 19v-7"/>'),
  wave: svg('<path d="M7 13V6a1.5 1.5 0 0 1 3 0v6M10 11V4.5a1.5 1.5 0 0 1 3 0V11M13 11V5.5a1.5 1.5 0 0 1 3 0V12M16 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-12 0v-2l-2-2"/>'),
  chat: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
  swap: svg('<path d="M4 8h13l-3-3M20 16H7l3 3"/>'),
};

const BUTTONS: BtnDef[] = [
  { id: 'fire', icon: ICON.fire, action: 'fire', cls: 'tb-fire', look: true, modes: ['arena'] },
  { id: 'fire2', icon: ICON.fire, action: 'fire', cls: 'tb-fire2', look: true, modes: ['arena'] },
  { id: 'aim', icon: ICON.scope, action: 'aim', cls: 'tb-aim', toggle: true, modes: ['arena'] },
  { id: 'jump', icon: ICON.jump, action: 'jump', cls: 'tb-jump', modes: ['city', 'arena'] },
  { id: 'crouch', icon: ICON.crouch, action: 'crouch', cls: 'tb-crouch', toggle: true, modes: ['city', 'arena'] },
  { id: 'reload', icon: ICON.reload, action: 'reload', cls: 'tb-reload', modes: ['arena'] },
  { id: 'grenade', icon: ICON.grenade, action: 'slot4', cls: 'tb-grenade', modes: ['arena'] },
  { id: 'swap', icon: ICON.swap, action: 'nextWeapon', cls: 'tb-swap', modes: ['arena'] },
  { id: 'use', icon: ICON.use, label: 'USE', action: 'interact', cls: 'tb-use', modes: ['city', 'arena'] },
  { id: 'wave', icon: ICON.wave, action: 'emote1', cls: 'tb-wave', modes: ['city'] },
  { id: 'chat', icon: ICON.chat, action: 'chat', cls: 'tb-chat', modes: ['city'] },
  { id: 'buy', icon: ICON.buy, action: 'buy', cls: 'tb-buy', modes: ['arena'] },
  { id: 'score', icon: ICON.score, action: 'scoreboard', cls: 'tb-score', toggle: true, modes: ['arena'] },
  { id: 'menu', icon: ICON.menu, action: 'menu', cls: 'tb-menu', modes: ['city', 'arena'] },
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
  mode: Mode | 'off' = 'off';

  constructor(private input: Input, parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'touch-layer hidden';
    const move = document.createElement('div');
    move.className = 'touch-move';
    const look = document.createElement('div');
    look.className = 'touch-look';
    this.el.append(move, look);
    this.stick = document.createElement('div');
    this.stick.className = 'touch-stick';
    this.knob = document.createElement('div');
    this.knob.className = 'touch-knob';
    this.stick.appendChild(this.knob);
    this.el.appendChild(this.stick);

    for (const b of BUTTONS) {
      const btn = document.createElement('button');
      btn.className = `tbtn ${b.cls}`;
      btn.innerHTML = b.icon + (b.label ? `<span>${b.label}</span>` : '');
      btn.setAttribute('aria-label', b.action);
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.vibrate?.(8);
        if (b.toggle) {
          const on = !this.toggled.has(b.id);
          if (on) { this.toggled.add(b.id); this.input.press(b.action); } else { this.toggled.delete(b.id); this.input.release(b.action); }
          btn.classList.toggle('on', on);
          return;
        }
        this.input.press(b.action);
        btn.classList.add('on');
        // FIRE buttons double as a look surface so players can steer while shooting
        if (b.look && this.lookId === null) { const t = e.changedTouches[0]; this.lookId = t.identifier; this.lookLast = { x: t.clientX, y: t.clientY }; }
      }, { passive: false });
      const end = (e: TouchEvent) => {
        e.preventDefault();
        if (!b.toggle) {
          // momentary actions (reload, jump, menu…) are edge-triggered; release right away
          this.input.release(b.action);
          btn.classList.remove('on');
        }
        for (const t of Array.from(e.changedTouches)) if (t.identifier === this.lookId) this.lookId = null;
      };
      btn.addEventListener('touchend', end, { passive: false });
      btn.addEventListener('touchcancel', end, { passive: false });
      btn.addEventListener('touchmove', (e) => this.onLookMove(e), { passive: false });
      this.buttons.set(b.id, btn);
      this.el.appendChild(btn);
    }

    // floating stick: appears where the left thumb lands
    move.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      if (this.stickId !== null) return;
      this.stickId = t.identifier;
      this.stickOrigin = { x: t.clientX, y: t.clientY };
      this.stick.style.left = `${t.clientX - 64}px`;
      this.stick.style.top = `${t.clientY - 64}px`;
      this.stick.style.bottom = 'auto';
      this.stick.classList.add('active');
    }, { passive: false });
    move.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== this.stickId) continue;
        let dx = t.clientX - this.stickOrigin.x, dy = t.clientY - this.stickOrigin.y;
        const len = Math.hypot(dx, dy);
        const max = 56;
        // the stick base follows a thumb that drifts too far, like most mobile shooters
        if (len > max * 1.6) {
          const k = (len - max) / len;
          this.stickOrigin.x += dx * k; this.stickOrigin.y += dy * k;
          this.stick.style.left = `${this.stickOrigin.x - 64}px`;
          this.stick.style.top = `${this.stickOrigin.y - 64}px`;
          dx = t.clientX - this.stickOrigin.x; dy = t.clientY - this.stickOrigin.y;
        }
        const l2 = Math.hypot(dx, dy);
        if (l2 > max) { dx *= max / l2; dy *= max / l2; }
        this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
        // small dead zone, then full speed sooner than linear (easier to sprint on glass)
        const mag = Math.min(1, l2 / max);
        const curved = mag < 0.12 ? 0 : Math.min(1, (mag - 0.12) / 0.7);
        const nx = l2 > 0 ? dx / l2 : 0, ny = l2 > 0 ? dy / l2 : 0;
        this.input.touchMove = { x: nx * curved, y: -ny * curved };
      }
    }, { passive: false });
    const endMove = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== this.stickId) continue;
        this.stickId = null;
        this.knob.style.transform = '';
        this.stick.classList.remove('active');
        this.stick.style.left = '';
        this.stick.style.top = '';
        this.stick.style.bottom = '';
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
      this.input.addLook(dx * 0.0062, dy * 0.0062);
    }
  }

  setMode(mode: Mode | 'off'): void {
    this.mode = mode;
    this.el.classList.toggle('hidden', mode === 'off');
    this.el.dataset.mode = mode;
    for (const b of BUTTONS) {
      const btn = this.buttons.get(b.id)!;
      btn.style.display = mode !== 'off' && b.modes.includes(mode) ? '' : 'none';
    }
    for (const id of [...this.toggled]) { const b = BUTTONS.find((x) => x.id === id)!; this.input.release(b.action); this.buttons.get(id)!.classList.remove('on'); }
    this.toggled.clear();
  }

  /** Context label for the action button; the button only shows while something is available. */
  setUseLabel(label: string | null): void {
    const b = this.buttons.get('use')!;
    const span = b.querySelector('span');
    if (span) span.textContent = label ?? 'USE';
    b.classList.toggle('available', !!label);
  }

  /** Grenade button only when the player carries one. */
  setGrenadeAvailable(v: boolean): void { this.buttons.get('grenade')!.classList.toggle('dim', !v); }

  setScale(s: number): void { this.el.style.setProperty('--touch-scale', String(s)); }
}
