// Room-scoped virtual currency rules. Nothing here involves real money; all values vanish with the room.
export const ECONOMY = {
  startMoney: 5000,
  halftimeMoney: 5000,
  maxMoney: 16000,
  roundWin: 3250,
  roundWinBombExplode: 3500,
  roundWinDefuse: 3500,
  lossBase: 1400,
  lossStep: 500,
  lossMax: 3400,
  plantReward: 300,          // planter
  plantTeamLossBonus: 800,   // attackers lose round but bomb was planted
  defuseReward: 300,
  cityStartCredits: 1500,    // NEON CITY credits for cosmetics / drinks
};

export const MATCH_RULES = {
  freezeTime: 10,      // s, buying only
  buyWindow: 25,       // s after freeze ends while in spawn
  roundTime: 115,      // s
  bombTimer: 40,       // s
  plantTime: 3.2,
  defuseTime: 10,
  defuseTimeKit: 5,
  roundEndTime: 6,
  halftimeTime: 8,
  matchEndTime: 12,
  defaultRounds: 12,   // total; first to rounds/2+1 wins, swap at rounds/2
  maxHp: 100,
  maxArmor: 100,
};

export const COSMETICS = [
  { id: 'jacket_neon', kind: 'jacket', name: 'Neon Rider Jacket', price: 400, color: 0x0f3a4a },
  { id: 'jacket_crimson', kind: 'jacket', name: 'Crimson Syndicate', price: 600, color: 0x4a0f1a },
  { id: 'jacket_violet', kind: 'jacket', name: 'Violet Netrunner', price: 600, color: 0x2e1a4a },
  { id: 'jacket_bone', kind: 'jacket', name: 'Bone Corporate', price: 900, color: 0x8a8a82 },
  { id: 'visor_magenta', kind: 'visor', name: 'Magenta HUD Visor', price: 300, color: 0xff2bd6 },
  { id: 'visor_amber', kind: 'visor', name: 'Amber Tactical Visor', price: 300, color: 0xffa31a },
  { id: 'visor_lime', kind: 'visor', name: 'Toxic Lime Visor', price: 450, color: 0x8aff3a },
  { id: 'trim_red', kind: 'trim', name: 'Red Alert Trim', price: 250, color: 0xff2a3a },
  { id: 'trim_violet', kind: 'trim', name: 'Ultraviolet Trim', price: 250, color: 0x8a4dff },
  { id: 'trim_gold', kind: 'trim', name: 'Gold Circuit Trim', price: 700, color: 0xffc34d },
] as const;

export const DRINKS = [
  { id: 'synth_ale', name: 'Synth Ale', price: 40 },
  { id: 'blue_static', name: 'Blue Static', price: 80 },
  { id: 'afterlife', name: 'The Afterlife Special', price: 150 },
];
