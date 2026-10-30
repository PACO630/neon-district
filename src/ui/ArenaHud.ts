// TACTICAL ARENA HUD: vitals, ammo, slots, timer & score, minimap, kill feed, C4 status, action
// progress, crosshair with dynamic spread, hit markers, damage direction, scope, spectate,
// scoreboard and the buy menu.
import { GEAR, PRIMARY_ORDER, SECONDARY_ORDER, WEAPONS, type GearId, type WeaponId } from '../config/weapons';
import type { Game } from '../core/Game';
import { MINIMAP_SCALE, renderMinimap, SITES } from '../arena/Sector09';
import { sideOf, type MatchState } from '../room/RoomState';
import { fmtMoney, fmtTime, h, replace } from './dom';

const GEAR_ORDER: GearId[] = ['kevlar', 'helmet', 'kit', 'flash', 'smoke', 'molotov'];

export class ArenaHud {
  readonly el: HTMLElement;
  private hpV = h('div', { class: 'v' });
  private hpBar = h('i');
  private hpWrap: HTMLElement;
  private arV = h('div', { class: 'v' });
  private arBar = h('i');
  private money = h('div', { class: 'money' });
  private ammoName = h('div', { class: 'wn' });
  private ammoCnt = h('div', { class: 'cnt' });
  private slots = h('div', { class: 'slots' });
  private scA = h('div', { class: 'sc atk' });
  private scB = h('div', { class: 'sc def' });
  private timer = h('div', { class: 'timer' });
  private killfeed = h('div', { class: 'killfeed' });
  private center = h('div', { class: 'center-msg hidden' });
  private action = h('div', { class: 'panel action-bar hidden' });
  private aPrompt = h('div', { class: 'panel a-prompt hidden' });
  private bombStatus = h('div', { class: 'panel bomb-status hidden' });
  private cross = h('div', { class: 'crosshair' }, h('i', { class: 't' }), h('i', { class: 'b' }), h('i', { class: 'l' }), h('i', { class: 'r' }), h('i', { class: 'd' }));
  private hit = h('div', { class: 'hitmarker' });
  private dmg = h('div', { class: 'dmg-ind hidden' }, h('i'));
  private scope = h('div', { class: 'scope hidden' });
  private spectate = h('div', { class: 'panel spectate hidden' });
  private board = h('div', { class: 'panel scoreboard hidden' });
  private buyEl = h('div', { class: 'panel buy-menu interactive hidden' });
  private netStats = h('div', { class: 'net-stats' });
  private mmCanvas = h('canvas', { width: 256, height: 256 }) as HTMLCanvasElement;
  private mmBase: HTMLCanvasElement;
  private cache = new Map<HTMLElement, string>();
  private boardAcc = 0;
  buyOpen = false;

  constructor(private game: Game) {
    this.hpWrap = h('div', { class: 'vital hp' }, this.hpV, h('div', { class: 'bar' }, this.hpBar), h('div', { class: 'k' }, 'HEALTH'));
    this.mmBase = renderMinimap(256);
    // touch: tap a weapon slot to switch (slot labels start with their number)
    this.slots.addEventListener('touchstart', (e) => {
      const el = (e.target as HTMLElement).closest('.s');
      const n = el?.getAttribute('data-slot');
      if (!n) return;
      e.preventDefault();
      const act = `slot${n}` as 'slot1';
      game.input.press(act);
      setTimeout(() => game.input.release(act), 60);
    }, { passive: false });
    this.el = h('div', { id: 'arena-hud', class: 'hidden' },
      h('div', { class: 'panel minimap' }, this.mmCanvas),
      h('div', { class: 'topbar' }, this.scA, h('div', { class: 'panel' }, this.timer), this.scB),
      this.killfeed, this.center, this.cross, this.hit, this.dmg, this.scope, this.action, this.aPrompt, this.bombStatus, this.spectate,
      h('div', { class: 'panel vitals' }, this.hpWrap, h('div', { class: 'vital' }, this.arV, h('div', { class: 'bar' }, this.arBar), h('div', { class: 'k' }, 'ARMOR')), h('div', { class: 'vital' }, this.money, h('div', { class: 'k' }, 'MONEY'))),
      h('div', { class: 'panel ammo' }, this.slots, this.ammoName, this.ammoCnt),
      this.netStats, this.board, this.buyEl,
    );
    this.scA.classList.add('panel');
    this.scB.classList.add('panel');
  }

  private set(el: HTMLElement, text: string): void {
    if (this.cache.get(el) === text) return;
    this.cache.set(el, text);
    el.textContent = text;
  }

  show(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
    if (!v) this.closeBuy();
  }

  // ------------------------------------------------------------- buy menu
  toggleBuy(): void { if (this.buyOpen) this.closeBuy(); else this.openBuy(); }
  openBuy(): void {
    const a = this.game.arena;
    if (!a || !a.alive) return;
    this.buyOpen = true;
    this.game.input.exitLock();
    this.buyEl.classList.remove('hidden');
    document.body.classList.add('buy-open');
    this.renderBuy();
  }
  closeBuy(): void {
    if (!this.buyOpen) return;
    this.buyOpen = false;
    this.buyEl.classList.add('hidden');
    document.body.classList.remove('buy-open');
    if (!this.game.mobile && this.game.mode === 'arena') this.game.input.requestLock();
  }

  private renderBuy(): void {
    const g = this.game;
    const m = g.room.state?.match;
    const me = m?.players[g.room.selfId];
    const a = g.arena;
    if (!m || !me || !a) return;
    const side = sideOf(m, me.team);
    const buy = async (item: string) => {
      const r = await g.room.request('buy', { item });
      g.audio.ui(r.ok ? 'buy' : 'error');
      if (!r.ok) g.toast(r.msg ?? 'Purchase failed', 'error');
      else { if (r.data?.item) setTimeout(() => a.equip(r.data.item), 80); }
      setTimeout(() => this.renderBuy(), 120);
    };
    const wCard = (id: WeaponId) => {
      const w = WEAPONS[id];
      const owned = me.primary === id || me.secondary === id;
      return h('button', { class: `buy-card ${owned ? 'owned' : ''}`, disabled: owned || me.money < w.price, on: { click: () => buy(id) } },
        h('div', { class: 'top' }, h('span', { class: 'nm' }, w.name), h('span', { class: 'pr' }, `$${w.price}`)),
        h('div', { class: 'st' }, `DMG ${w.damage}${w.pellets > 1 ? `×${w.pellets}` : ''} · ${w.rpm} RPM · MAG ${w.magazine}`),
        h('div', { class: 'st' }, owned ? 'OWNED' : `Kill reward $${w.killReward}`));
    };
    const gCard = (id: GearId) => {
      const gd = GEAR[id];
      if (gd.side && gd.side !== side) return null;
      let price = gd.price;
      let owned = false;
      if (id === 'kevlar') owned = me.armor >= 100;
      if (id === 'helmet') { owned = me.helmet && me.armor >= 100; if (me.armor >= 100 && !me.helmet) price = 350; }
      if (id === 'kit') owned = me.kit;
      if (id === 'smoke' || id === 'flash' || id === 'molotov') owned = me.grenades.includes(id);
      const full = (id === 'smoke' || id === 'flash' || id === 'molotov') && me.grenades.length >= 3 && !owned;
      return h('button', { class: `buy-card ${owned ? 'owned' : ''}`, disabled: owned || full || me.money < price, on: { click: () => buy(id) } },
        h('div', { class: 'top' }, h('span', { class: 'nm' }, gd.name), h('span', { class: 'pr' }, `$${price}`)),
        h('div', { class: 'st' }, owned ? 'OWNED' : gd.description));
    };
    const zone = a.inBuyZone;
    const t = a.buyTimeLeft;
    replace(this.buyEl,
      h('div', { class: 'panel-head' }, h('h2', null, 'BUY'), h('span', { class: 'tag' }, side === 'ATK' ? 'ATTACK' : 'DEFENSE'), h('div', { class: 'spacer' }),
        h('b', { class: 'money' }, fmtMoney(me.money)), h('button', { class: 'close-x', on: { click: () => this.closeBuy() } }, '×')),
      h('div', { class: 'panel-body' },
        !zone || t <= 0 ? h('div', { class: 'err', style: 'margin-bottom:10px' }, !zone ? 'You are outside your spawn buy zone.' : 'Buy time is over.') : h('div', { class: 'note', style: 'margin-bottom:10px' }, `Buy time left: ${Math.ceil(t)} s`),
        h('div', { class: 'shop-cat' }, 'PISTOLS'), h('div', { class: 'buy-grid' }, ...SECONDARY_ORDER.map(wCard)),
        h('div', { class: 'shop-cat' }, 'SMG · SHOTGUN · RIFLES · SNIPER'), h('div', { class: 'buy-grid' }, ...PRIMARY_ORDER.map(wCard)),
        h('div', { class: 'shop-cat' }, 'EQUIPMENT · GRENADES'), h('div', { class: 'buy-grid' }, ...GEAR_ORDER.map(gCard)),
      ));
  }

  // ------------------------------------------------------------- scoreboard
  private renderBoard(m: MatchState): void {
    const g = this.game;
    const s = g.room.state!;
    const rows = (team: 'alpha' | 'bravo') => {
      const side = sideOf(m, team);
      const ps = Object.values(m.players).filter((p) => p.team === team).sort((a, b) => b.kills - a.kills);
      return [
        h('tr', { class: 'team-h' }, h('td', { colspan: 7, style: `color:var(--${side === 'ATK' ? 'atk' : 'def'})` }, `${team.toUpperCase()} — ${side === 'ATK' ? 'ATTACK' : 'DEFENSE'} — ${m.score[team]}`)),
        ...ps.map((p) => h('tr', { class: `${p.id === g.room.selfId ? 'me' : ''} ${!p.alive ? 'dead' : ''}` },
          h('td', null, (s.players[p.id]?.name ?? 'Disconnected') + (m.bomb.carrier === p.id && m.players[g.room.selfId]?.team === team ? ' 💣' : '') + (p.connected ? '' : ' (left)')),
          h('td', null, String(p.kills)), h('td', null, String(p.deaths)), h('td', null, String(p.assists)), h('td', null, String(p.damage)),
          h('td', null, m.players[g.room.selfId]?.team === team ? fmtMoney(p.money) : '—'),
          h('td', null, p.id === g.room.selfId ? '—' : `${Math.round(g.net.rtt(p.id))}`))),
      ];
    };
    replace(this.board,
      h('div', { class: 'panel-head' }, h('h2', null, 'SECTOR 09'), h('span', { class: 'tag' }, `ROUND ${m.round}/${m.maxRounds}`), h('div', { class: 'spacer' }), h('span', { class: 'label' }, `First to ${m.maxRounds / 2 + 1}`)),
      h('div', { class: 'panel-body' }, h('table', null,
        h('tr', null, h('th', null, 'PLAYER'), h('th', null, 'K'), h('th', null, 'D'), h('th', null, 'A'), h('th', null, 'DMG'), h('th', null, 'MONEY'), h('th', null, 'PING')),
        ...rows('alpha'), ...rows('bravo'))));
  }

  // ------------------------------------------------------------- minimap
  private drawMinimap(m: MatchState): void {
    const a = this.game.arena!;
    const ctx = this.mmCanvas.getContext('2d')!;
    const S = 256, sc = MINIMAP_SCALE(S);
    const P = (x: number, z: number): [number, number] => [S / 2 + x * sc, S / 2 + z * sc];
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(this.mmBase, 0, 0);
    const dot = (x: number, z: number, color: string, r = 4, yaw?: number) => {
      const [px, pz] = P(x, z);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, pz, r, 0, Math.PI * 2);
      ctx.fill();
      if (yaw !== undefined) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, pz);
        ctx.lineTo(px - Math.sin(yaw) * 10, pz - Math.cos(yaw) * 10);
        ctx.stroke();
      }
    };
    for (const t of a.teammatePositions()) dot(t.pos.x, t.pos.z, t.alive ? '#8aff3a' : 'rgba(255,255,255,0.3)', 3.5, t.alive ? t.yaw : undefined);
    const side = a.mySide;
    const b = m.bomb;
    if ((side === 'ATK' && (b.state === 'dropped' || b.state === 'planted')) || (side === 'DEF' && b.state === 'planted')) {
      dot(b.pos[0], b.pos[2], b.state === 'planted' ? '#ff2a3a' : '#ffa31a', 5);
    }
    if (a.alive) dot(a.position.x, a.position.z, '#ffffff', 4.5, a.yaw);
    void SITES;
  }

  // ------------------------------------------------------------- frame
  update(dt: number): void {
    const g = this.game;
    const a = g.arena;
    const m = g.room.state?.match;
    if (!a || !m) return;
    const me = m.players[g.room.selfId];
    const side = a.mySide;
    if (g.input.pressed('chat')) g.cityHud.focusChat();
    // vitals
    const hp = a.alive ? a.hp : 0;
    this.set(this.hpV, String(hp));
    this.hpBar.style.width = `${hp}%`;
    this.hpWrap.classList.toggle('low', hp <= 25);
    this.set(this.arV, String(Math.round(a.armor)) + (me?.helmet ? '+H' : ''));
    this.arBar.style.width = `${a.armor}%`;
    this.set(this.money, fmtMoney(me?.money ?? 0));
    // weapon
    const item = a.equipped;
    const w = WEAPONS[item as WeaponId];
    this.set(this.ammoName, w ? w.name : item === 'c4' ? 'C4 EXPLOSIVE' : item.toUpperCase());
    const am = a.ammo[item];
    if (w && w.cls !== 'melee' && am) {
      const t = `${am[0]} / ${am[1]}`;
      if (this.cache.get(this.ammoCnt) !== t) { this.cache.set(this.ammoCnt, t); replace(this.ammoCnt, String(am[0]), h('small', null, ` / ${am[1]}`)); }
      this.ammoCnt.classList.toggle('empty', am[0] === 0);
    } else this.set(this.ammoCnt, item === 'knife' ? '∞' : '1');
    if (me) {
      const sl = [me.primary ? `1 ${WEAPONS[me.primary].name.split(' ')[0]}` : null, me.secondary ? `2 ${WEAPONS[me.secondary].name.split(' ')[0]}` : null, '3 KNIFE',
        me.grenades.length ? `4 ${me.grenades.map((x) => x[0].toUpperCase()).join('')}` : null, m.bomb.carrier === me.id ? '5 C4' : null].filter(Boolean) as string[];
      const key = sl.join('|') + item;
      if (this.cache.get(this.slots) !== key) {
        this.cache.set(this.slots, key);
        const active = (s: string) => (s.startsWith('1') && item === me.primary) || (s.startsWith('2') && item === me.secondary) || (s.startsWith('3') && item === 'knife') || (s.startsWith('4') && ['smoke', 'flash', 'molotov'].includes(item)) || (s.startsWith('5') && item === 'c4');
        replace(this.slots, ...sl.map((s) => h('span', { class: `s ${active(s) ? 'on' : ''}`, 'data-slot': s[0] }, s)));
      }
    }
    // score & timer (attack side shown on the left)
    const atkTeam = m.alphaSide === 'ATK' ? 'alpha' : 'bravo';
    const defTeam = atkTeam === 'alpha' ? 'bravo' : 'alpha';
    const sa = `${m.score[atkTeam]}|ATK`, sb = `${m.score[defTeam]}|DEF`;
    if (this.cache.get(this.scA) !== sa) { this.cache.set(this.scA, sa); replace(this.scA, String(m.score[atkTeam]), h('small', null, side === 'ATK' ? 'ATK · YOU' : 'ATK')); }
    if (this.cache.get(this.scB) !== sb + side) { this.cache.set(this.scB, sb + side); replace(this.scB, String(m.score[defTeam]), h('small', null, side === 'DEF' ? 'DEF · YOU' : 'DEF')); }
    const phaseLabel = { freeze: 'BUY PHASE', live: `ROUND ${m.round}`, planted: 'BOMB PLANTED', roundEnd: 'ROUND OVER', halftime: 'HALFTIME', ended: 'MATCH OVER' }[m.phase];
    const tk = `${fmtTime(a.phaseRemaining)}|${phaseLabel}`;
    if (this.cache.get(this.timer) !== tk) { this.cache.set(this.timer, tk); replace(this.timer, m.phase === 'planted' ? '💣' : fmtTime(a.phaseRemaining), h('small', null, phaseLabel)); }
    this.timer.classList.toggle('bomb', m.phase === 'planted');
    // killfeed
    const kfKey = a.killfeed.map((k) => k.t).join(',');
    if (this.cache.get(this.killfeed) !== kfKey) {
      this.cache.set(this.killfeed, kfKey);
      replace(this.killfeed, ...a.killfeed.slice(0, 5).map((k) => h('div', { class: `kf ${k.mine ? 'mine' : ''}` },
        h('span', { class: (k.killerSide ?? '').toLowerCase() }, k.killer), h('span', { class: 'w' }, k.weapon.toUpperCase()), k.head ? h('span', { class: 'hs' }, 'HS') : null,
        h('span', { class: (k.victimSide ?? '').toLowerCase() }, k.victim))));
    }
    for (const el of this.killfeed.children) (el as HTMLElement).style.opacity = '1';
    // center message
    const cm = a.centerMsg;
    if (cm) {
      const visible = cm.until > a.clock;
      this.center.classList.toggle('hidden', !visible);
      const k = `${cm.text}|${cm.sub}`;
      if (visible && this.cache.get(this.center) !== k) {
        this.cache.set(this.center, k);
        replace(this.center, h('div', { class: 't', style: `color:${cm.color ?? '#fff'}` }, cm.text), cm.sub ? h('div', { class: 's' }, cm.sub) : null);
      }
    }
    // action progress
    const act = a.actionActive;
    if (act && (m.bomb.action === act || m.bomb.progress > 0)) {
      this.action.classList.remove('hidden');
      this.action.classList.toggle('defuse', act === 'defuse');
      const p = Math.max(a.actionProgress, m.bomb.progress);
      replace(this.action, h('span', { class: 'label' }, act === 'plant' ? 'PLANTING C4' : 'DEFUSING C4'), h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(p * 100)}%` })));
    } else this.action.classList.add('hidden');
    if (a.prompt && a.alive) { this.set(this.aPrompt, a.prompt); this.aPrompt.classList.remove('hidden'); } else this.aPrompt.classList.add('hidden');
    // bomb status
    let bs = '';
    if (m.bomb.state === 'planted') bs = `C4 PLANTED · SITE ${m.bomb.site}`;
    else if (side === 'ATK' && m.bomb.carrier === g.room.selfId) bs = 'YOU CARRY THE C4 · [5]';
    else if (side === 'ATK' && m.bomb.state === 'dropped') bs = 'C4 DROPPED — RECOVER IT';
    else if (side === 'ATK' && m.bomb.carrier) bs = `C4: ${g.room.state?.players[m.bomb.carrier]?.name ?? '?'}`;
    this.bombStatus.classList.toggle('hidden', !bs);
    if (bs) this.set(this.bombStatus, bs);
    // crosshair
    const spread = (w ? w.spread + w.moveSpread * Math.min(1, a.moveSpeed / 5) : 0.01) * (a.ads && w ? w.adsSpread : 1);
    const gap = 4 + spread * 900;
    const ch = this.cross.children as HTMLCollectionOf<HTMLElement>;
    ch[0].style.top = `${-gap - 7}px`; ch[1].style.top = `${gap}px`; ch[2].style.left = `${-gap - 7}px`; ch[3].style.left = `${gap}px`;
    const scoped = a.ads && item === 'longbow';
    this.cross.style.display = !a.alive || scoped || (w && w.cls === 'sniper' && !a.ads) ? 'none' : '';
    this.scope.classList.toggle('hidden', !scoped || !a.alive);
    this.hit.style.opacity = String(Math.min(1, a.hitmarker * 6));
    this.hit.classList.toggle('head', a.hitmarkerHead);
    const showDmg = a.damageDir !== null && a.damageDirUntil > a.clock;
    this.dmg.classList.toggle('hidden', !showDmg);
    if (showDmg) this.dmg.style.transform = `rotate(${-(a.damageDir as number)}rad)`;
    // spectate
    if (!a.alive) {
      this.spectate.classList.remove('hidden');
      this.set(this.spectate, a.spectatingName ? `SPECTATING ${a.spectatingName}  ·  click to switch` : 'YOU ARE DEAD — waiting for next round');
    } else this.spectate.classList.add('hidden');
    // scoreboard
    this.board.classList.toggle('hidden', !a.scoreboardOpen);
    if (a.scoreboardOpen && (this.boardAcc -= dt) <= 0) { this.boardAcc = 0.5; this.renderBoard(m); }
    this.drawMinimap(m);
    if (this.buyOpen && (!a.alive || (!a.inBuyZone && a.buyTimeLeft <= 0))) this.closeBuy();
    const hostRtt = g.room.isHost ? 0 : Math.round(g.net.rtt(g.room.state!.hostId));
    this.set(this.netStats, `${g.room.isHost ? 'HOST' : `ping ${hostRtt} ms`} · ${g.fps} fps · res ${Math.round(g.renderer.dynamicScale * 100)}%`);
  }
}
