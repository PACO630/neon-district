// NEON CITY HUD: identity card, district label, room buttons, interaction prompt, NPC speech, chat.
import type { Game } from '../core/Game';
import type { ChatLine } from '../room/Room';
import { h, replace } from './dom';
import { gatePanel, invitesPanel, partyPanel, pauseMenu, playersPanel } from './RoomPanels';

const DISTRICTS: { name: string; test: (x: number, z: number, y: number) => boolean }[] = [
  { name: 'BLACK VAULT', test: (x, z, y) => y < -1 },
  { name: 'AFTERLIFE BAR', test: (x, z) => x > 10 && x < 30 && z > -66 && z < -44 },
  { name: 'ARMORY', test: (x, z) => x > 46 && x < 70 && z > -30 && z < -10 },
  { name: 'TACTICAL GATE', test: (x, z) => z < -95 && Math.abs(x) < 24 },
  { name: 'NIGHT MARKET', test: (x, z) => x < -34 && Math.abs(z) < 8 },
  { name: 'CENTRAL PLAZA', test: (x, z) => Math.abs(x) < 24 && Math.abs(z) < 24 },
];

export class CityHud {
  readonly el: HTMLElement;
  private idName = h('div', { class: 'name' });
  private idMeta = h('div', { class: 'meta' });
  private district = h('div', { class: 'panel district' });
  private prompt = h('div', { class: 'panel prompt hidden' });
  private speech = h('div', { class: 'panel speech hidden' });
  private speechTimer = 0;
  private chatLog = h('div', { class: 'chat-log panel' });
  private chatInput: HTMLInputElement;
  private chatCh: HTMLSelectElement;
  private chatWrap: HTMLElement;
  get chatEl(): HTMLElement { return this.chatWrap; }
  private playersBtn = h('span', { class: 'count' });
  private partyBtn: HTMLButtonElement;
  private chatIdleTimer = 0;
  private lastDistrict = '';

  constructor(private game: Game) {
    this.chatInput = h('input', { class: 'input', maxlength: 200, placeholder: 'Press Enter to chat' }) as HTMLInputElement;
    this.chatCh = h('select', { class: 'input' }, h('option', { value: 'all' }, 'ALL'), h('option', { value: 'party' }, 'PARTY')) as HTMLSelectElement;
    this.chatInput.addEventListener('focus', () => { game.input.typing = true; this.chatWrap.classList.remove('idle'); });
    this.chatInput.addEventListener('blur', () => { game.input.typing = false; });
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const err = game.room.sendChat(this.chatInput.value, this.chatCh.value as 'all' | 'party');
        if (err) game.toast(err, 'warn');
        this.chatInput.value = '';
        this.chatInput.blur();
        if (!game.mobile) game.input.requestLock();
      } else if (e.key === 'Escape') { this.chatInput.blur(); }
    });
    this.chatWrap = h('div', { class: 'chat idle' }, this.chatLog, h('div', { class: 'chat-input' }, this.chatCh, this.chatInput));
    this.partyBtn = h('button', { class: 'btn', on: { click: () => this.open(() => partyPanel(game)) } }, 'Party') as HTMLButtonElement;
    this.el = h('div', { id: 'city-hud', class: 'hidden' },
      h('div', { class: 'hud-topleft' },
        h('div', { class: 'panel id-card' }, h('div', { class: 'avatar' }, 'N'), h('div', { class: 'col', style: 'gap:4px' }, this.idName, this.idMeta)),
        this.district,
      ),
      h('div', { class: 'hud-topright' },
        h('button', { class: 'btn', on: { click: () => this.open(() => invitesPanel(game)) } }, 'Room · Invites'),
        h('button', { class: 'btn', on: { click: () => this.open(() => playersPanel(game)) } }, 'Players ', this.playersBtn),
        this.partyBtn,
        h('button', { class: 'btn', on: { click: () => this.open(() => gatePanel(game)) } }, 'Arena'),
        h('button', { class: 'btn', on: { click: () => this.open(() => pauseMenu(game)) } }, '☰'),
      ),
      this.prompt, this.speech,
      h('div', { class: 'panel hint-bar' }, h('span', null, h('span', { class: 'kbd' }, 'E'), ' interact'), h('span', null, h('span', { class: 'kbd' }, 'Enter'), ' chat'), h('span', null, h('span', { class: 'kbd' }, 'Z'), '/', h('span', { class: 'kbd' }, 'X'), ' emote'), h('span', null, h('span', { class: 'kbd' }, 'Esc'), ' menu')),
    );
    game.room.on('chat', (l) => this.addChat(l));
    game.room.on('event', (ev) => {
      if (ev.e === 'system') this.addChat({ from: '', name: '', ch: 'system', text: ev.text, ts: Date.now() });
      if (ev.e === 'partyInvite') { game.toast(`${ev.from} invited you to "${ev.name}". Open PARTY to accept.`, 'info'); game.audio.ui('notify'); }
      if (ev.e === 'toast') game.toast(ev.text, 'info');
    });
  }

  private open(fn: () => void): void {
    this.game.input.exitLock();
    this.game.audio.ui('click');
    fn();
  }

  focusChat(): void {
    this.game.input.exitLock();
    this.chatInput.focus();
  }

  addChat(l: ChatLine): void {
    const line = h('div', { class: `line ${l.ch}` },
      l.ch === 'party' ? h('span', { class: 'ch' }, '[P]') : null,
      l.ch !== 'system' ? h('span', { class: 'who' }, l.name) : null,
      l.text);
    this.chatLog.appendChild(line);
    while (this.chatLog.children.length > 80) this.chatLog.firstChild!.remove();
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
    this.chatWrap.classList.remove('idle');
    this.chatIdleTimer = 8;
  }

  showSpeech(name: string, line: string): void {
    replace(this.speech, h('b', null, name), line);
    this.speech.classList.remove('hidden');
    this.speechTimer = 4.5;
  }

  show(v: boolean): void { this.el.classList.toggle('hidden', !v); }

  update(dt: number): void {
    const g = this.game;
    if (g.input.pressed('chat')) this.focusChat();
    const s = g.room.state;
    const me = g.room.self;
    if (!s || !me) return;
    this.idName.textContent = me.name;
    const ping = s.hostId === g.room.selfId ? 'HOST' : `${Math.round(g.net.rtt(s.hostId))} ms to host`;
    this.idMeta.innerHTML = '';
    this.idMeta.append(`ROOM ${s.roomId} · ${ping} · `, h('span', { class: 'credits' }, `₵${me.credits}`));
    this.playersBtn.textContent = `${Object.keys(s.players).length}/10`;
    const inv = Object.values(s.parties).some((p) => p.invites.includes(g.room.selfId));
    this.partyBtn.textContent = inv ? 'Party •' : 'Party';
    this.partyBtn.classList.toggle('active', inv);
    const city = g.city;
    if (city) {
      const p = city.playerPos;
      const d = DISTRICTS.find((x) => x.test(p.x, p.z, p.y))?.name ?? 'NEON CITY';
      if (d !== this.lastDistrict) { this.lastDistrict = d; this.district.textContent = `◢ ${d}`; }
      if (city.prompt) {
        replace(this.prompt, h('span', { class: 'kbd' }, g.mobile ? 'USE' : city.prompt.key), city.prompt.label);
        this.prompt.classList.remove('hidden');
      } else this.prompt.classList.add('hidden');
    }
    if (this.speechTimer > 0 && (this.speechTimer -= dt) <= 0) this.speech.classList.add('hidden');
    if (this.chatIdleTimer > 0 && (this.chatIdleTimer -= dt) <= 0 && document.activeElement !== this.chatInput) this.chatWrap.classList.add('idle');
    if (g.input.pressed('players')) this.open(() => playersPanel(g));
  }
}
