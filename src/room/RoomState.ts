import type { GrenadeId, WeaponId } from '../config/weapons';

export type Device = 'pc' | 'mobile';
export type Side = 'ATK' | 'DEF';
export type TeamKey = 'alpha' | 'bravo';

export interface Look { jacket: number; visor: number; trim: number }

export interface PlayerInfo {
  id: string;
  name: string;
  joinOrder: number;
  device: Device;
  look: Look;
  credits: number;
  owned: string[];
  finish: string;
  partyId: string | null;
  ready: boolean;
}

export interface Party {
  id: string;
  name: string;
  leader: string;
  members: string[];
  invites: string[];
}

export interface MatchPlayer {
  id: string;
  team: TeamKey;
  money: number;
  hp: number;
  armor: number;
  helmet: boolean;
  kit: boolean;
  alive: boolean;
  primary: WeaponId | null;
  secondary: WeaponId | null;
  ammo: Record<string, [number, number]>; // weapon -> [mag, reserve]
  grenades: GrenadeId[];
  kills: number;
  deaths: number;
  assists: number;
  plants: number;
  defuses: number;
  damage: number;
  connected: boolean;
}

export type MatchPhase = 'freeze' | 'live' | 'planted' | 'roundEnd' | 'halftime' | 'ended';
export type BombState = 'carried' | 'dropped' | 'planted' | 'defused' | 'exploded';

export interface BombInfo {
  state: BombState;
  carrier: string | null;
  pos: [number, number, number];
  site: 'A' | 'B' | null;
  planter: string | null;
  defuser: string | null;
  progress: number; // 0..1 of current plant/defuse action
  action: 'plant' | 'defuse' | null;
}

export interface RoundRecord { round: number; winner: TeamKey; reason: string }

export interface MatchState {
  id: string;
  map: 'sector09';
  round: number;
  maxRounds: number;
  alphaSide: Side;
  score: Record<TeamKey, number>;
  lossStreak: Record<TeamKey, number>;
  phase: MatchPhase;
  phaseRemaining: number; // seconds at the moment the state was stamped by the host
  roundStartRemaining: number;
  players: Record<string, MatchPlayer>;
  bomb: BombInfo;
  history: RoundRecord[];
  lastRoundWinner: TeamKey | null;
  lastRoundReason: string;
  winner: TeamKey | 'draw' | null;
}

export interface MatchSetup { alpha: string[]; bravo: string[]; rounds: number }

export interface RoomState {
  roomId: string;
  hostId: string;
  epoch: number;
  version: number;
  nextJoinOrder: number;
  /** host-controlled weather; undefined (older snapshots) means raining */
  rain?: boolean;
  players: Record<string, PlayerInfo>;
  parties: Record<string, Party>;
  setup: MatchSetup;
  match: MatchState | null;
}

export function sideOf(match: MatchState, team: TeamKey): Side {
  return team === 'alpha' ? match.alphaSide : match.alphaSide === 'ATK' ? 'DEF' : 'ATK';
}
export function teamOnSide(match: MatchState, side: Side): TeamKey {
  return match.alphaSide === side ? 'alpha' : 'bravo';
}
export function playerSide(match: MatchState, id: string): Side | null {
  const p = match.players[id];
  return p ? sideOf(match, p.team) : null;
}
export function sortedPlayers(state: RoomState): PlayerInfo[] {
  return Object.values(state.players).sort((a, b) => a.joinOrder - b.joinOrder);
}

export function emptyRoom(roomId: string, hostId: string): RoomState {
  return {
    roomId, hostId, epoch: 1, version: 1, nextJoinOrder: 0,
    players: {}, parties: {}, setup: { alpha: [], bravo: [], rounds: 12 }, match: null, rain: true,
  };
}

/** Basic structural validation of a room snapshot received from the network. */
export function validateRoomState(s: unknown): s is RoomState {
  if (!s || typeof s !== 'object') return false;
  const r = s as RoomState;
  if (typeof r.roomId !== 'string' || typeof r.hostId !== 'string') return false;
  if (!Number.isInteger(r.epoch) || !Number.isInteger(r.version)) return false;
  if (!r.players || typeof r.players !== 'object') return false;
  const ids = Object.keys(r.players);
  if (ids.length > 10) return false;
  for (const id of ids) {
    const p = r.players[id];
    if (!p || p.id !== id || typeof p.name !== 'string' || p.name.length > 24 || !Number.isInteger(p.joinOrder)) return false;
  }
  if (!r.parties || typeof r.parties !== 'object' || !r.setup) return false;
  if (r.match !== null && (typeof r.match !== 'object' || !r.match.players || !r.match.bomb)) return false;
  return true;
}
