// In-room panels: invites (host), players, party, pause menu, match setup (Tactical Gate),
// Armory catalog, Black Vault cosmetics and the Afterlife bar.
import { COSMETICS, DRINKS } from '../config/economy';
import { FINISHES, PRIMARY_ORDER, SECONDARY_ORDER, WEAPONS, type WeaponId } from '../config/weapons';
import type { Game } from '../core/Game';
import { downloadText, pickTextFile } from '../networking/signaling/manual';
import { sortedPlayers, type RoomState } from '../room/RoomState';
import { h, modal, replace } from './dom';
import { Preview } from './Preview';
import { copyText, qrCanvas, scanQR, shareText } from './qr';

const mount = (m: { root: HTMLElement }) => document.getElementById('ui')!.appendChild(m.root);

/** Re-renders `draw` whenever room state changes while the panel is open. */
function live(game: Game, m: { root: HTMLElement }, draw: () => void): void {
  draw();
  const off = game.room.on('state', () => { if (!m.root.isConnected) { off(); return; } draw(); });
  const off2 = game.net.onInvitesChanged;
  void off2;
}

// ---------------------------------------------------------------- INVITES
export function invitesPanel(game: Game): void {
  const m = modal('ROOM · INVITES', { tag: game.room.state?.roomId ?? '', size: 'wide' });
  mount(m);
  const net = game.net;
  const list = h('div', { class: 'col' });
  const rendered = new Map<string, HTMLElement>();
  const draw = async () => {
    if (!m.root.isConnected) return;
    if (!game.room.isHost) {
      replace(list, h('div', { class: 'note' }, 'Only the current host can create invites. Ask the host (marked HOST in the player list) to invite your friends — or wait: if the host leaves, the next player in join order takes over.'));
      return;
    }
    const total = Object.keys(game.room.state?.players ?? {}).length;
    for (const [id, el] of rendered) if (!net.invites.has(id)) { el.remove(); rendered.delete(id); }
    for (const inv of net.invites.values()) {
      let el = rendered.get(inv.id);
      if (!el) {
        const reply = h('textarea', { class: 'input', placeholder: 'Paste the REPLY code from your friend (NDX-REPLY.…)' }) as HTMLTextAreaElement;
        const scanBox = h('div');
        const submit = async () => {
          try {
            const who = await net.acceptReply(reply.value);
            game.toast(`Connecting to ${who}…`, 'info');
          } catch (e) { game.toast((e as Error).message, 'error'); }
        };
        const qr = await qrCanvas(inv.code);
        el = h('div', { class: 'invite-item' },
          h('div', { class: 'row' }, h('b', { class: 'label' }, `Invite ${inv.id}`), h('span', { class: `status ${inv.status}`, 'data-status': '' }, inv.status), h('div', { class: 'grow' }),
            h('button', { class: 'btn small danger', on: { click: () => net.cancelInvite(inv.id) } }, 'Cancel')),
          h('div', { class: 'code-box' },
            h('div', { class: 'col' },
              h('span', { class: 'label' }, '1 · Send this INVITE to one friend'),
              h('textarea', { class: 'input', readonly: true }, inv.code),
              h('div', { class: 'row' },
                h('button', { class: 'btn small', on: { click: async () => game.toast((await copyText(inv.code)) ? 'Invite copied.' : 'Copy failed — select manually.', 'info') } }, 'Copy'),
                typeof navigator.share === 'function' && 'share' in navigator ? h('button', { class: 'btn small', on: { click: () => shareText(inv.code, 'NEON DISTRICT invite') } }, 'Share') : null,
                h('button', { class: 'btn small', on: { click: () => downloadText(`neon-district-invite-${inv.id}.txt`, inv.code) } }, 'Save file')),
            ),
            qr,
          ),
          h('span', { class: 'label' }, '2 · Paste their REPLY here'),
          reply,
          h('div', { class: 'row' },
            h('button', { class: 'btn small', on: { click: async () => { try { reply.value = (await pickTextFile()).trim(); } catch (e) { game.toast((e as Error).message, 'error'); } } } }, 'Import file'),
            h('button', { class: 'btn small', on: { click: async () => { const sc = scanQR(scanBox); try { reply.value = await sc.promise; } catch (e) { if ((e as Error).message !== 'Scan cancelled') game.toast((e as Error).message, 'error'); } } } }, 'Scan QR'),
            h('div', { class: 'grow' }),
            h('button', { class: 'btn small primary', on: { click: submit } }, 'Connect'),
          ),
          scanBox,
        );
        rendered.set(inv.id, el);
        list.prepend(el);
      }
      const st = el.querySelector('[data-status]') as HTMLElement;
      st.className = `status ${inv.status}`;
      st.textContent = inv.status === 'joined' ? `joined — ${inv.joinerName}` : inv.status === 'connecting' ? `connecting — ${inv.joinerName ?? ''}` : inv.status;
    }
    if (!net.invites.size) list.replaceChildren(h('div', { class: 'note' }, total >= 10 ? 'The room is full (10 players).' : 'No open invites. Create one for each friend who wants to join.'));
  };
  const prevChanged = net.onInvitesChanged;
  net.onInvitesChanged = () => { prevChanged(); draw(); };
  m.body.append(
    h('ol', { class: 'steps' },
      h('li', null, h('span', null, 'Click ', h('b', null, 'New invite'), ' and send the code to ONE friend (chat app, QR, or file).')),
      h('li', null, h('span', null, 'They paste it under PLAY → JOIN and send you a ', h('b', null, 'REPLY'), ' code.')),
      h('li', null, h('span', null, 'Paste the reply into that invite and press ', h('b', null, 'Connect'), '. They appear in the city; everyone else connects to them automatically.')),
    ),
    h('div', { class: 'row', style: 'margin:14px 0' },
      h('button', { class: 'btn primary', on: { click: async (ev: Event) => {
        if (!game.room.isHost) return;
        if (Object.keys(game.room.state?.players ?? {}).length >= 10) { game.toast('Room is full (10 players).', 'warn'); return; }
        // the clicked button itself — Safari does not focus buttons on click, so activeElement would be <body>
        const b = ev.currentTarget as HTMLButtonElement;
        if (b.disabled) return;
        b.disabled = true;
        b.textContent = 'Gathering ICE…';
        try { await net.createInvite(); } catch (e) { game.toast(`Could not create invite: ${(e as Error).message}`, 'error'); }
        b.disabled = false;
        b.textContent = 'New invite';
      } } }, 'New invite'),
      h('span', { class: 'note' }, 'Invites are single-use and only work while this tab stays open.'),
    ),
    list,
  );
  draw();
}

// ---------------------------------------------------------------- PLAYERS
export function playersPanel(game: Game): void {
  const m = modal('PLAYERS', { size: 'narrow' });
  mount(m);
  live(game, m, () => {
    const s = game.room.state;
    if (!s) return;
    const me = s.players[game.room.selfId];
    const myParty = me?.partyId ? s.parties[me.partyId] : null;
    replace(m.body, h('div', { class: 'list' }, ...sortedPlayers(s).map((p) => {
      const rtt = p.id === game.room.selfId ? 0 : Math.round(game.net.rtt(p.id));
      const party = p.partyId ? s.parties[p.partyId] : null;
      const canInvite = myParty && myParty.leader === game.room.selfId && p.id !== game.room.selfId && !myParty.members.includes(p.id) && !myParty.invites.includes(p.id);
      return h('div', { class: 'list-item' },
        h('div', { class: 'col grow', style: 'gap:4px' },
          h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: 'nm' }, p.name), p.id === s.hostId ? h('span', { class: 'badge host' }, 'HOST') : null,
            p.device === 'mobile' ? h('span', { class: 'badge mobile' }, 'MOBILE') : null, party ? h('span', { class: 'badge party' }, party.name) : null, p.id === game.room.selfId ? h('span', { class: 'badge' }, 'YOU') : null),
          h('span', { class: 'sub' }, `#${p.joinOrder + 1} in join order · ${p.id === game.room.selfId ? 'local' : `${rtt} ms`} · ${p.ready ? 'READY' : 'not ready'}`),
        ),
        canInvite ? h('button', { class: 'btn small', on: { click: async () => { const r = await game.room.request('party.invite', { target: p.id }); game.toast(r.msg ?? '', r.ok ? 'success' : 'error'); } } }, 'Invite to party') : null,
        game.room.isHost && p.id !== game.room.selfId ? h('button', { class: 'btn small danger', on: { click: async () => { const r = await game.room.request('kick', { target: p.id }); game.toast(r.msg ?? '', r.ok ? 'info' : 'error'); } } }, 'Kick') : null,
      );
    })), h('div', { class: 'note', style: 'margin-top:12px' }, 'If the host disconnects, the player with the lowest join number who is still connected becomes host.'));
  });
}

// ---------------------------------------------------------------- PARTY
export function partyPanel(game: Game): void {
  const m = modal('PARTY', { tag: 'MAX 5', size: 'narrow' });
  mount(m);
  const act = async (kind: string, args: Record<string, unknown> = {}) => {
    const r = await game.room.request(kind, args);
    if (r.msg) game.toast(r.msg, r.ok ? 'success' : 'error');
  };
  live(game, m, () => {
    const s = game.room.state;
    if (!s) return;
    const me = s.players[game.room.selfId];
    const party = me?.partyId ? s.parties[me.partyId] : null;
    const invites = Object.values(s.parties).filter((p) => p.invites.includes(game.room.selfId));
    const nameIn = h('input', { class: 'input', maxlength: 24, placeholder: 'Party name (optional)' }) as HTMLInputElement;
    replace(m.body,
      invites.length ? h('div', { class: 'col' }, h('span', { class: 'label' }, 'Pending invites'),
        ...invites.map((p) => h('div', { class: 'list-item' }, h('span', { class: 'nm grow' }, p.name), h('span', { class: 'sub' }, `${p.members.length}/5`),
          h('button', { class: 'btn small primary', on: { click: () => act('party.accept', { partyId: p.id }) } }, 'Accept'),
          h('button', { class: 'btn small danger', on: { click: () => act('party.decline', { partyId: p.id }) } }, 'Decline'))),
        h('div', { class: 'divider' })) : null,
      party ? h('div', { class: 'col' },
        h('div', { class: 'row' }, h('b', { style: 'font:700 18px var(--f-display);letter-spacing:.08em' }, party.name), h('span', { class: 'badge party' }, `${party.members.length}/5`)),
        h('div', { class: 'list' }, ...party.members.map((id) => {
          const p = s.players[id];
          const leaderMe = party.leader === game.room.selfId;
          return h('div', { class: 'list-item' },
            h('span', { class: 'nm grow' }, p?.name ?? id), id === party.leader ? h('span', { class: 'badge host' }, 'LEADER') : null,
            h('span', { class: p?.ready ? 'ok' : 'sub' }, p?.ready ? 'READY' : '—'),
            leaderMe && id !== game.room.selfId ? h('button', { class: 'btn small', on: { click: () => act('party.transfer', { target: id }) } }, 'Make leader') : null,
            leaderMe && id !== game.room.selfId ? h('button', { class: 'btn small danger', on: { click: () => act('party.kick', { target: id }) } }, 'Kick') : null);
        })),
        party.invites.length ? h('div', { class: 'note' }, `Invited: ${party.invites.map((i) => s.players[i]?.name ?? '?').join(', ')}`) : null,
        h('div', { class: 'row' },
          h('button', { class: `btn ${me.ready ? 'active' : ''}`, on: { click: () => act('ready', { ready: !me.ready }) } }, me.ready ? 'Ready ✓' : 'Ready up'),
          party.leader === game.room.selfId ? h('button', { class: 'btn', on: { click: () => { m.close(); playersPanel(game); } } }, 'Invite players') : null,
          h('div', { class: 'grow' }),
          h('button', { class: 'btn danger', on: { click: () => act('party.leave') } }, 'Leave party')),
        h('div', { class: 'note' }, 'Use the PARTY channel in chat to talk only to your party.'),
      ) : h('div', { class: 'col' },
        h('div', { class: 'note' }, 'Create a party, then invite players from the player list. The host can build arena teams from parties.'),
        nameIn,
        h('button', { class: 'btn primary', on: { click: () => act('party.create', { name: nameIn.value }) } }, 'Create party')),
    );
  });
}

// ---------------------------------------------------------------- PAUSE
export function pauseMenu(game: Game): void {
  const m = modal('MENU', { size: 'narrow' });
  mount(m);
  const b = (label: string, fn: () => void, cls = '') => h('button', { class: `btn ${cls}`, on: { click: () => { m.close(); fn(); } } }, label);
  const inArena = game.mode === 'arena';
  m.body.append(h('div', { class: 'pause-menu' },
    b('Resume', () => game.input.requestLock(), 'primary'),
    !inArena ? b('Room · Invites', () => invitesPanel(game)) : null,
    weatherRow(game),
    b('Players', () => playersPanel(game)),
    !inArena ? b('Party', () => partyPanel(game)) : null,
    b('Settings', () => game.openSettings()),
    inArena && game.room.isHost ? b('End match (host)', () => game.room.request('match.abort'), 'danger') : null,
    b('Leave room', () => game.leaveRoom(), 'danger'),
    h('div', { class: 'note', style: 'margin-top:8px' }, `Room ${game.room.state?.roomId ?? ''} · ${Object.keys(game.room.state?.players ?? {}).length}/10 players · you are ${game.room.isHost ? 'the HOST' : 'a guest'}`),
  ));
}

/** Host-only rain switch; guests see the current weather. */
function weatherRow(game: Game): HTMLElement {
  const row = h('div', { class: 'row weather-row' });
  const draw = () => {
    const on = game.room.state?.rain !== false;
    if (!game.room.isHost) { replace(row, h('span', { class: 'label' }, 'Weather'), h('span', { class: 'note' }, on ? 'Rain ON' : 'Rain OFF'), h('span', { class: 'note' }, '(host controls)')); return; }
    replace(row, h('span', { class: 'label' }, 'Weather'), h('div', { class: 'seg' },
      h('button', { class: on ? 'on' : '', on: { click: async () => { await game.room.request('weather.rain', { on: true }); draw(); } } }, 'Rain ON'),
      h('button', { class: on ? '' : 'on', on: { click: async () => { await game.room.request('weather.rain', { on: false }); draw(); } } }, 'Rain OFF')));
  };
  draw();
  return row;
}

// ---------------------------------------------------------------- TACTICAL GATE / MATCH SETUP
export function gatePanel(game: Game): void {
  const m = modal('TACTICAL GATE', { tag: 'SECTOR 09', size: 'wide' });
  mount(m);
  const act = async (kind: string, args: Record<string, unknown> = {}) => {
    const r = await game.room.request(kind, args);
    if (r.msg) game.toast(r.msg, r.ok ? 'success' : 'error');
    return r;
  };
  live(game, m, () => {
    const s: RoomState | null = game.room.state;
    if (!s) return;
    const host = game.room.isHost;
    if (s.match) {
      const mt = s.match;
      const inIt = !!mt.players[game.room.selfId];
      replace(m.body, h('div', { class: 'col' },
        h('div', { class: 'row' }, h('b', { style: 'font:700 22px var(--f-display)' }, `ALPHA ${mt.score.alpha} : ${mt.score.bravo} BRAVO`), h('span', { class: 'label' }, `Round ${mt.round}/${mt.maxRounds} · ${mt.phase}`)),
        h('div', { class: 'note' }, inIt ? 'You are in this match.' : 'A match is in progress. You can join the next one once it ends.'),
        host ? h('button', { class: 'btn danger', on: { click: () => act('match.abort') } }, 'End match for everyone') : null));
      return;
    }
    const st = s.setup;
    const assigned = new Set([...st.alpha, ...st.bravo]);
    const col = (key: 'alpha' | 'bravo' | 'none', title: string, ids: string[]) => h('div', { class: `team-col ${key}` },
      h('h3', null, `${title} (${ids.length}${key === 'none' ? '' : '/5'})`),
      ...ids.map((id) => {
        const p = s.players[id];
        return h('div', { class: 'list-item' }, h('span', { class: 'nm grow' }, p?.name ?? id), p?.ready ? h('span', { class: 'ok' }, '✓') : null,
          host && key !== 'alpha' ? h('button', { class: 'btn small', on: { click: () => act('setup.assign', { player: id, team: 'alpha' }) } }, 'α') : null,
          host && key !== 'bravo' ? h('button', { class: 'btn small', on: { click: () => act('setup.assign', { player: id, team: 'bravo' }) } }, 'β') : null,
          host && key !== 'none' ? h('button', { class: 'btn small ghost', on: { click: () => act('setup.assign', { player: id, team: 'none' }) } }, '×') : null);
      }));
    const rounds = h('div', { class: 'seg' }, ...[4, 6, 8, 12, 16, 24].map((n) => h('button', { class: st.rounds === n ? 'on' : '', disabled: !host, on: { click: () => act('setup.rounds', { rounds: n }) } }, String(n))));
    const me = s.players[game.room.selfId];
    replace(m.body, h('div', { class: 'col' },
      h('div', { class: 'note' }, 'Bomb defusal. ', h('b', null, 'Alpha'), ' starts on ATTACK, ', h('b', null, 'Bravo'), ' on DEFENSE; sides swap at halftime. Any split up to 5v5 works (1v1, 3v2, 4v3 …). Unassigned players stay in the city.'),
      h('div', { class: 'teams' }, col('alpha', 'ALPHA', st.alpha), col('bravo', 'BRAVO', st.bravo), col('none', 'UNASSIGNED', Object.keys(s.players).filter((id) => !assigned.has(id)))),
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Rounds'), rounds,
        host ? h('button', { class: 'btn small', on: { click: () => act('setup.fromParties') } }, 'Teams from parties') : null,
        host ? h('button', { class: 'btn small', on: { click: () => act('setup.shuffle') } }, 'Shuffle') : null,
        h('div', { class: 'grow' }),
        h('button', { class: `btn ${me?.ready ? 'active' : ''}`, on: { click: () => act('ready', { ready: !me?.ready }) } }, me?.ready ? 'Ready ✓' : 'Ready'),
        host ? h('button', { class: 'btn primary', disabled: st.alpha.length + st.bravo.length === 0, on: { click: async () => { const r = await act('match.start'); if (r.ok) m.close(); } } }, 'Start match') : h('span', { class: 'note' }, 'Waiting for the host to start…')),
      h('div', { class: 'note' }, 'All match logic runs on the host\'s browser (host-authoritative). This rejects obviously invalid input but is not a substitute for a dedicated anti-cheat server.'),
    ));
  });
}

// ---------------------------------------------------------------- ARMORY (catalog + finishes)
export function armoryPanel(game: Game): void {
  const m = modal('ARMORY', { tag: 'CATALOG', size: 'wide' });
  mount(m);
  const canvas = h('canvas') as HTMLCanvasElement;
  let sel: WeaponId = 'kestrel';
  const info = h('div', { class: 'col' });
  const listEl = h('div', { class: 'shop-list scroll', style: 'max-height:60vh' });
  const finishRow = h('div', { class: 'swatches' });
  const stat = (k: string, v: number, max: number, label: string) => h('div', { class: 'stat' }, h('span', null, k), h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, (v / max) * 100)}%` })), h('output', null, label));
  const draw = () => {
    const w = WEAPONS[sel];
    const finish = game.room.self?.finish ?? game.settings.finish;
    Preview.show(canvas, 'weapon', w.model, { finish });
    replace(info,
      h('div', { class: 'row' }, h('b', { style: 'font:700 20px var(--f-display);letter-spacing:.06em' }, w.name), h('span', { class: 'badge' }, w.cls)),
      h('div', { class: 'note' }, w.description),
      stat('Damage', w.damage * w.pellets, 120, String(w.damage * (w.pellets > 1 ? 1 : 1)) + (w.pellets > 1 ? `×${w.pellets}` : '')),
      stat('Fire rate', w.rpm, 900, `${w.rpm}`),
      stat('Magazine', w.magazine, 30, `${w.magazine}`),
      stat('Accuracy', 1 / (w.spread + 0.002), 1 / 0.0028, `${Math.round(100 - w.spread * 1200)}`),
      stat('Mobility', w.speedMult, 1.05, `${Math.round(w.speedMult * 100)}`),
      h('div', { class: 'note' }, `Arena price ${w.price ? `$${w.price}` : 'free'} · kill reward $${w.killReward}. Weapons are bought inside matches with match money.`),
    );
    replace(listEl, ...[['SECONDARY', SECONDARY_ORDER], ['PRIMARY', PRIMARY_ORDER]].flatMap(([cat, ids]) => [
      h('div', { class: 'shop-cat' }, cat as string),
      ...(ids as WeaponId[]).map((id) => h('button', { class: `shop-item ${id === sel ? 'sel' : ''}`, on: { click: () => { sel = id; draw(); } } },
        h('span', { class: 'nm' }, WEAPONS[id].name), h('span', { class: 'pr' }, `$${WEAPONS[id].price}`), h('span', { class: 'ds' }, WEAPONS[id].cls.toUpperCase()))),
    ]));
    replace(finishRow, ...FINISHES.map((f) => h('button', {
      class: `swatch ${finish === f.id ? 'on' : ''}`, title: f.name, style: `background:linear-gradient(135deg,#${f.color.toString(16).padStart(6, '0')} 60%,#${f.accent.toString(16).padStart(6, '0')} 60%)`,
      on: { click: async () => { const r = await game.room.request('finish', { id: f.id }); game.settings.finish = f.id; game.saveSettings(); game.toast(r.msg ?? f.name, r.ok ? 'success' : 'error'); setTimeout(draw, 50); } },
    })));
  };
  m.body.append(h('div', { class: 'shop' }, listEl, h('div', { class: 'preview' }, canvas, info, h('span', { class: 'label' }, 'Weapon finish (visible to everyone)'), finishRow)));
  draw();
}

// ---------------------------------------------------------------- BLACK VAULT (cosmetics)
export function vaultPanel(game: Game): void {
  const m = modal('BLACK VAULT', { tag: 'CREDITS ONLY', size: 'wide' });
  mount(m);
  const canvas = h('canvas') as HTMLCanvasElement;
  live(game, m, () => {
    const me = game.room.self;
    if (!me) return;
    Preview.show(canvas, 'character', 'idle', { look: me.look });
    const list = h('div', { class: 'shop-list scroll', style: 'max-height:60vh' },
      ...['jacket', 'visor', 'trim'].flatMap((kind) => [
        h('div', { class: 'shop-cat' }, kind.toUpperCase()),
        ...COSMETICS.filter((c) => c.kind === kind).map((c) => {
          const owned = me.owned.includes(c.id);
          const equipped = (me.look as any)[c.kind] === c.color;
          return h('button', { class: `shop-item ${owned ? 'owned' : ''} ${!owned && me.credits < c.price ? 'cant' : ''} ${equipped ? 'sel' : ''}`,
            on: { click: async () => { const r = await game.room.request(owned ? 'cosmetic.equip' : 'cosmetic.buy', { id: c.id }); game.toast(r.msg ?? '', r.ok ? 'success' : 'error'); game.audio.ui(r.ok ? 'buy' : 'error'); } } },
            h('span', { class: 'nm' }, h('span', { style: `display:inline-block;width:10px;height:10px;margin-right:8px;background:#${c.color.toString(16).padStart(6, '0')}` }), c.name),
            h('span', { class: 'pr' }, owned ? (equipped ? 'EQUIPPED' : 'OWNED') : `₵${c.price}`));
        }),
      ]));
    replace(m.body, h('div', { class: 'shop' }, list, h('div', { class: 'preview' }, canvas,
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Your credits'), h('b', { style: 'font:700 22px var(--f-mono);color:var(--amber)' }, `₵${me.credits}`)),
      h('div', { class: 'note' }, 'Credits are virtual and exist only while this room exists. Purchases are validated by the host and synced to all players.'))));
  });
}

// ---------------------------------------------------------------- AFTERLIFE BAR
export function barPanel(game: Game): void {
  const m = modal('AFTERLIFE', { tag: 'BAR', size: 'narrow' });
  mount(m);
  live(game, m, () => {
    const me = game.room.self;
    if (!me) return;
    replace(m.body, h('div', { class: 'list' }, ...DRINKS.map((d) => h('div', { class: 'list-item' },
      h('span', { class: 'nm grow' }, d.name), h('span', { class: 'pr', style: 'color:var(--amber);font-family:var(--f-mono)' }, `₵${d.price}`),
      h('button', { class: 'btn small primary', disabled: me.credits < d.price, on: { click: async () => { const r = await game.room.request('drink', { id: d.id }); game.toast(r.msg ?? '', r.ok ? 'success' : 'error'); if (r.ok) m.close(); } } }, 'Order')))),
      h('div', { class: 'note', style: 'margin-top:10px' }, `Credits: ₵${me.credits}. Press X to dance on the floor.`));
  });
}
