export type WeaponId = 'p12' | 'vx9' | 'wasp' | 'kestrel' | 'raptor' | 'longbow' | 'breacher' | 'knife';
export type WeaponClass = 'pistol' | 'smg' | 'rifle' | 'sniper' | 'shotgun' | 'melee';
export type Slot = 1 | 2 | 3 | 4 | 5; // 1 primary, 2 secondary, 3 knife, 4 grenades, 5 C4

export interface WeaponDef {
  id: WeaponId;
  name: string;
  cls: WeaponClass;
  model: 'pistol' | 'longpistol' | 'smg' | 'rifle' | 'bullpup' | 'sniper' | 'shotgun' | 'knife';
  slot: 1 | 2 | 3;
  price: number;
  killReward: number;
  damage: number;          // per pellet / bullet, before falloff
  headMult: number;
  armorPen: number;        // 0..1 fraction of damage that ignores armor
  rpm: number;
  magazine: number;
  reserve: number;
  reloadTime: number;      // seconds
  pellets: number;
  spread: number;          // base spread (radians) standing still
  moveSpread: number;      // extra spread when moving at full speed
  adsSpread: number;       // multiplier while aiming
  recoil: number;          // vertical kick per shot (radians)
  recoilYaw: number;       // horizontal jitter
  range: number;           // falloff start
  falloff: number;         // damage multiplier per 10 m after range
  auto: boolean;
  speedMult: number;
  adsFov: number;          // field of view when aiming
  description: string;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  p12: {
    id: 'p12', name: 'P-12 Sidearm', cls: 'pistol', model: 'pistol', slot: 2, price: 200, killReward: 300,
    damage: 30, headMult: 4, armorPen: 0.5, rpm: 360, magazine: 12, reserve: 48, reloadTime: 2.1, pellets: 1,
    spread: 0.006, moveSpread: 0.03, adsSpread: 0.6, recoil: 0.022, recoilYaw: 0.006, range: 20, falloff: 0.88,
    auto: false, speedMult: 1.0, adsFov: 62, description: 'Standard-issue 9 mm sidearm. Reliable and accurate when standing still.',
  },
  vx9: {
    id: 'vx9', name: 'VX-9 Hand Cannon', cls: 'pistol', model: 'longpistol', slot: 2, price: 700, killReward: 300,
    damage: 54, headMult: 3.6, armorPen: 0.85, rpm: 240, magazine: 7, reserve: 35, reloadTime: 2.2, pellets: 1,
    spread: 0.004, moveSpread: 0.06, adsSpread: 0.5, recoil: 0.06, recoilYaw: 0.012, range: 30, falloff: 0.9,
    auto: false, speedMult: 0.98, adsFov: 58, description: 'High-calibre magnum. One headshot through a helmet at close range.',
  },
  wasp: {
    id: 'wasp', name: 'WASP-45 SMG', cls: 'smg', model: 'smg', slot: 1, price: 1250, killReward: 600,
    damage: 26, headMult: 3.2, armorPen: 0.6, rpm: 857, magazine: 30, reserve: 120, reloadTime: 2.3, pellets: 1,
    spread: 0.012, moveSpread: 0.018, adsSpread: 0.7, recoil: 0.012, recoilYaw: 0.008, range: 15, falloff: 0.82,
    auto: true, speedMult: 0.96, adsFov: 60, description: 'Compact bullet hose. Excellent run-and-gun weapon with a big kill bonus.',
  },
  kestrel: {
    id: 'kestrel', name: 'KESTREL AR-7', cls: 'rifle', model: 'rifle', slot: 1, price: 2900, killReward: 300,
    damage: 33, headMult: 4, armorPen: 0.78, rpm: 666, magazine: 30, reserve: 90, reloadTime: 2.5, pellets: 1,
    spread: 0.004, moveSpread: 0.07, adsSpread: 0.55, recoil: 0.016, recoilYaw: 0.007, range: 40, falloff: 0.96,
    auto: true, speedMult: 0.86, adsFov: 50, description: 'Balanced assault rifle with a holographic sight. The backbone of any buy round.',
  },
  raptor: {
    id: 'raptor', name: 'RAPTOR BR-3', cls: 'rifle', model: 'bullpup', slot: 1, price: 3300, killReward: 300,
    damage: 38, headMult: 3.8, armorPen: 0.8, rpm: 540, magazine: 25, reserve: 75, reloadTime: 2.7, pellets: 1,
    spread: 0.003, moveSpread: 0.08, adsSpread: 0.45, recoil: 0.02, recoilYaw: 0.005, range: 45, falloff: 0.97,
    auto: true, speedMult: 0.84, adsFov: 45, description: 'Heavy battle rifle. Hits harder, fires slower, rewards burst control.',
  },
  longbow: {
    id: 'longbow', name: 'LONGBOW .338', cls: 'sniper', model: 'sniper', slot: 1, price: 4750, killReward: 100,
    damage: 115, headMult: 2.5, armorPen: 0.97, rpm: 41, magazine: 5, reserve: 25, reloadTime: 3.6, pellets: 1,
    spread: 0.0008, moveSpread: 0.12, adsSpread: 0.02, recoil: 0.09, recoilYaw: 0.01, range: 120, falloff: 0.99,
    auto: false, speedMult: 0.78, adsFov: 18, description: 'Bolt-action precision rifle. One body shot kills. Inaccurate unless scoped.',
  },
  breacher: {
    id: 'breacher', name: 'BREACHER-12', cls: 'shotgun', model: 'shotgun', slot: 1, price: 1800, killReward: 900,
    damage: 20, headMult: 2.2, armorPen: 0.55, rpm: 70, magazine: 8, reserve: 32, reloadTime: 3.0, pellets: 9,
    spread: 0.055, moveSpread: 0.01, adsSpread: 0.8, recoil: 0.07, recoilYaw: 0.02, range: 6, falloff: 0.55,
    auto: false, speedMult: 0.9, adsFov: 62, description: 'Pump-action door kicker. Devastating inside 8 m, useless beyond 20.',
  },
  knife: {
    id: 'knife', name: 'MONO-EDGE Knife', cls: 'melee', model: 'knife', slot: 3, price: 0, killReward: 1500,
    damage: 55, headMult: 1, armorPen: 0.85, rpm: 100, magazine: 0, reserve: 0, reloadTime: 0, pellets: 1,
    spread: 0, moveSpread: 0, adsSpread: 1, recoil: 0, recoilYaw: 0, range: 2, falloff: 1,
    auto: true, speedMult: 1.05, adsFov: 70, description: 'Monomolecular blade. Range 2 m.',
  },
};

export type GrenadeId = 'smoke' | 'flash' | 'molotov';
export type GearId = 'kevlar' | 'helmet' | 'kit' | GrenadeId;

export interface GearDef { id: GearId; name: string; price: number; description: string; side?: 'DEF' }
export const GEAR: Record<GearId, GearDef> = {
  kevlar: { id: 'kevlar', name: 'Kevlar Vest', price: 650, description: '100 armor. Reduces body damage.' },
  helmet: { id: 'helmet', name: 'Kevlar + Helmet', price: 1000, description: '100 armor plus helmet. Protects against headshots.' },
  kit: { id: 'kit', name: 'Defuse Kit', price: 400, description: 'Halves C4 defuse time (10 s → 5 s). Defenders only.', side: 'DEF' },
  smoke: { id: 'smoke', name: 'Smoke Grenade', price: 300, description: 'Blocks vision for 18 s. Extinguishes incendiaries.' },
  flash: { id: 'flash', name: 'Flashbang', price: 200, description: 'Blinds anyone looking at it.' },
  molotov: { id: 'molotov', name: 'Incendiary', price: 500, description: 'Area denial fire for 7 s.' },
};

export const PRIMARY_ORDER: WeaponId[] = ['wasp', 'breacher', 'kestrel', 'raptor', 'longbow'];
export const SECONDARY_ORDER: WeaponId[] = ['p12', 'vx9'];

export const FINISHES = [
  { id: 'stock', name: 'Factory Black', color: 0x1d1f24, accent: 0x00e5ff },
  { id: 'chrome', name: 'Liquid Chrome', color: 0x9aa3ad, accent: 0x00e5ff },
  { id: 'magenta', name: 'Synth Magenta', color: 0x3a1030, accent: 0xff2bd6 },
  { id: 'hazard', name: 'Hazard Orange', color: 0x3a2410, accent: 0xff7a1a },
  { id: 'ghost', name: 'Ghost White', color: 0xc9ccd2, accent: 0x7a5cff },
];
