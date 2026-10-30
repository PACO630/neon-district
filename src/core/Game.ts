// Top-level orchestrator: boot, main loop, mode switching (menu → city ↔ arena), host authority
// lifecycle (RoomAuthority / MatchHost), host migration UI and settings application.
import { ArenaScene } from '../arena/ArenaScene';
import { MatchHost } from '../arena/MatchHost';
import { AudioEngine } from '../audio/AudioEngine';
import { CityScene } from '../city/CityScene';
import { isMobile, loadSettings, saveSettings, type Settings } from '../config/settings';
import { Assets } from '../engine/Assets';
import { Renderer } from '../engine/Renderer';
import { installShaderChunks } from '../engine/shaders';
import { TouchControls } from '../mobile/TouchControls';
import { Net } from '../networking/Net';
import { encodeArenaInput, encodeFire, MSG } from '../networking/protocol';
import { initPhysics, Physics } from '../physics/Physics';
import { Input } from '../player/Input';
import { Room } from '../room/Room';
import { RoomAuthority } from '../room/RoomAuthority';
import { ArenaHud } from '../ui/ArenaHud';
import { CityHud } from '../ui/CityHud';
import { h, modal } from '../ui/dom';
import { loadingScreen, mainMenu, settingsPanel } from '../ui/Menus';
import { armoryPanel, barPanel, gatePanel, pauseMenu, vaultPanel } from '../ui/RoomPanels';
import type { GameContext } from './GameContext';

export type Mode = 'boot' | 'menu' | 'city' | 'arena';

export class Game implements GameContext {
  settings: Settings = loadSettings();
  readonly mobile = isMobile();
  renderer!: Renderer;
  input!: Input;
  readonly audio = new AudioEngine();
  net = new Net();
  room!: Room;
  touch!: TouchControls;
  city: CityScene | null = null;
  arena: ArenaScene | null = null;
  matchHost: MatchHost | null = null;
  cityHud!: CityHud;
  arenaHud!: ArenaHud;
  mode: Mode = 'boot';
  fps = 0;
  private ui!: HTMLElement;
  private menuEl: HTMLElement | null = null;
  private toastsEl!: HTMLElement;
  private last = performance.now();
  private lastFrame = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private migrateEl: HTMLElement | null = null;
  private joinPending = false;
  private arenaLoading = false;
  private authority: RoomAuthority | null = null;

  async boot(): Promise<void> {
    if (this.mobile) document.body.classList.add('is-mobile');
    const loading = loadingScreen();
    try {
      installShaderChunks();
      this.renderer = new Renderer(document.body);
      this.renderer.apply(this.settings.graphics);
    } catch (e) {
      loading.set(0, 'WebGL 2 is not available on this device/browser.');
      throw e;
    }
    this.ui = h('div', { id: 'ui' });
    document.body.appendChild(this.ui);
    this.toastsEl = h('div', { id: 'toasts' });
    document.body.appendChild(this.toastsEl);
    this.input = new Input(this.renderer.gl.domElement);
    this.touch = new TouchControls(this.input, document.body);
    this.applyControls();
    this.applyAudio();
    this.setupRoom();
    this.cityHud = new CityHud(this);
    this.arenaHud = new ArenaHud(this);
    this.ui.append(this.cityHud.el, this.arenaHud.el, this.cityHud.chatEl);
    this.cityHud.chatEl.classList.add('hidden');
    loading.set(0.05, 'Loading 3D models');
    await Promise.all([Assets.load((p) => loading.set(0.05 + p * 0.25, 'Loading 3D models')), initPhysics()]);
    this.city = new CityScene(this);
    await this.city.load((p, label) => loading.set(0.3 + p * 0.65, label));
    this.city.setPuddleMask(this.city.build.puddleMask as any);
    this.city.onInteract = (kind) => this.onCityInteract(kind);
    this.city.onSpeech = (n, l) => this.cityHud.showSpeech(n, l);
    // first-gesture audio unlock
    const unlock = () => { this.audio.unlock(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    this.input.onLockChange = (locked) => {
      if (!locked && this.input.wantLock && (this.mode === 'city' || this.mode === 'arena') && !document.querySelector('.modal-wrap') && !this.arenaHud.buyOpen && document.activeElement?.tagName !== 'INPUT') {
        pauseMenu(this);
      }
    };
    window.addEventListener('beforeunload', () => { if (this.room.state) this.net.shutdown(); });
    this.showMenu();
    loading.set(1, 'Welcome to NEON DISTRICT');
    loading.done();
    requestAnimationFrame(this.frame);
  }

  newPhysics = () => new Physics();

  toast = (text: string, kind: 'info' | 'error' | 'success' | 'warn' = 'info') => {
    if (!text) return;
    const el = h('div', { class: `panel toast ${kind}` }, text);
    this.toastsEl.appendChild(el);
    while (this.toastsEl.children.length > 4) this.toastsEl.firstChild!.remove();
    setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 420); }, kind === 'error' ? 5000 : 3200);
  };

  // ============================================================== room wiring
  private setupRoom(): void {
    this.net = new Net();
    this.room = new Room(this.net, { name: this.settings.name || 'Runner', device: this.mobile ? 'mobile' : 'pc', look: this.settings.look, finish: this.settings.finish });
    // social authority is registered on every peer; it only executes while this peer is host
    this.authority = new RoomAuthority(this.room, () => this.startMatch());
    this.room.hostHooks.onBecameHost.push((stale) => this.onBecameHost(stale));
    this.room.on('state', (s) => this.onRoomState());
    this.room.on('joined', () => { this.toast('Connected to host. Syncing room…', 'success'); });
    this.room.on('hostChanged', (id, self) => {
      if (this.migrateEl) { this.migrateEl.remove(); this.migrateEl = null; }
      if (this.mode === 'city' || this.mode === 'arena') this.toast(self ? 'You are now the HOST.' : `Host is now ${this.room.player(id)?.name ?? id}.`, 'info');
    });
    this.room.on('migrating', (msg) => {
      this.migrateEl?.remove();
      this.migrateEl = h('div', { class: 'panel migrate' }, h('span', { class: 'spinner' }), h('div', null, h('b', null, 'HOST MIGRATION'), h('br'), msg));
      document.body.appendChild(this.migrateEl);
    });
    this.room.on('migrationFailed', (msg) => { this.migrateEl?.remove(); this.migrateEl = null; this.toast(msg, 'error'); });
    this.room.on('closed', (reason) => this.onRoomClosed(reason));
    this.room.on('peerLeft', (id, name) => { this.city?.removeRemote(id); void name; });
    this.room.on('event', (ev) => {
      if (ev.e === 'matchEnd') { this.toast(ev.reason ?? 'Match ended.', 'info'); }
    });
    this.net.onJson(MSG.BYE, (_from, m) => { if (m.reason && m.reason !== 'leave' && !this.room.state) this.toast(m.reason, 'error'); });
  }

  async hostRoom(): Promise<void> {
    this.audio.unlock();
    this.room.profile = { ...this.room.profile, name: this.settings.name, look: this.settings.look, finish: this.settings.finish };
    this.net.selfName = this.settings.name;
    this.room.createRoom();
    this.enterCity();
    this.toast('Room created. Open ROOM · INVITES to invite friends.', 'success');
  }

  async joinStart(code: string): Promise<{ answer: string; hostName: string }> {
    this.audio.unlock();
    this.net.selfName = this.settings.name;
    this.room.profile = { ...this.room.profile, name: this.settings.name, look: this.settings.look, finish: this.settings.finish };
    this.net.start();
    this.joinPending = true;
    const r = await this.net.answerInvite(code);
    return { answer: r.answer, hostName: r.hostName };
  }

  leaveRoom(): void {
    this.room.leave('You left the room.');
  }

  private onRoomClosed(reason: string): void {
    this.applyRain(true);
    this.matchHost?.dispose();
    this.matchHost = null;
    this.joinPending = false;
    if (this.mode === 'arena') this.exitArena();
    this.city?.exit();
    this.migrateEl?.remove();
    this.migrateEl = null;
    // rebuild a fresh transport for the next session
    this.setupRoom();
    document.querySelectorAll('.modal-wrap').forEach((m) => m.remove());
    this.showMenu();
    this.toast(reason, 'info');
  }

  private onRoomState(): void {
    const s = this.room.state;
    if (!s) return;
    this.applyRain(s.rain !== false);
    if (this.joinPending && s.players[this.room.selfId]) {
      this.joinPending = false;
      document.querySelectorAll('.modal-wrap').forEach((m) => m.remove());
      this.enterCity();
      this.toast(`Joined room ${s.roomId}.`, 'success');
    }
    const inMatch = !!s.match && !!s.match.players[this.room.selfId];
    if (inMatch && this.mode === 'city') this.enterArena();
    if (!inMatch && this.mode === 'arena') { this.exitArena(); this.enterCity(true); }
    // host: run the match simulation if a match exists
    if (this.room.isHost && s.match && !this.matchHost && !this.room.migrating) {
      this.matchHost = new MatchHost(this.room);
      this.matchHost.begin(false, 0);
    }
    if (!s.match && this.matchHost) { this.matchHost.dispose(); this.matchHost = null; }
  }

  /** Host-controlled weather → visuals and audio on every client. */
  applyRain(on: boolean): void {
    this.city?.setRain(on);
    this.arena?.setRain(on);
    this.audio.setRain(on);
  }

  private startMatch() {
    const r = MatchHost.create(this.room);
    if (!r.ok) return r;
    this.matchHost?.dispose();
    this.matchHost = new MatchHost(this.room);
    this.matchHost.begin(true);
    return r;
  }

  private onBecameHost(staleMs: number): void {
    const s = this.room.state;
    if (s?.match) {
      this.matchHost?.dispose();
      this.matchHost = new MatchHost(this.room);
      this.matchHost.begin(false, staleMs);
    }
  }

  // ============================================================== modes
  private showMenu(): void {
    this.mode = 'menu';
    document.body.classList.remove('in-game', 'mode-arena');
    this.cityHud.show(false);
    this.arenaHud.show(false);
    this.cityHud.chatEl.classList.add('hidden');
    this.city?.enterMenu();
    this.menuEl?.remove();
    this.menuEl = mainMenu(this);
    this.ui.appendChild(this.menuEl);
  }

  private enterCity(fromArena = false): void {
    this.menuEl?.remove();
    this.menuEl = null;
    this.mode = 'city';
    document.body.classList.add('in-game');
    this.city!.enter();
    if (fromArena) this.city!.respawnAtGate();
    this.cityHud.show(true);
    this.arenaHud.show(false);
    this.cityHud.chatEl.classList.remove('hidden');
    if (!this.settings.seenTutorial) {
      this.settings.seenTutorial = true;
      saveSettings(this.settings);
      this.cityHud.showSpeech('CITY GUIDE', this.mobile ? 'Left thumb moves, right thumb looks. Tap USE near glowing doors and people.' : 'Click to capture the mouse. WASD to move, E to interact. Head NORTH to the Tactical Gate for matches.');
    }
  }

  private async enterArena(): Promise<void> {
    if (this.arenaLoading) return;
    this.arenaLoading = true;
    document.querySelectorAll('.modal-wrap').forEach((m) => m.remove());
    this.toast('Deploying to SECTOR 09…', 'info');
    if (!this.arena) {
      const a = new ArenaScene(this);
      await a.load(() => {});
      this.arena = a;
    }
    this.arenaLoading = false;
    if (!this.room.state?.match?.players[this.room.selfId]) return; // match ended while loading
    this.city!.exit();
    this.mode = 'arena';
    const a = this.arena;
    a.sendInput = (inp) => {
      if (this.room.isHost) this.matchHost?.localInput(inp);
      else this.net.send(this.room.state!.hostId, encodeArenaInput(inp), false);
    };
    a.sendFire = (f) => {
      if (this.room.isHost) this.matchHost?.localFire(f);
      else this.net.send(this.room.state!.hostId, encodeFire(f), true);
    };
    a.onBuyToggle = () => this.arenaHud.toggleBuy();
    a.enter();
    this.applyRain(this.room.state?.rain !== false);
    document.body.classList.add('mode-arena');
    this.cityHud.show(false);
    this.arenaHud.show(true);
  }

  private exitArena(): void {
    this.arena?.exit();
    document.body.classList.remove('mode-arena');
    this.arenaHud.show(false);
  }

  private onCityInteract(kind: string): void {
    this.input.exitLock();
    if (kind === 'armory') armoryPanel(this);
    else if (kind === 'vault') vaultPanel(this);
    else if (kind === 'bar') barPanel(this);
    else if (kind === 'gate') gatePanel(this);
    else if (kind === 'kiosk') {
      const m = modal('CITY DIRECTORY', { size: 'narrow' });
      this.ui.appendChild(m.root);
      m.body.append(h('ul', { class: 'note', style: 'margin:0;padding-left:18px;line-height:1.8' },
        h('li', null, h('b', null, 'TACTICAL GATE'), ' — north end of the main street. Match setup & arena.'),
        h('li', null, h('b', null, 'AFTERLIFE BAR'), ' — north-east, door on the street side. Drinks & dancing.'),
        h('li', null, h('b', null, 'ARMORY'), ' — east street. Weapon catalog and finishes.'),
        h('li', null, h('b', null, 'NIGHT MARKET'), ' — west lane under the red lanterns.'),
        h('li', null, h('b', null, 'BLACK VAULT'), ' — south street, stairs down on the west sidewalk. Cosmetics for credits.'),
      ));
    }
  }

  // ============================================================== settings
  saveSettings(): void { saveSettings(this.settings); }
  openSettings(): void { settingsPanel(this); }
  applyAudio(): void { this.audio.setVolumes(this.settings.audio); }
  applyControls(): void {
    const c = this.settings.controls;
    this.input.sensitivity = c.sensitivity;
    this.input.invertY = c.invertY;
    this.input.touchSensitivity = c.touchSensitivity;
    this.touch.setScale(c.touchLayoutScale);
  }
  /** Applies graphics settings. Heavy changes (textures, shadows, particles) rebuild scenes. */
  async applyGraphics(rebuild = false): Promise<void> {
    this.saveSettings();
    this.renderer.apply(this.settings.graphics);
    if (!rebuild) return;
    const wasMode = this.mode;
    // rebuild city (and drop cached arena; it reloads on the next match)
    const oldCity = this.city!;
    const newCity = new CityScene(this);
    this.toast('Rebuilding scene…', 'info');
    await newCity.load(() => {});
    newCity.setPuddleMask(newCity.build.puddleMask as any);
    newCity.onInteract = (kind) => this.onCityInteract(kind);
    newCity.onSpeech = (n, l) => this.cityHud.showSpeech(n, l);
    if (wasMode === 'city') oldCity.exit();
    this.city = newCity;
    if (this.mode === 'arena') {
      // keep playing in the current arena; it will be rebuilt for the next match
      this.renderer.apply(this.settings.graphics);
    } else {
      this.arena = null;
      if (wasMode === 'city') this.city.enter();
      else if (wasMode === 'menu') this.city.enterMenu();
    }
    if (this.mode !== 'arena') this.arena = null;
  }

  // ============================================================== frame loop
  private frame = (now: number) => {
    requestAnimationFrame(this.frame);
    const limit = this.settings.graphics.fpsLimit;
    if (limit && now - this.lastFrame < 1000 / limit - 1.5) return;
    this.lastFrame = now;
    const dtMs = now - this.last;
    this.last = now;
    const dt = Math.min(0.05, dtMs / 1000);
    this.fpsAcc += dtMs;
    this.fpsFrames++;
    if (this.fpsAcc > 500) { this.fps = Math.round((this.fpsFrames * 1000) / this.fpsAcc); this.fpsAcc = 0; this.fpsFrames = 0; }
    if (this.input.pressed('menu') && (this.mode === 'city' || this.mode === 'arena')) {
      if (this.arenaHud.buyOpen) this.arenaHud.closeBuy();
      else if (!document.querySelector('.modal-wrap')) pauseMenu(this);
    }
    const modalOpen = !!document.querySelector('.modal-wrap') || this.arenaHud.buyOpen;
    this.input.enabled = !modalOpen && !this.input.typing;
    try {
      if (this.mode === 'menu' || this.mode === 'boot') this.city?.update(dt);
      else if (this.mode === 'city') { this.city!.update(dt); this.cityHud.update(dt); }
      else if (this.mode === 'arena' && this.arena) { this.arena.update(dt); this.arenaHud.update(dt); }
    } catch (e) { console.error(e); }
    this.audio.setListener(this.renderer.camera);
    this.renderer.render(dt);
    this.renderer.trackFrame(dtMs);
    this.input.clearEdges();
  };
}
