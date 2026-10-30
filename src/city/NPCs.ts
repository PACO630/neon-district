// Ambient city NPCs (clearly non-player characters): walkers, shop clerks, bar patrons, guards,
// dancers and workers, each with idle behaviour driven by AnimationMixer clips.
import * as THREE from 'three';
import { Avatar } from '../player/Avatar';
import type { NpcSpot } from './CityBuilder';

const LOOKS = [
  { jacket: 0x2a1a10, visor: 0xffa31a, trim: 0xff7a1a }, { jacket: 0x0f2a3a, visor: 0x00e5ff, trim: 0x00e5ff },
  { jacket: 0x3a0f2a, visor: 0xff2bd6, trim: 0xff2bd6 }, { jacket: 0x1a1a1a, visor: 0x8aff3a, trim: 0x8a4dff },
  { jacket: 0x5a5a60, visor: 0xff2a3a, trim: 0xffffff }, { jacket: 0x20304a, visor: 0x7a5cff, trim: 0x00e5ff },
];

export interface Npc { spot: NpcSpot; avatar: Avatar; pathIdx: number; timer: number; state: number; talkUntil: number }

export class NpcSystem {
  readonly list: Npc[] = [];

  constructor(parent: THREE.Object3D, spots: NpcSpot[]) {
    spots.forEach((spot, i) => {
      const look = spot.kind === 'guard' ? { jacket: 0x14161a, visor: 0xff2a3a, trim: 0xff2a3a } : LOOKS[i % LOOKS.length];
      const avatar = new Avatar(look);
      avatar.root.position.copy(spot.pos);
      avatar.setYaw(spot.yaw, true);
      if (spot.kind === 'guard') avatar.setWeapon('rifle', 'stock');
      const anim = spot.kind === 'walker' ? 'walk' : spot.kind === 'patron' ? 'sit' : spot.kind === 'dancer' ? 'dance' : spot.kind === 'worker' ? 'plant' : 'idle';
      avatar.play(anim, 0);
      avatar.char.mixer.setTime(Math.random() * 3);
      parent.add(avatar.root);
      this.list.push({ spot, avatar, pathIdx: 1, timer: 2 + Math.random() * 6, state: 0, talkUntil: 0 });
    });
  }

  update(dt: number, cam: THREE.Vector3, t: number): void {
    for (const n of this.list) {
      const p = n.avatar.root.position;
      const far = p.distanceToSquared(cam) > 70 * 70;
      n.avatar.root.visible = !far;
      if (n.spot.kind === 'walker' && n.spot.path && n.talkUntil < t) {
        const target = n.spot.path[n.pathIdx % n.spot.path.length];
        const d = target.clone().sub(p).setY(0);
        const len = d.length();
        if (len < 0.4) n.pathIdx++;
        else {
          d.divideScalar(len);
          p.addScaledVector(d, Math.min(len, 1.45 * dt));
          p.y = target.y;
          n.avatar.setYaw(Math.atan2(-d.x, -d.z));
        }
        n.avatar.play('walk');
      } else if (n.talkUntil >= t) {
        n.avatar.play(n.spot.kind === 'patron' ? 'sit' : 'idle');
      } else {
        n.timer -= dt;
        if (n.timer <= 0) {
          n.timer = 4 + Math.random() * 8;
          n.state = (n.state + 1) % 3;
          if (n.spot.kind === 'patron') n.avatar.play(n.state === 1 ? 'drink' : 'sit', 0.4);
          else if (n.spot.kind === 'clerk' || n.spot.kind === 'idle') n.avatar.play(n.state === 2 && Math.random() > 0.5 ? 'wave' : 'idle', 0.4);
          else if (n.spot.kind === 'guard') n.avatar.setYaw(n.spot.yaw + (n.state - 1) * 0.6);
        }
      }
      if (!far) n.avatar.update(dt);
    }
  }

  /** NPC within reach of position, nearest first. */
  nearest(pos: THREE.Vector3, radius = 2.4): Npc | null {
    let best: Npc | null = null;
    let bd = radius * radius;
    for (const n of this.list) {
      const d = n.avatar.root.position.distanceToSquared(pos);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  talk(n: Npc, towards: THREE.Vector3, t: number): string {
    n.talkUntil = t + 4;
    const d = towards.clone().sub(n.avatar.root.position);
    if (n.spot.kind !== 'patron') n.avatar.setYaw(Math.atan2(-d.x, -d.z));
    if (n.spot.kind !== 'walker' && n.spot.kind !== 'patron') n.avatar.play('wave', 0.3);
    return n.spot.lines[Math.floor(Math.random() * n.spot.lines.length)];
  }
}
