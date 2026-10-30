// Local, per-device preferences (stored in localStorage on this device only — never uploaded).
export type Preset = 'LOW' | 'MEDIUM' | 'HIGH' | 'CUSTOM';
export type Level = 0 | 1 | 2 | 3; // off / low / medium / high

export interface GraphicsSettings {
  preset: Preset;
  renderScale: number;      // 0.5 .. 1.0 (multiplied by devicePixelRatio, capped)
  dynamicResolution: boolean;
  shadows: Level;
  reflections: Level;       // 0 off, 1 env probe only, 2 low-res planar, 3 full planar
  post: Level;              // 0 off, 1 tonemap+grade, 2 + bloom, 3 + AO + CA
  particles: Level;
  aa: 'off' | 'fxaa' | 'smaa' | 'msaa';
  fpsLimit: 0 | 30 | 60 | 120;
  motionBlur: boolean;
  fov: number;
}

export interface AudioSettings { master: number; music: number; sfx: number; ambient: number }
export interface ControlSettings { sensitivity: number; invertY: boolean; touchSensitivity: number; touchLayoutScale: number }

export interface Settings {
  graphics: GraphicsSettings;
  audio: AudioSettings;
  controls: ControlSettings;
  name: string;
  look: { jacket: number; visor: number; trim: number };
  finish: string;
  seenTutorial: boolean;
  /** '' = follow the browser language */
  language: '' | 'en' | 'zh' | 'ja';
}

export const PRESETS: Record<Exclude<Preset, 'CUSTOM'>, Omit<GraphicsSettings, 'preset' | 'fpsLimit' | 'fov' | 'motionBlur'>> = {
  LOW: { renderScale: 0.6, dynamicResolution: true, shadows: 1, reflections: 1, post: 1, particles: 1, aa: 'fxaa' },
  MEDIUM: { renderScale: 0.8, dynamicResolution: true, shadows: 2, reflections: 2, post: 2, particles: 2, aa: 'fxaa' },
  HIGH: { renderScale: 1.0, dynamicResolution: false, shadows: 3, reflections: 3, post: 3, particles: 3, aa: 'smaa' },
};

/** `?touch` in the URL forces the touch UI (handy for tablets with keyboards or for testing). */
export const isMobile = (): boolean =>
  new URLSearchParams(location.search).has('touch') ||
  matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function detectPreset(): Exclude<Preset, 'CUSTOM'> {
  if (isMobile()) return 'LOW';
  const cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as any).deviceMemory || 8;
  let gpu = '';
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    gpu = ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  } catch { /* ignore */ }
  if (/Intel|UHD|Iris|Mali|Adreno|PowerVR|SwiftShader|llvmpipe/i.test(gpu) && !/Apple M\d/i.test(gpu)) return 'MEDIUM';
  if (cores >= 8 && mem >= 8) return 'HIGH';
  return 'MEDIUM';
}

const KEY = 'neon-district-settings-v1';

export function defaultSettings(): Settings {
  const preset = detectPreset();
  return {
    graphics: { preset, ...PRESETS[preset], fpsLimit: isMobile() ? 30 : 0, motionBlur: false, fov: 75 },
    audio: { master: 0.8, music: 0.6, sfx: 0.85, ambient: 0.7 },
    controls: { sensitivity: 1, invertY: false, touchSensitivity: 1, touchLayoutScale: 1 },
    name: '',
    look: { jacket: 0x1c2230, visor: 0x00e5ff, trim: 0x00e5ff },
    finish: 'stock',
    seenTutorial: false,
    language: '',
  };
}

export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw);
    return {
      ...d, ...s,
      graphics: { ...d.graphics, ...(s.graphics ?? {}) },
      audio: { ...d.audio, ...(s.audio ?? {}) },
      controls: { ...d.controls, ...(s.controls ?? {}) },
      look: { ...d.look, ...(s.look ?? {}) },
    };
  } catch { return d; }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

export function applyPreset(g: GraphicsSettings, p: Exclude<Preset, 'CUSTOM'>): void {
  Object.assign(g, PRESETS[p], { preset: p });
}
