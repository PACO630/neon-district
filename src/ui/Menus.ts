// Loading screen, main menu, play (host / join with manual signaling), settings, profile, news.
import { applyPreset, type Level, type Settings } from '../config/settings';
import { FINISHES } from '../config/weapons';
import { downloadText, pickTextFile } from '../networking/signaling/manual';
import type { Game } from '../core/Game';
import { h, modal, replace } from './dom';
import { Preview } from './Preview';
import { copyText, qrCanvas, scanQR, shareText } from './qr';
import { getLang, LANGS, setLang, type Lang } from '../i18n';

/** EN / 中文 / 日本語 switcher; persists the choice in local settings. */
export function languagePicker(game: Game): HTMLElement {
  const el = h('div', { class: 'seg lang-picker', 'data-no-i18n': true });
  const draw = () => replace(el, ...LANGS.map((l) => h('button', { class: getLang() === l.id ? 'on' : '', on: { click: () => { game.settings.language = l.id; game.saveSettings(); setLang(l.id as Lang); draw(); game.audio.ui('click'); } } }, l.label)));
  draw();
  return el;
}

export function loadingScreen(): { el: HTMLElement; set: (p: number, label: string) => void; done: () => void } {
  const bar = h('i');
  const status = h('div', { class: 'status' }, 'Booting');
  const el = h('div', { id: 'loading' },
    h('div', { class: 'logo' }, 'NEON ', h('span', null, 'DISTRICT')),
    h('div', { class: 'loadbar' }, bar),
    status,
  );
  document.body.appendChild(el);
  return {
    el,
    set: (p, label) => { bar.style.width = `${Math.round(p * 100)}%`; status.textContent = label; },
    done: () => { el.style.transition = 'opacity .5s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 520); },
  };
}

export function mainMenu(game: Game): HTMLElement {
  const item = (label: string, sub: string, fn: () => void, cls = '') =>
    h('button', { class: `menu-item ${cls}`, on: { click: () => { game.audio.unlock(); game.audio.ui('click'); fn(); }, mouseenter: () => game.audio.ui('hover') } }, label, h('small', null, sub));
  return h('div', { id: 'menu' },
    h('div', { class: 'left' },
      h('div', { class: 'menu-logo' }, 'NEON', h('span', null, 'DISTRICT'), h('small', null, 'P2P · CYBERPUNK · TACTICAL')),
      h('nav', { class: 'menu-list' },
        item('PLAY', 'HOST / JOIN', () => playPanel(game), 'primary'),
        item('PROFILE', 'IDENTITY', () => profilePanel(game)),
        item('SETTINGS', 'GRAPHICS · AUDIO', () => settingsPanel(game)),
        item('NEWS', 'PATCH NOTES', () => newsPanel()),
        item('EXIT', 'CLOSE', () => exitPanel()),
      ),
      h('div', { class: 'menu-foot' }, 'Serverless WebRTC mesh · up to 10 players', h('br'), 'No accounts · nothing is stored in the cloud'),
    ),
    h('div', { class: 'right' },
      h('div', { class: 'menu-lang' }, h('span', { class: 'label' }, 'LANGUAGE'), languagePicker(game)),
      h('div', { class: 'panel menu-card' },
        h('h3', null, '// HOW MULTIPLAYER WORKS'),
        h('p', null, 'There is no game server. The host creates a room and sends each friend a one-time INVITE code. The friend answers with a REPLY code that the host pastes back. After that, everyone connects directly to everyone else.'),
      ),
    ),
  );
}

// ---------------------------------------------------------------- PLAY
export function playPanel(game: Game): void {
  const m = modal('PLAY', { tag: 'P2P', size: 'narrow' });
  document.getElementById('ui')!.appendChild(m.root);
  const s = game.settings;
  const nameInput = h('input', { class: 'input', maxlength: 16, placeholder: 'Your street name', value: s.name }) as HTMLInputElement;
  const tabs = h('div', { class: 'tabs' });
  const pane = h('div', { class: 'col', style: 'margin-top:14px' });
  const setTab = (t: 'host' | 'join') => {
    replace(tabs,
      h('button', { class: t === 'host' ? 'on' : '', on: { click: () => setTab('host') } }, 'Host a room'),
      h('button', { class: t === 'join' ? 'on' : '', on: { click: () => setTab('join') } }, 'Join a room'));
    replace(pane, t === 'host' ? hostPane() : joinPane());
  };
  const commitName = (): boolean => {
    const v = nameInput.value.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
    if (!v) { game.toast('Enter a nickname first.', 'warn'); nameInput.focus(); return false; }
    s.name = v;
    game.saveSettings();
    return true;
  };
  const hostPane = () => h('div', { class: 'col' },
    h('ol', { class: 'steps' },
      h('li', null, h('span', null, 'Create the room — you enter ', h('b', null, 'NEON CITY'), ' immediately as the host.')),
      h('li', null, h('span', null, 'Open ', h('b', null, 'ROOM · INVITES'), ' (top right). Generate one invite ', h('b', null, 'per friend'), ' and send it (copy, QR or file).')),
      h('li', null, h('span', null, 'Your friend pastes it and sends you back a ', h('b', null, 'REPLY'), ' code. Paste it into the same invite slot. Done.')),
    ),
    h('div', { class: 'note' }, 'Keep this tab open: the room exists only while players are connected. If you leave, the next player in join order becomes host.'),
    h('button', { class: 'btn primary', on: { click: async () => { if (!commitName()) return; m.close(); await game.hostRoom(); } } }, 'Create room'),
  );
  const joinPane = () => {
    const code = h('textarea', { class: 'input', placeholder: 'Paste the INVITE code from the host (starts with NDX-INVITE.)' }) as HTMLTextAreaElement;
    const out = h('div', { class: 'col' });
    const scanBox = h('div');
    let scanning: { stop: () => void } | null = null;
    const go = async () => {
      if (!commitName()) return;
      out.replaceChildren(h('div', { class: 'row note' }, h('span', { class: 'spinner' }), 'Gathering network routes (ICE)… this takes a few seconds.'));
      try {
        const res = await game.joinStart(code.value);
        const qr = await qrCanvas(res.answer);
        const ta = h('textarea', { class: 'input', readonly: true }, res.answer) as HTMLTextAreaElement;
        out.replaceChildren(
          h('div', { class: 'ok' }, `Invite accepted from host "${res.hostName}".`),
          h('div', { class: 'note' }, 'Now send this ', h('b', null, 'REPLY'), ' code back to the host. They paste it into your invite slot. This window will continue automatically once connected.'),
          h('div', { class: 'code-box' }, ta, qr),
          h('div', { class: 'row' },
            h('button', { class: 'btn', on: { click: async () => game.toast((await copyText(res.answer)) ? 'Reply copied.' : 'Copy failed — select the text manually.', 'info') } }, 'Copy'),
            typeof navigator.share === 'function' && 'share' in navigator ? h('button', { class: 'btn', on: { click: () => shareText(res.answer, 'NEON DISTRICT reply') } }, 'Share') : null,
            h('button', { class: 'btn', on: { click: () => downloadText('neon-district-reply.txt', res.answer) } }, 'Save file'),
          ),
          h('div', { class: 'row note' }, h('span', { class: 'spinner' }), 'Waiting for the host to paste your reply…'),
        );
      } catch (e) {
        out.replaceChildren(h('div', { class: 'err' }, (e as Error).message));
      }
    };
    return h('div', { class: 'col' },
      h('ol', { class: 'steps' },
        h('li', null, h('span', null, 'Get an ', h('b', null, 'INVITE'), ' from the host (each invite works for one player only).')),
        h('li', null, h('span', null, 'Paste it below, import the file, or scan its QR code.')),
        h('li', null, h('span', null, 'Send the generated ', h('b', null, 'REPLY'), ' back to the host.')),
      ),
      code,
      h('div', { class: 'row' },
        h('button', { class: 'btn', on: { click: async () => { try { code.value = (await pickTextFile()).trim(); } catch (e) { game.toast((e as Error).message, 'error'); } } } }, 'Import file'),
        h('button', { class: 'btn', on: { click: async () => {
          if (scanning) { scanning.stop(); scanning = null; return; }
          const sc = scanQR(scanBox);
          scanning = sc;
          try { code.value = await sc.promise; game.toast('QR code scanned.', 'success'); } catch (e) { if ((e as Error).message !== 'Scan cancelled') game.toast((e as Error).message, 'error'); }
          scanning = null;
        } } }, 'Scan QR'),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn primary', on: { click: go } }, 'Generate reply'),
      ),
      scanBox,
      out,
      h('div', { class: 'note' }, 'Connections are direct (WebRTC) with public STUN for NAT traversal. Some strict corporate / mobile carrier networks block direct connections; there is no relay server, so try another network (e.g. the same Wi-Fi) if it never connects.'),
    );
  };
  m.body.append(h('div', { class: 'field' }, h('span', { class: 'label' }, 'Nickname'), nameInput), h('div', { style: 'height:14px' }), tabs, pane);
  setTab('host');
}

// ---------------------------------------------------------------- SETTINGS
export function settingsPanel(game: Game): void {
  const m = modal('SETTINGS', { size: 'wide', onClose: () => game.saveSettings() });
  document.getElementById('ui')!.appendChild(m.root);
  const s = game.settings;
  const tabs = h('div', { class: 'tabs' });
  const pane = h('div', { style: 'margin-top:16px' });
  const seg = <T extends string | number>(opts: [T, string][], get: () => T, set: (v: T) => void) => {
    const el = h('div', { class: 'seg' });
    const draw = () => replace(el, ...opts.map(([v, l]) => h('button', { class: get() === v ? 'on' : '', on: { click: () => { set(v); draw(); game.audio.ui('click'); } } }, l)));
    draw();
    return el;
  };
  const range = (min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt = (v: number) => `${Math.round(v * 100)}%`) => {
    const out = h('output', null, fmt(get()));
    const r = h('input', { type: 'range', min, max, step, value: get(), on: { input: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); set(v); out.textContent = fmt(v); } } });
    return h('div', { class: 'range-row' }, r, out);
  };
  const g = s.graphics;
  const custom = () => { g.preset = 'CUSTOM'; };
  const lvl: [Level, string][] = [[0, 'Off'], [1, 'Low'], [2, 'Med'], [3, 'High']];
  const graphics = () => {
    const grid = h('div', { class: 'set-grid' },
      h('span', { class: 'label' }, 'Language'),
      languagePicker(game),
      h('span', { class: 'label' }, 'Quality preset'),
      seg<string>([['LOW', 'Low'], ['MEDIUM', 'Medium'], ['HIGH', 'High'], ['CUSTOM', 'Custom']], () => g.preset, (v) => { if (v !== 'CUSTOM') { applyPreset(g, v as 'LOW'); setTab('graphics'); } }),
      h('span', { class: 'label' }, 'Render resolution'),
      range(0.5, 1, 0.05, () => g.renderScale, (v) => { g.renderScale = v; custom(); }),
      h('span', { class: 'label' }, 'Dynamic resolution'),
      seg<string>([['on', 'On'], ['off', 'Off']], () => (g.dynamicResolution ? 'on' : 'off'), (v) => { g.dynamicResolution = v === 'on'; custom(); }),
      h('span', { class: 'label' }, 'Shadow quality'),
      seg(lvl, () => g.shadows, (v) => { g.shadows = v; custom(); }),
      h('span', { class: 'label' }, 'Reflection quality'),
      seg<Level>([[0, 'Off'], [1, 'Probe'], [2, 'Planar ½'], [3, 'Planar full']], () => g.reflections, (v) => { g.reflections = v; custom(); }),
      h('span', { class: 'label' }, 'Post processing'),
      seg<Level>([[0, 'Minimal'], [1, 'Grade'], [2, '+Bloom'], [3, '+AO +CA']], () => g.post, (v) => { g.post = v; custom(); }),
      h('span', { class: 'label' }, 'Particle density'),
      seg<Level>([[1, 'Low'], [2, 'Medium'], [3, 'High']], () => g.particles, (v) => { g.particles = v; custom(); }),
      h('span', { class: 'label' }, 'Anti-aliasing'),
      seg<string>([['off', 'Off'], ['fxaa', 'FXAA'], ['smaa', 'SMAA'], ['msaa', 'MSAA 4x']], () => g.aa, (v) => { g.aa = v as 'fxaa'; custom(); }),
      h('span', { class: 'label' }, 'FPS limit'),
      seg<number>([[30, '30'], [60, '60'], [120, '120'], [0, 'Display']], () => g.fpsLimit, (v) => { g.fpsLimit = v as 0; }),
      h('span', { class: 'label' }, 'V-Sync'),
      h('div', { class: 'note' }, 'Browsers always present frames in sync with the display (requestAnimationFrame); it cannot be turned off from a web page. Use the FPS limit to cap rendering below the refresh rate.'),
      h('span', { class: 'label' }, 'Motion blur'),
      seg<string>([['off', 'Off'], ['on', 'On']], () => (g.motionBlur ? 'on' : 'off'), (v) => { g.motionBlur = v === 'on'; }),
      h('span', { class: 'label' }, 'Field of view'),
      range(60, 100, 1, () => g.fov, (v) => { g.fov = v; }, (v) => `${v}°`),
    );
    return h('div', { class: 'col' }, grid,
      h('div', { class: 'note' }, 'Shadow, reflection, particle and texture changes rebuild the current scene and may take a moment.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', on: { click: () => { game.applyGraphics(true); game.toast('Graphics applied.', 'success'); } } }, 'Apply graphics')));
  };
  const audio = () => h('div', { class: 'set-grid' },
    h('span', { class: 'label' }, 'Master volume'), range(0, 1, 0.01, () => s.audio.master, (v) => { s.audio.master = v; game.applyAudio(); }),
    h('span', { class: 'label' }, 'Music volume'), range(0, 1, 0.01, () => s.audio.music, (v) => { s.audio.music = v; game.applyAudio(); }),
    h('span', { class: 'label' }, 'SFX volume'), range(0, 1, 0.01, () => s.audio.sfx, (v) => { s.audio.sfx = v; game.applyAudio(); }),
    h('span', { class: 'label' }, 'Ambient volume'), range(0, 1, 0.01, () => s.audio.ambient, (v) => { s.audio.ambient = v; game.applyAudio(); }),
  );
  const controls = () => h('div', { class: 'col' },
    h('div', { class: 'set-grid' },
      h('span', { class: 'label' }, 'Mouse sensitivity'), range(0.2, 3, 0.05, () => s.controls.sensitivity, (v) => { s.controls.sensitivity = v; game.applyControls(); }, (v) => v.toFixed(2)),
      h('span', { class: 'label' }, 'Invert Y'), seg<string>([['off', 'Off'], ['on', 'On']], () => (s.controls.invertY ? 'on' : 'off'), (v) => { s.controls.invertY = v === 'on'; game.applyControls(); }),
      h('span', { class: 'label' }, 'Touch look sensitivity'), range(0.3, 3, 0.05, () => s.controls.touchSensitivity, (v) => { s.controls.touchSensitivity = v; game.applyControls(); }, (v) => v.toFixed(2)),
      h('span', { class: 'label' }, 'Touch button size'), range(0.8, 1.4, 0.05, () => s.controls.touchLayoutScale, (v) => { s.controls.touchLayoutScale = v; game.applyControls(); }),
    ),
    h('div', { class: 'divider' }),
    h('div', { class: 'note' }, h('b', null, 'PC: '), 'WASD move · Mouse look · LMB fire · RMB aim · R reload · Shift walk · Space jump · Ctrl/C crouch · 1–5 weapons · Q last/next · E interact · B buy · G drop C4 · Tab scoreboard · Enter/T chat · Z wave · X dance · P players · Esc menu'),
    h('div', { class: 'note' }, h('b', null, 'Touch: '), 'left side = movement stick · right side = look · on-screen buttons for fire, aim, jump, crouch, reload, swap, use, buy, scoreboard.'),
  );
  const setTab = (t: 'graphics' | 'audio' | 'controls') => {
    replace(tabs, ...(['graphics', 'audio', 'controls'] as const).map((k) => h('button', { class: k === t ? 'on' : '', on: { click: () => setTab(k) } }, k)));
    replace(pane, t === 'graphics' ? graphics() : t === 'audio' ? audio() : controls());
  };
  m.body.append(tabs, pane);
  setTab('graphics');
}

// ---------------------------------------------------------------- PROFILE
export function profilePanel(game: Game): void {
  const m = modal('PROFILE', { tag: 'LOCAL', onClose: () => game.saveSettings() });
  document.getElementById('ui')!.appendChild(m.root);
  const s = game.settings;
  const canvas = h('canvas') as HTMLCanvasElement;
  const refresh = () => Preview.show(canvas, 'character', 'idle', { look: s.look });
  const swatchRow = (key: 'jacket' | 'visor' | 'trim', colors: number[]) => {
    const row = h('div', { class: 'swatches' });
    const draw = () => replace(row, ...colors.map((c) => h('button', {
      class: `swatch ${s.look[key] === c ? 'on' : ''}`, style: `background:#${c.toString(16).padStart(6, '0')}`, 'aria-label': `#${c.toString(16)}`,
      on: { click: () => { s.look[key] = c; draw(); refresh(); } },
    })));
    draw();
    return row;
  };
  const name = h('input', { class: 'input', maxlength: 16, value: s.name, on: { change: (e: Event) => { s.name = (e.target as HTMLInputElement).value.trim().slice(0, 16); } } });
  const fin = h('div', { class: 'seg' });
  const drawFin = () => replace(fin, ...FINISHES.map((f) => h('button', { class: s.finish === f.id ? 'on' : '', on: { click: () => { s.finish = f.id; drawFin(); } } }, f.name)));
  drawFin();
  m.body.append(h('div', { class: 'shop' },
    h('div', { class: 'col' },
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Nickname'), name),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Jacket'), swatchRow('jacket', [0x1c2230, 0x2a1a10, 0x0f2a3a, 0x3a0f2a, 0x1a1a1a, 0x20304a])),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Visor glow'), swatchRow('visor', [0x00e5ff, 0x3ab8ff, 0x7a5cff, 0xff6a00])),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Trim glow'), swatchRow('trim', [0x00e5ff, 0xffffff, 0x3ab8ff, 0xff6a00])),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Default weapon finish'), fin),
      h('div', { class: 'note' }, 'Your profile is saved only in this browser. Premium colours are sold in the BLACK VAULT for city credits during a session.'),
    ),
    h('div', { class: 'preview' }, canvas),
  ));
  refresh();
}

export function newsPanel(): void {
  const m = modal('NEWS', { tag: 'v1.0', size: 'narrow' });
  document.getElementById('ui')!.appendChild(m.root);
  const entry = (t: string, d: string, items: string[]) => h('div', { class: 'col', style: 'margin-bottom:16px' },
    h('div', { class: 'row' }, h('b', { style: 'font:700 15px var(--f-display);letter-spacing:.1em' }, t), h('span', { class: 'label' }, d)),
    h('ul', { class: 'note', style: 'margin:0;padding-left:18px' }, ...items.map((i) => h('li', null, i))));
  m.body.append(
    entry('NEON CITY OPENS', 'v1.0', [
      'Six districts: Central Plaza, Night Market, Afterlife Bar, Black Vault, Armory, Tactical Gate.',
      'Wet-street planar reflections, layered height fog, volumetric light cones and constant rain.',
      'Parties of up to five, party chat, ready checks.',
    ]),
    entry('TACTICAL ARENA: SECTOR 09', 'v1.0', [
      'Bomb defusal on an industrial map with an elevated A dock, indoor B warehouse and an underground tunnel.',
      'Host-authoritative rounds, economy, C4 and lag-compensated hit detection.',
      'Smoke, flashbang and incendiary grenades.',
    ]),
    entry('NETWORK', 'v1.0', [
      'Serverless: manual invite / reply codes (copy, QR, file) and automatic mesh between all players.',
      'Best-effort host migration with epoch fencing; a failed recovery ends the match safely instead of faking it.',
    ]),
  );
}

function exitPanel(): void {
  const m = modal('EXIT', { size: 'narrow' });
  document.getElementById('ui')!.appendChild(m.root);
  m.body.append(
    h('div', { class: 'note' }, 'Browsers do not allow a web page to close a tab it did not open. Close this tab or window yourself to exit. Nothing needs to be saved — rooms disappear when everyone leaves.'),
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { class: 'btn', on: { click: () => { window.close(); setTimeout(() => m.close(), 200); } } }, 'Try to close tab'),
      h('button', { class: 'btn primary', on: { click: () => m.close() } }, 'Stay'),
    ),
  );
}

export function _settingsType(s: Settings): Settings { return s; }
