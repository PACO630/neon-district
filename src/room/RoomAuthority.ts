// Host-side rules for the social layer: parties, readiness, cosmetics, drinks and match setup.
// Handlers run only on the current host; clients reach them through Room.request().
import { COSMETICS, DRINKS } from '../config/economy';
import { FINISHES } from '../config/weapons';
import { randomId } from '../networking/protocol';
import type { Room, ReqResult } from './Room';
import type { Party, RoomState } from './RoomState';

const MAX_PARTY = 5;
const ok = (msg?: string, data?: any): ReqResult => ({ ok: true, msg, data });
const fail = (msg: string): ReqResult => ({ ok: false, msg });

export class RoomAuthority {
  constructor(private room: Room, private startMatch: () => ReqResult) {
    const r = room;
    r.hostHooks.onLeave.push((id) => this.onLeave(id));
    r.registerHandler('party.create', (from, a) => this.create(from, a.name));
    r.registerHandler('party.invite', (from, a) => this.invite(from, a.target));
    r.registerHandler('party.accept', (from, a) => this.accept(from, a.partyId));
    r.registerHandler('party.decline', (from, a) => this.decline(from, a.partyId));
    r.registerHandler('party.leave', (from) => this.leaveParty(from));
    r.registerHandler('party.transfer', (from, a) => this.transfer(from, a.target));
    r.registerHandler('party.kick', (from, a) => this.kick(from, a.target));
    r.registerHandler('ready', (from, a) => this.ready(from, !!a.ready));
    r.registerHandler('profile', (from, a) => this.profile(from, a));
    r.registerHandler('cosmetic.buy', (from, a) => this.buyCosmetic(from, a.id));
    r.registerHandler('cosmetic.equip', (from, a) => this.equipCosmetic(from, a.id));
    r.registerHandler('finish', (from, a) => this.setFinish(from, a.id));
    r.registerHandler('drink', (from, a) => this.drink(from, a.id));
    r.registerHandler('setup.assign', (from, a) => this.assign(from, a.player, a.team));
    r.registerHandler('setup.rounds', (from, a) => this.rounds(from, a.rounds));
    r.registerHandler('setup.fromParties', (from) => this.fromParties(from));
    r.registerHandler('setup.shuffle', (from) => this.shuffle(from));
    r.registerHandler('match.start', (from) => (from === this.s.hostId ? this.startMatch() : fail('Only the host can start the match.')));
    r.registerHandler('kick', (from, a) => this.kickFromRoom(from, a.target));
    r.registerHandler('weather.rain', (from, a) => this.setRain(from, !!a.on));
  }

  private get s(): RoomState { return this.room.state!; }

  private onLeave(id: string): void {
    const s = this.s;
    if (!s) return;
    for (const p of Object.values(s.parties)) {
      p.invites = p.invites.filter((x) => x !== id);
      if (p.members.includes(id)) this.removeMember(p, id);
    }
    s.setup.alpha = s.setup.alpha.filter((x) => x !== id);
    s.setup.bravo = s.setup.bravo.filter((x) => x !== id);
  }

  private removeMember(p: Party, id: string): void {
    const s = this.s;
    p.members = p.members.filter((x) => x !== id);
    if (s.players[id]) { s.players[id].partyId = null; s.players[id].ready = false; }
    if (p.members.length === 0) { delete s.parties[p.id]; return; }
    if (p.leader === id) p.leader = p.members[0];
  }

  private partyOf(id: string): Party | null {
    const pid = this.s.players[id]?.partyId;
    return pid ? this.s.parties[pid] ?? null : null;
  }

  create(from: string, name: unknown): ReqResult {
    if (this.partyOf(from)) return fail('Leave your current party first.');
    const id = randomId(6);
    const p: Party = { id, name: String(name || `${this.s.players[from].name}'s crew`).slice(0, 24), leader: from, members: [from], invites: [] };
    this.s.parties[id] = p;
    this.s.players[from].partyId = id;
    this.room.commit();
    return ok('Party created.');
  }

  invite(from: string, target: unknown): ReqResult {
    const p = this.partyOf(from);
    if (!p) return fail('Create a party first.');
    if (p.leader !== from) return fail('Only the party leader can invite.');
    if (typeof target !== 'string' || !this.s.players[target]) return fail('Player not found.');
    if (p.members.includes(target)) return fail('Already in your party.');
    if (p.members.length + p.invites.length >= MAX_PARTY) return fail(`Parties are limited to ${MAX_PARTY} players.`);
    if (p.invites.includes(target)) return fail('Invite already pending.');
    p.invites.push(target);
    this.room.commit();
    this.room.hostEventTo(target, { e: 'partyInvite', party: p.id, name: p.name, from: this.s.players[from].name });
    return ok(`Invite sent to ${this.s.players[target].name}.`);
  }

  accept(from: string, partyId: unknown): ReqResult {
    const p = typeof partyId === 'string' ? this.s.parties[partyId] : undefined;
    if (!p || !p.invites.includes(from)) return fail('Invite no longer valid.');
    if (p.members.length >= MAX_PARTY) return fail('Party is full.');
    const cur = this.partyOf(from);
    if (cur) this.removeMember(cur, from);
    p.invites = p.invites.filter((x) => x !== from);
    p.members.push(from);
    this.s.players[from].partyId = p.id;
    this.room.commit();
    return ok(`Joined ${p.name}.`);
  }

  decline(from: string, partyId: unknown): ReqResult {
    const p = typeof partyId === 'string' ? this.s.parties[partyId] : undefined;
    if (!p) return fail('Invite no longer valid.');
    p.invites = p.invites.filter((x) => x !== from);
    this.room.commit();
    this.room.hostEventTo(p.leader, { e: 'toast', text: `${this.s.players[from].name} declined your party invite.` });
    return ok('Invite declined.');
  }

  leaveParty(from: string): ReqResult {
    const p = this.partyOf(from);
    if (!p) return fail('Not in a party.');
    this.removeMember(p, from);
    this.room.commit();
    return ok('Left party.');
  }

  transfer(from: string, target: unknown): ReqResult {
    const p = this.partyOf(from);
    if (!p || p.leader !== from) return fail('Only the leader can transfer leadership.');
    if (typeof target !== 'string' || !p.members.includes(target)) return fail('Target is not in your party.');
    p.leader = target;
    this.room.commit();
    return ok('Leadership transferred.');
  }

  kick(from: string, target: unknown): ReqResult {
    const p = this.partyOf(from);
    if (!p || p.leader !== from) return fail('Only the leader can kick.');
    if (typeof target !== 'string' || !p.members.includes(target) || target === from) return fail('Invalid target.');
    this.removeMember(p, target);
    this.room.commit();
    this.room.hostEventTo(target, { e: 'toast', text: `You were removed from ${p.name}.` });
    return ok('Member removed.');
  }

  ready(from: string, ready: boolean): ReqResult {
    this.s.players[from].ready = ready;
    this.room.commit();
    return ok();
  }

  profile(from: string, a: any): ReqResult {
    const p = this.s.players[from];
    if (typeof a.name === 'string') p.name = a.name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || p.name;
    this.room.commit();
    return ok();
  }

  buyCosmetic(from: string, id: unknown): ReqResult {
    const item = COSMETICS.find((c) => c.id === id);
    if (!item) return fail('Unknown item.');
    const p = this.s.players[from];
    if (p.owned.includes(item.id)) return this.equipCosmetic(from, item.id);
    if (p.credits < item.price) return fail(`Not enough credits (need ₵${item.price}).`);
    p.credits -= item.price;
    p.owned.push(item.id);
    p.look = { ...p.look, [item.kind]: item.color };
    this.room.commit();
    return ok(`Purchased ${item.name}.`);
  }

  equipCosmetic(from: string, id: unknown): ReqResult {
    const item = COSMETICS.find((c) => c.id === id);
    const p = this.s.players[from];
    if (!item || !p.owned.includes(item.id)) return fail('You do not own that item.');
    p.look = { ...p.look, [item.kind]: item.color };
    this.room.commit();
    return ok(`Equipped ${item.name}.`);
  }

  setFinish(from: string, id: unknown): ReqResult {
    if (!FINISHES.some((f) => f.id === id)) return fail('Unknown finish.');
    this.s.players[from].finish = id as string;
    this.room.commit();
    return ok('Weapon finish applied.');
  }

  drink(from: string, id: unknown): ReqResult {
    const d = DRINKS.find((x) => x.id === id);
    if (!d) return fail('Unknown drink.');
    const p = this.s.players[from];
    if (p.credits < d.price) return fail('Not enough credits.');
    p.credits -= d.price;
    this.room.commit();
    this.room.hostEvent({ e: 'drink', player: from, drink: d.name });
    return ok(`Enjoy your ${d.name}.`);
  }

  private hostOnly(from: string): ReqResult | null {
    return from === this.s.hostId ? null : fail('Only the host can change match setup.');
  }

  assign(from: string, player: unknown, team: unknown): ReqResult {
    const deny = this.hostOnly(from);
    if (deny) return deny;
    if (this.s.match) return fail('A match is already running.');
    if (typeof player !== 'string' || !this.s.players[player]) return fail('Unknown player.');
    const st = this.s.setup;
    st.alpha = st.alpha.filter((x) => x !== player);
    st.bravo = st.bravo.filter((x) => x !== player);
    if (team === 'alpha' || team === 'bravo') {
      if (st[team].length >= 5) return fail('A team can have at most 5 players.');
      st[team].push(player);
    }
    this.room.commit();
    return ok();
  }

  rounds(from: string, n: unknown): ReqResult {
    const deny = this.hostOnly(from);
    if (deny) return deny;
    const v = Number(n);
    if (![4, 6, 8, 12, 16, 24].includes(v)) return fail('Invalid round count.');
    this.s.setup.rounds = v;
    this.room.commit();
    return ok();
  }

  fromParties(from: string): ReqResult {
    const deny = this.hostOnly(from);
    if (deny) return deny;
    const parties = Object.values(this.s.parties).sort((a, b) => b.members.length - a.members.length);
    const alpha: string[] = [];
    const bravo: string[] = [];
    for (const p of parties) {
      const target = alpha.length <= bravo.length ? alpha : bravo;
      if (target.length + p.members.length <= 5) target.push(...p.members);
      else return fail('Parties do not fit into two teams of 5.');
    }
    for (const p of Object.values(this.s.players)) {
      if (!p.partyId) (alpha.length <= bravo.length ? alpha : bravo).length < 5 && (alpha.length <= bravo.length ? alpha : bravo).push(p.id);
    }
    this.s.setup.alpha = alpha;
    this.s.setup.bravo = bravo;
    this.room.commit();
    return ok('Teams built from parties.');
  }

  shuffle(from: string): ReqResult {
    const deny = this.hostOnly(from);
    if (deny) return deny;
    const ids = Object.keys(this.s.players).sort(() => Math.random() - 0.5);
    const half = Math.ceil(ids.length / 2);
    this.s.setup.alpha = ids.slice(0, Math.min(5, half));
    this.s.setup.bravo = ids.slice(half, half + 5);
    this.room.commit();
    return ok('Teams shuffled.');
  }

  setRain(from: string, on: boolean): ReqResult {
    const deny = from === this.s.hostId ? null : fail('Only the host can change the weather.');
    if (deny) return deny;
    this.s.rain = on;
    this.room.commit();
    this.room.systemChat(on ? 'The host turned the rain ON.' : 'The host turned the rain OFF.');
    return ok(on ? 'Rain enabled.' : 'Rain disabled.');
  }

  kickFromRoom(from: string, target: unknown): ReqResult {
    const deny = this.hostOnly(from);
    if (deny) return deny;
    if (typeof target !== 'string' || target === from || !this.s.players[target]) return fail('Invalid player.');
    const link = this.room.net.links.get(target);
    this.room.hostRemovePlayer(target);
    setTimeout(() => link?.close('kicked'), 200);
    return ok('Player removed.');
  }
}
