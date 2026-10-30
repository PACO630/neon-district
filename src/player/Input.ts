// Unified input: keyboard + mouse (pointer lock) on PC, virtual sticks/buttons on touch devices.
export type Action =
  | 'fire' | 'aim' | 'reload' | 'jump' | 'crouch' | 'walk' | 'sprint' | 'interact'
  | 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'slot5' | 'nextWeapon' | 'prevWeapon'
  | 'scoreboard' | 'menu' | 'chat' | 'buy' | 'drop' | 'emote1' | 'emote2' | 'emote3' | 'players' | 'inspect';

const KEYMAP: Record<string, Action> = {
  KeyR: 'reload', Space: 'jump', ControlLeft: 'crouch', KeyC: 'crouch', ShiftLeft: 'walk', KeyE: 'interact',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4', Digit5: 'slot5',
  Tab: 'scoreboard', Escape: 'menu', Enter: 'chat', KeyT: 'chat', KeyB: 'buy', KeyG: 'drop',
  KeyZ: 'emote1', KeyX: 'emote2', KeyV: 'emote3', KeyP: 'players', KeyF: 'inspect',
};

export class Input {
  private held = new Set<Action>();
  private pressedOnce = new Set<Action>();
  private keys = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  touchMove = { x: 0, y: 0 };
  locked = false;
  enabled = true;
  sensitivity = 1;
  touchSensitivity = 1;
  invertY = false;
  /** When true, keyboard events are ignored (typing in chat / forms). */
  typing = false;
  /** Whether gameplay wants pointer lock (city / arena) */
  wantLock = false;
  onLockChange: (locked: boolean) => void = () => {};

  constructor(private canvas: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (this.typing || this.isFormTarget(e.target)) return;
      if (e.code === 'Tab' || e.code === 'Space' || (e.code.startsWith('Digit') && this.wantLock)) e.preventDefault();
      this.keys.add(e.code);
      const a = KEYMAP[e.code];
      if (a && !e.repeat) this.press(a);
      if (e.code === 'ShiftRight') this.press('walk');
      if (e.code === 'KeyQ' && !e.repeat) this.press('prevWeapon');
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      const a = KEYMAP[e.code];
      if (a) this.release(a);
      if (e.code === 'ShiftRight') this.release('walk');
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.held.clear(); });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked && this.wantLock) { this.requestLock(); return; }
      if (e.button === 0) this.press('fire');
      if (e.button === 2) this.press('aim');
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.release('fire');
      if (e.button === 2) this.release('aim');
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      this.press(e.deltaY > 0 ? 'nextWeapon' : 'prevWeapon');
      this.release(e.deltaY > 0 ? 'nextWeapon' : 'prevWeapon');
    }, { passive: true });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // clamp absurd spikes some browsers emit on lock
      const mx = Math.max(-200, Math.min(200, e.movementX));
      const my = Math.max(-200, Math.min(200, e.movementY));
      this.lookX += mx * 0.0022 * this.sensitivity;
      this.lookY += my * 0.0022 * this.sensitivity * (this.invertY ? -1 : 1);
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this.held.delete('fire'); this.held.delete('aim'); }
      this.onLockChange(this.locked);
    });
  }

  private isFormTarget(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  }

  requestLock(): void {
    if (this.locked || !this.wantLock) return;
    const p = (this.canvas as any).requestPointerLock?.({ unadjustedMovement: true });
    if (p && typeof p.catch === 'function') p.catch(() => (this.canvas as any).requestPointerLock?.());
  }
  exitLock(): void { if (document.pointerLockElement) document.exitPointerLock(); }

  press(a: Action): void { if (!this.held.has(a)) this.pressedOnce.add(a); this.held.add(a); }
  release(a: Action): void { this.held.delete(a); }
  isHeld(a: Action): boolean { return this.enabled && this.held.has(a); }
  /** Edge-triggered: true once per press. */
  pressed(a: Action): boolean {
    if (!this.pressedOnce.has(a)) return false;
    this.pressedOnce.delete(a);
    return this.enabled;
  }
  addLook(dx: number, dy: number): void {
    this.lookX += dx * this.touchSensitivity;
    this.lookY += dy * this.touchSensitivity * (this.invertY ? -1 : 1);
  }
  consumeLook(): { dx: number; dy: number } {
    const r = { dx: this.lookX, dy: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return this.enabled ? r : { dx: 0, dy: 0 };
  }
  /** Movement vector: x = strafe right, y = forward. */
  move(): { x: number; y: number } {
    if (!this.enabled || this.typing) return { x: 0, y: 0 };
    let x = 0, y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    x += this.touchMove.x;
    y += this.touchMove.y;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y };
  }
  clearEdges(): void { this.pressedOnce.clear(); }
  reset(): void { this.held.clear(); this.pressedOnce.clear(); this.keys.clear(); this.lookX = this.lookY = 0; this.touchMove = { x: 0, y: 0 }; }
}
