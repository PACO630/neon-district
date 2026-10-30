// Generates the game's GLB assets (rigged character + animation clips, weapons, C4, grenades)
// into public/models. Run with `npm run models`. Output is committed so GitHub Pages serves it statically.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { writeFileSync, mkdirSync } from 'node:fs';

// Minimal FileReader polyfill for GLTFExporter running in Node.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); }); }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((b) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(b).toString('base64')}`;
      this.onloadend?.();
    });
  }
};

const OUT = new URL('../public/models/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const mat = (name, color, metalness, roughness, emissive = 0x000000, emissiveIntensity = 1) => {
  const m = new THREE.MeshStandardMaterial({ name, color, metalness, roughness, emissive, emissiveIntensity });
  return m;
};

// ---------------------------------------------------------------- character
const M = {
  jacket: mat('Jacket', 0x1c2230, 0.15, 0.55),
  jacketAccent: mat('JacketAccent', 0x2a6f8a, 0.3, 0.4),
  pants: mat('Pants', 0x15171c, 0.05, 0.8),
  skin: mat('Skin', 0xc89a7c, 0.0, 0.62),
  boots: mat('Boots', 0x0c0d10, 0.2, 0.45),
  armor: mat('Armor', 0x343a44, 0.85, 0.32),
  visor: mat('Visor', 0x05080c, 0.6, 0.12, 0x00e5ff, 2.2),
  trim: mat('Trim', 0x111111, 0.2, 0.4, 0x00e5ff, 2.6),
  hair: mat('Hair', 0x101014, 0.1, 0.7),
  glove: mat('Glove', 0x1a1a1f, 0.1, 0.7),
};

function rbox(w, h, d, r, material, name, seg = 2) {
  const g = new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2, h / 2, d / 2) * 0.99);
  const mesh = new THREE.Mesh(g, material);
  mesh.name = name;
  return mesh;
}
function cyl(rt, rb, h, material, name, seg = 12) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), material);
  mesh.name = name;
  return mesh;
}
function node(name, x = 0, y = 0, z = 0) {
  const g = new THREE.Object3D();
  g.name = name;
  g.position.set(x, y, z);
  return g;
}

function buildCharacter() {
  const root = node('Character');
  const hips = node('Hips', 0, 0.98, 0);
  root.add(hips);

  const pelvis = rbox(0.34, 0.16, 0.2, 0.05, M.pants, 'PelvisMesh');
  hips.add(pelvis);
  const belt = rbox(0.36, 0.04, 0.22, 0.015, M.armor, 'BeltMesh');
  belt.position.y = 0.07;
  hips.add(belt);
  const buckle = rbox(0.06, 0.03, 0.02, 0.005, M.trim, 'BuckleMesh');
  buckle.position.set(0, 0.07, 0.115);
  hips.add(buckle);

  const spine = node('Spine', 0, 0.1, 0);
  hips.add(spine);
  const abdomen = rbox(0.3, 0.2, 0.18, 0.06, M.jacket, 'AbdomenMesh');
  abdomen.position.y = 0.1;
  spine.add(abdomen);

  const chest = node('Chest', 0, 0.2, 0);
  spine.add(chest);
  const torso = rbox(0.42, 0.3, 0.22, 0.07, M.jacket, 'TorsoMesh');
  torso.position.y = 0.13;
  chest.add(torso);
  const vest = rbox(0.36, 0.24, 0.06, 0.02, M.armor, 'VestMesh');
  vest.position.set(0, 0.12, 0.1);
  chest.add(vest);
  const strip = rbox(0.02, 0.2, 0.01, 0.004, M.trim, 'ChestStripMesh');
  strip.position.set(0.1, 0.13, 0.135);
  chest.add(strip);
  const collar = rbox(0.3, 0.07, 0.2, 0.03, M.jacketAccent, 'CollarMesh');
  collar.position.y = 0.3;
  chest.add(collar);
  const pack = rbox(0.3, 0.26, 0.1, 0.03, M.armor, 'BackpackMesh');
  pack.position.set(0, 0.12, -0.15);
  chest.add(pack);
  const packLight = rbox(0.2, 0.015, 0.01, 0.004, M.trim, 'BackpackLight');
  packLight.position.set(0, 0.2, -0.205);
  chest.add(packLight);

  const neck = node('Neck', 0, 0.32, 0);
  chest.add(neck);
  const neckMesh = cyl(0.05, 0.06, 0.08, M.skin, 'NeckMesh');
  neckMesh.position.y = 0.03;
  neck.add(neckMesh);
  const head = node('Head', 0, 0.07, 0);
  neck.add(head);
  const skull = rbox(0.2, 0.24, 0.22, 0.08, M.skin, 'HeadMesh');
  skull.position.y = 0.11;
  head.add(skull);
  const hair = rbox(0.215, 0.1, 0.235, 0.05, M.hair, 'HairMesh');
  hair.position.set(0, 0.2, -0.01);
  head.add(hair);
  const visor = rbox(0.21, 0.06, 0.06, 0.025, M.visor, 'VisorMesh');
  visor.position.set(0, 0.13, 0.095);
  head.add(visor);
  const earL = rbox(0.03, 0.07, 0.07, 0.015, M.armor, 'EarPieceL');
  earL.position.set(0.11, 0.11, 0);
  head.add(earL);
  const earR = earL.clone();
  earR.name = 'EarPieceR';
  earR.position.x = -0.11;
  head.add(earR);

  for (const side of ['L', 'R']) {
    const s = side === 'L' ? 1 : -1;
    const shoulder = node(`Shoulder${side}`, 0.25 * s, 0.26, 0);
    chest.add(shoulder);
    const pad = rbox(0.13, 0.08, 0.15, 0.03, M.armor, `ShoulderPad${side}`);
    pad.position.set(0.02 * s, 0.03, 0);
    shoulder.add(pad);
    const upper = node(`ArmUpper${side}`, 0, 0, 0);
    shoulder.add(upper);
    const um = rbox(0.1, 0.28, 0.1, 0.04, M.jacket, `ArmUpperMesh${side}`);
    um.position.y = -0.14;
    upper.add(um);
    const band = rbox(0.105, 0.025, 0.105, 0.01, M.trim, `ArmBand${side}`);
    band.position.y = -0.08;
    upper.add(band);
    const lower = node(`ArmLower${side}`, 0, -0.28, 0);
    upper.add(lower);
    const lm = rbox(0.09, 0.26, 0.09, 0.035, M.jacketAccent, `ArmLowerMesh${side}`);
    lm.position.y = -0.13;
    lower.add(lm);
    const hand = node(`Hand${side}`, 0, -0.27, 0);
    lower.add(hand);
    const hm = rbox(0.08, 0.1, 0.05, 0.02, M.glove, `HandMesh${side}`);
    hm.position.y = -0.04;
    hand.add(hm);

    const legU = node(`LegUpper${side}`, 0.1 * s, -0.04, 0);
    hips.add(legU);
    const lum = rbox(0.14, 0.42, 0.15, 0.05, M.pants, `LegUpperMesh${side}`);
    lum.position.y = -0.21;
    legU.add(lum);
    const kneePad = rbox(0.12, 0.1, 0.05, 0.02, M.armor, `KneePad${side}`);
    kneePad.position.set(0, -0.42, 0.07);
    legU.add(kneePad);
    const legL = node(`LegLower${side}`, 0, -0.42, 0);
    legU.add(legL);
    const llm = rbox(0.12, 0.42, 0.13, 0.045, M.pants, `LegLowerMesh${side}`);
    llm.position.y = -0.21;
    legL.add(llm);
    const foot = node(`Foot${side}`, 0, -0.42, 0);
    legL.add(foot);
    const fm = rbox(0.12, 0.09, 0.26, 0.03, M.boots, `FootMesh${side}`);
    fm.position.set(0, -0.035, 0.05);
    foot.add(fm);
    const sole = rbox(0.121, 0.015, 0.2, 0.005, M.trim, `Sole${side}`);
    sole.position.set(0, -0.075, 0.06);
    foot.add(sole);
  }
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return root;
}

// ---- animation authoring helpers
const D = Math.PI / 180;
const BONES = ['Hips', 'Spine', 'Chest', 'Neck', 'Head', 'ShoulderL', 'ShoulderR', 'ArmUpperL', 'ArmUpperR', 'ArmLowerL', 'ArmLowerR',
  'LegUpperL', 'LegUpperR', 'LegLowerL', 'LegLowerR', 'FootL', 'FootR'];

/** pose(t01) -> { bone: [x,y,z] degrees, hipsY: offset, hipsZ } */
function makeClip(name, duration, frames, pose) {
  const times = [];
  const rot = Object.fromEntries(BONES.map((b) => [b, []]));
  const hipPos = [];
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0; i <= frames; i++) {
    const t = i / frames;
    times.push(t * duration);
    const p = pose(t);
    for (const b of BONES) {
      const a = p[b] || [0, 0, 0];
      e.set(a[0] * D, a[1] * D, a[2] * D, 'XYZ');
      q.setFromEuler(e);
      rot[b].push(q.x, q.y, q.z, q.w);
    }
    hipPos.push(0, 0.98 + (p.hipsY || 0), p.hipsZ || 0);
  }
  const tracks = BONES.map((b) => new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times, rot[b]));
  tracks.push(new THREE.VectorKeyframeTrack('Hips.position', times, hipPos));
  return new THREE.AnimationClip(name, duration, tracks);
}
const S = (t, k = 1, ph = 0) => Math.sin((t * k + ph) * Math.PI * 2);

// Arms poses: 'swing' (social), 'rifle' (combat, two-handed), 'pistol'
function arms(mode, t, amp) {
  if (mode === 'rifle') {
    const b = S(t, 2) * 1.5 * amp;
    return {
      ArmUpperR: [-55 + b, 0, -8], ArmLowerR: [-70, 0, 0],
      ArmUpperL: [-75 + b, -25, 30], ArmLowerL: [-45, 0, 0],
      ShoulderL: [0, 0, 0], ShoulderR: [0, 0, 0],
    };
  }
  const sw = S(t) * amp;
  return {
    ArmUpperL: [-sw, 0, 6], ArmUpperR: [sw, 0, -6],
    ArmLowerL: [-15 - Math.max(0, -sw) * 0.6, 0, 0], ArmLowerR: [-15 - Math.max(0, sw) * 0.6, 0, 0],
  };
}
function legsGait(t, amp, knee, bob) {
  const l = S(t);
  const r = S(t, 1, 0.5);
  return {
    LegUpperL: [-l * amp, 0, 0], LegUpperR: [-r * amp, 0, 0],
    LegLowerL: [Math.max(0, S(t, 1, 0.25)) * knee + 4, 0, 0],
    LegLowerR: [Math.max(0, S(t, 1, 0.75)) * knee + 4, 0, 0],
    FootL: [l * amp * 0.25, 0, 0], FootR: [r * amp * 0.25, 0, 0],
    hipsY: -Math.abs(S(t, 2, 0.25)) * bob,
  };
}

function buildClips() {
  const clips = [];
  for (const mode of ['swing', 'rifle']) {
    const pre = mode === 'rifle' ? 'Rifle' : '';
    clips.push(makeClip(`${pre}Idle`, 3, 30, (t) => ({
      ...arms(mode, t, mode === 'rifle' ? 1 : 3),
      Chest: [S(t) * 1.5, mode === 'rifle' ? -12 : 0, 0], Head: [-S(t) * 1.5, mode === 'rifle' ? 12 : S(t, 0.5) * 6, 0],
      Spine: [0, 0, S(t, 0.5) * 1], LegLowerL: [3, 0, 0], LegLowerR: [3, 0, 0], hipsY: S(t) * 0.006,
    })));
    clips.push(makeClip(`${pre}Walk`, 1.0, 24, (t) => ({
      ...legsGait(t, 28, 40, 0.035), ...arms(mode, t, 22),
      Chest: [4, S(t) * 5 + (mode === 'rifle' ? -12 : 0), 0], Head: [-4, -S(t) * 5 + (mode === 'rifle' ? 12 : 0), 0], Spine: [0, 0, S(t) * 2],
    })));
    clips.push(makeClip(`${pre}Run`, 0.66, 20, (t) => ({
      ...legsGait(t, 48, 85, 0.07), ...arms(mode, t, 50),
      Spine: [10, 0, 0], Chest: [6, S(t) * 9 + (mode === 'rifle' ? -12 : 0), 0], Head: [-12, -S(t) * 9 + (mode === 'rifle' ? 12 : 0), 0],
      ArmLowerL: mode === 'rifle' ? [-45, 0, 0] : [-70, 0, 0], ArmLowerR: mode === 'rifle' ? [-70, 0, 0] : [-70, 0, 0],
    })));
    clips.push(makeClip(`${pre}Crouch`, 2, 20, (t) => ({
      ...arms(mode, t, 2),
      LegUpperL: [-70, 0, 4], LegUpperR: [-55, 0, -4], LegLowerL: [110, 0, 0], LegLowerR: [95, 0, 0],
      FootL: [-35, 0, 0], FootR: [-38, 0, 0], Spine: [20, 0, 0], Chest: [5, mode === 'rifle' ? -12 : 0, 0], Head: [-22, 0, 0], hipsY: -0.36,
    })));
    clips.push(makeClip(`${pre}CrouchWalk`, 1.2, 24, (t) => {
      const g = legsGait(t, 22, 25, 0.02);
      return {
        ...arms(mode, t, 4),
        LegUpperL: [-62 + g.LegUpperL[0], 0, 4], LegUpperR: [-62 + g.LegUpperR[0], 0, -4],
        LegLowerL: [100 + g.LegLowerL[0] * 0.5, 0, 0], LegLowerR: [100 + g.LegLowerR[0] * 0.5, 0, 0],
        FootL: [-35, 0, 0], FootR: [-35, 0, 0], Spine: [20, 0, 0], Chest: [5, mode === 'rifle' ? -12 : 0, 0], Head: [-22, 0, 0], hipsY: -0.34 + g.hipsY,
      };
    }));
    clips.push(makeClip(`${pre}Jump`, 0.8, 16, (t) => ({
      ...arms(mode, 0.25, mode === 'rifle' ? 0 : 40),
      LegUpperL: [-50, 0, 0], LegUpperR: [-20, 0, 0], LegLowerL: [70, 0, 0], LegLowerR: [45, 0, 0], Spine: [6, 0, 0],
    })));
  }
  clips.push(makeClip('Die', 1.1, 33, (t) => {
    const k = Math.min(1, t * 1.25);
    const e = 1 - Math.pow(1 - k, 3);
    return {
      Hips: [-88 * e, 0, 10 * e], hipsY: -0.82 * e, hipsZ: -0.45 * e, Spine: [-10 * e, 0, 0], Head: [-20 * e, 25 * e, 0],
      ArmUpperL: [-150 * e, 0, 40 * e], ArmUpperR: [-120 * e, 0, -50 * e], ArmLowerL: [-20 * e, 0, 0], ArmLowerR: [-50 * e, 0, 0],
      LegUpperL: [-20 * e, 0, 12 * e], LegUpperR: [5 * e, 0, -8 * e], LegLowerL: [40 * e, 0, 0], LegLowerR: [10 * e, 0, 0],
    };
  }));
  clips.push(makeClip('Sit', 4, 24, (t) => ({
    LegUpperL: [-88, 0, 6], LegUpperR: [-88, 0, -6], LegLowerL: [88, 0, 0], LegLowerR: [85, 0, 0],
    ArmUpperL: [-35, 0, 10], ArmUpperR: [-40, 0, -10], ArmLowerL: [-50, 0, 0], ArmLowerR: [-55, 0, 0],
    Chest: [S(t) * 2, 0, 0], Head: [S(t, 0.5) * 4, S(t, 0.25) * 18, 0], hipsY: -0.47,
  })));
  clips.push(makeClip('Drink', 3, 36, (t) => {
    const lift = Math.max(0, Math.sin(t * Math.PI));
    return {
      ArmUpperR: [-30 - 70 * lift, 0, -15], ArmLowerR: [-60 - 60 * lift, 0, 0], ArmUpperL: [0, 0, 6], ArmLowerL: [-15, 0, 0],
      Head: [-18 * lift, 0, 0], Chest: [-3 * lift, 0, 0], LegLowerL: [3, 0, 0], LegLowerR: [3, 0, 0],
    };
  }));
  clips.push(makeClip('Wave', 1.6, 32, (t) => ({
    ArmUpperR: [-10, 0, -150], ArmLowerR: [0, 0, -25 + S(t, 2) * 25], ArmUpperL: [0, 0, 6], ArmLowerL: [-15, 0, 0],
    Head: [0, -10, S(t) * 4], Chest: [0, -8, 0],
  })));
  clips.push(makeClip('Dance', 1.0, 30, (t) => ({
    hipsY: -Math.abs(S(t, 2)) * 0.08, Hips: [0, S(t) * 18, S(t, 2) * 5],
    Chest: [0, -S(t) * 22, S(t, 2) * 6], Head: [S(t, 2) * 10, 0, 0],
    ArmUpperL: [-60 + S(t, 2) * 40, 0, 50], ArmUpperR: [-60 - S(t, 2) * 40, 0, -50], ArmLowerL: [-80, 0, 0], ArmLowerR: [-80, 0, 0],
    LegUpperL: [-Math.max(0, S(t)) * 30, 0, 0], LegUpperR: [-Math.max(0, -S(t)) * 30, 0, 0],
    LegLowerL: [Math.max(0, S(t)) * 50, 0, 0], LegLowerR: [Math.max(0, -S(t)) * 50, 0, 0],
  })));
  clips.push(makeClip('Plant', 1.0, 10, (t) => ({
    LegUpperL: [-95, 0, 8], LegUpperR: [-10, 0, -6], LegLowerL: [100, 0, 0], LegLowerR: [95, 0, 0], FootR: [40, 0, 0],
    Spine: [35, 0, 0], ArmUpperL: [-60, 0, 10], ArmUpperR: [-60, 0, -10], ArmLowerL: [-30 + S(t, 3) * 10, 0, 0], ArmLowerR: [-30 - S(t, 3) * 10, 0, 0],
    Head: [-10, 0, 0], hipsY: -0.42,
  })));
  return clips;
}

// ---------------------------------------------------------------- weapons
const W = {
  metal: mat('GunMetal', 0x2a2d33, 0.9, 0.32),
  dark: mat('GunDark', 0x121316, 0.7, 0.45),
  polymer: mat('Polymer', 0x1d1f24, 0.0, 0.62),
  rubber: mat('Rubber', 0x0b0b0c, 0.0, 0.92),
  accentC: mat('AccentCyan', 0x062a30, 0.4, 0.3, 0x00e5ff, 3.0),
  accentM: mat('AccentMagenta', 0x2a0620, 0.4, 0.3, 0xff2bd6, 3.0),
  accentO: mat('AccentOrange', 0x301806, 0.4, 0.3, 0xff7a1a, 3.0),
  glass: mat('Lens', 0x0a1a22, 0.9, 0.05, 0x003844, 1.0),
  brass: mat('Brass', 0x9b7a3a, 1.0, 0.3),
  c4: mat('C4Body', 0x5a5b42, 0.0, 0.85),
  tape: mat('Tape', 0x26262a, 0.0, 0.7),
  red: mat('LED', 0x300000, 0.0, 0.4, 0xff2020, 4.0),
  screen: mat('Screen', 0x001010, 0.2, 0.2, 0x10ff90, 2.0),
};
const box = (w, h, d, m, x, y, z, name = 'Part') => {
  const mesh = rbox(w, h, d, Math.min(w, h, d) * 0.18, m, name, 1);
  mesh.position.set(x, y, z);
  return mesh;
};
const tube = (r, len, m, x, y, z, name = 'Tube') => {
  const mesh = cyl(r, r, len, m, name, 14);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z);
  return mesh;
};
function muzzle(z, y = 0.03) {
  const n = node('Muzzle', 0, y, z);
  return n;
}
// All weapons: grip at origin, barrel toward -Z. Units meters.
function pistol() {
  const g = node('pistol');
  g.add(box(0.035, 0.11, 0.05, W.polymer, 0, -0.05, 0.015, 'Grip'));
  g.add(box(0.04, 0.045, 0.2, W.metal, 0, 0.03, -0.055, 'Slide'));
  g.add(box(0.036, 0.03, 0.17, W.polymer, 0, 0.0, -0.045, 'Frame'));
  g.add(box(0.006, 0.006, 0.12, W.accentC, 0.021, 0.03, -0.06, 'Strip'));
  g.add(tube(0.008, 0.03, W.dark, 0, 0.03, -0.165, 'Barrel'));
  g.add(box(0.01, 0.012, 0.012, W.accentC, 0, 0.058, -0.14, 'Sight'));
  g.add(muzzle(-0.18));
  return g;
}
function smg() {
  const g = node('smg');
  g.add(box(0.035, 0.1, 0.045, W.rubber, 0, -0.05, 0.02, 'Grip'));
  g.add(box(0.05, 0.075, 0.32, W.polymer, 0, 0.025, -0.08, 'Receiver'));
  g.add(box(0.03, 0.14, 0.035, W.dark, 0, -0.06, -0.09, 'Mag'));
  g.add(tube(0.012, 0.12, W.metal, 0, 0.035, -0.29, 'Barrel'));
  g.add(box(0.04, 0.045, 0.16, W.dark, 0, 0.02, 0.15, 'Stock'));
  g.add(box(0.052, 0.008, 0.2, W.accentM, 0, 0.045, -0.06, 'Strip'));
  g.add(box(0.03, 0.03, 0.06, W.glass, 0, 0.08, -0.04, 'Optic'));
  g.add(muzzle(-0.36));
  return g;
}
function rifle() {
  const g = node('rifle');
  g.add(box(0.035, 0.11, 0.045, W.rubber, 0, -0.055, 0.03, 'Grip'));
  g.add(box(0.055, 0.085, 0.42, W.metal, 0, 0.03, -0.12, 'Receiver'));
  g.add(box(0.05, 0.065, 0.22, W.polymer, 0, 0.02, -0.42, 'Handguard'));
  g.add(tube(0.012, 0.2, W.dark, 0, 0.035, -0.6, 'Barrel'));
  g.add(box(0.034, 0.15, 0.06, W.dark, 0, -0.07, -0.15, 'Mag'));
  g.add(box(0.045, 0.07, 0.22, W.polymer, 0, 0.0, 0.2, 'Stock'));
  g.add(box(0.035, 0.045, 0.1, W.dark, 0, 0.1, -0.12, 'Optic'));
  g.add(box(0.03, 0.03, 0.005, W.accentC, 0, 0.1, -0.172, 'Reticle'));
  g.add(box(0.057, 0.008, 0.3, W.accentC, 0, 0.065, -0.2, 'Strip'));
  g.add(muzzle(-0.71));
  return g;
}
function sniper() {
  const g = node('sniper');
  g.add(box(0.035, 0.11, 0.045, W.rubber, 0, -0.055, 0.03, 'Grip'));
  g.add(box(0.06, 0.08, 0.46, W.dark, 0, 0.025, -0.12, 'Receiver'));
  g.add(tube(0.013, 0.5, W.metal, 0, 0.035, -0.6, 'Barrel'));
  g.add(tube(0.022, 0.08, W.dark, 0, 0.035, -0.87, 'Brake'));
  g.add(tube(0.026, 0.3, W.dark, 0, 0.12, -0.12, 'Scope'));
  g.add(tube(0.022, 0.005, W.glass, 0, 0.12, -0.27, 'LensFront'));
  g.add(box(0.05, 0.1, 0.28, W.polymer, 0, -0.01, 0.24, 'Stock'));
  g.add(box(0.032, 0.09, 0.07, W.dark, 0, -0.05, -0.08, 'Mag'));
  g.add(box(0.062, 0.008, 0.36, W.accentO, 0, 0.068, -0.14, 'Strip'));
  g.add(muzzle(-0.92));
  return g;
}
function shotgun() {
  const g = node('shotgun');
  g.add(box(0.035, 0.11, 0.045, W.rubber, 0, -0.055, 0.03, 'Grip'));
  g.add(box(0.06, 0.08, 0.36, W.metal, 0, 0.03, -0.1, 'Receiver'));
  g.add(tube(0.017, 0.42, W.dark, 0, 0.05, -0.48, 'Barrel'));
  g.add(tube(0.015, 0.36, W.dark, 0, 0.012, -0.45, 'Tube'));
  g.add(box(0.06, 0.05, 0.14, W.polymer, 0, 0.012, -0.42, 'Pump'));
  g.add(box(0.05, 0.08, 0.24, W.polymer, 0, 0.0, 0.22, 'Stock'));
  g.add(box(0.062, 0.008, 0.24, W.accentM, 0, 0.074, -0.1, 'Strip'));
  g.add(muzzle(-0.7, 0.05));
  return g;
}
function knife() {
  const g = node('knife');
  g.add(box(0.025, 0.03, 0.11, W.rubber, 0, 0, 0.0, 'Handle'));
  g.add(box(0.006, 0.035, 0.18, W.metal, 0, 0.005, -0.14, 'Blade'));
  g.add(box(0.007, 0.004, 0.16, W.accentC, 0, 0.022, -0.13, 'Edge'));
  return g;
}
function c4() {
  const g = node('c4');
  g.add(box(0.22, 0.06, 0.14, W.c4, 0, 0.03, 0, 'Charge'));
  g.add(box(0.225, 0.02, 0.03, W.tape, 0, 0.035, 0.04, 'Tape1'));
  g.add(box(0.225, 0.02, 0.03, W.tape, 0, 0.035, -0.04, 'Tape2'));
  g.add(box(0.1, 0.02, 0.07, W.polymer, 0.0, 0.07, 0.0, 'Pad'));
  g.add(box(0.06, 0.004, 0.03, W.screen, 0.0, 0.081, -0.01, 'Display'));
  g.add(box(0.012, 0.008, 0.012, W.red, 0.04, 0.082, 0.02, 'LED'));
  return g;
}
function grenade(name, accent) {
  const g = node(name);
  const body = cyl(0.03, 0.03, 0.09, W.dark, 'Body', 14);
  body.position.y = 0.045;
  g.add(body);
  const top = cyl(0.015, 0.02, 0.025, W.metal, 'Top', 10);
  top.position.y = 0.1;
  g.add(top);
  const band = cyl(0.031, 0.031, 0.012, accent, 'Band', 14);
  band.position.y = 0.06;
  g.add(band);
  return g;
}

async function exportGLB(scene, clips, file) {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(scene, { binary: true, animations: clips, onlyVisible: false });
  writeFileSync(new URL(file, OUT), Buffer.from(result));
  console.log('wrote', file, (result.byteLength / 1024).toFixed(1), 'KB');
}

const character = buildCharacter();
const charScene = new THREE.Scene();
charScene.add(character);
await exportGLB(charScene, buildClips(), 'character.glb');

const weapons = new THREE.Scene();
for (const w of [pistol(), smg(), rifle(), sniper(), shotgun(), knife(), c4(),
  grenade('smoke', W.accentC), grenade('flash', mat('AccentWhite', 0x303030, 0.2, 0.3, 0xffffff, 2.5)), grenade('molotov', W.accentO)]) {
  w.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  weapons.add(w);
}
await exportGLB(weapons, [], 'weapons.glb');
