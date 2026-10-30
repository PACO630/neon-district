import type { AudioEngine } from '../audio/AudioEngine';
import type { Settings } from '../config/settings';
import type { Renderer } from '../engine/Renderer';
import type { TouchControls } from '../mobile/TouchControls';
import type { Net } from '../networking/Net';
import type { Physics } from '../physics/Physics';
import type { Input } from '../player/Input';
import type { Room } from '../room/Room';

export interface GameContext {
  renderer: Renderer;
  input: Input;
  audio: AudioEngine;
  settings: Settings;
  net: Net;
  room: Room;
  touch: TouchControls;
  mobile: boolean;
  newPhysics: () => Physics;
  toast: (text: string, kind?: 'info' | 'error' | 'success' | 'warn') => void;
}
