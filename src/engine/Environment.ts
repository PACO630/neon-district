// Shared night environment: sky, fog, hemisphere + moonlight with player-following cascaded-style
// shadow frustum, a real-scene reflection probe (CubeCamera → PMREM), rain and the light pool.
import * as THREE from 'three';
import type { GraphicsSettings } from '../config/settings';
import { createSky, neonEnvironmentScene } from './Atmosphere';
import { LightPool, type LightAnchor } from './Builder';
import { Rain, type Shelter } from './Rain';
import { LAYER_REFLECT_SKIP } from './shaders';

export class NightEnvironment {
  readonly hemi: THREE.HemisphereLight;
  readonly moon: THREE.DirectionalLight;
  readonly rain: Rain;
  readonly sky: THREE.Mesh;
  lightPool: LightPool | null = null;
  private shadowSize: number;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envIntensity = 0.9;

  constructor(readonly scene: THREE.Scene, private settings: GraphicsSettings, opts: { fogDensity: number; drips: THREE.Vector4[]; shelters: Shelter[]; shadowExtent: number; ambient?: number; fogColor?: number }) {
    scene.fog = new THREE.FogExp2(opts.fogColor ?? 0x0b0d1a, opts.fogDensity);
    scene.background = new THREE.Color(0x05060c);
    this.sky = createSky();
    scene.add(this.sky);
    this.hemi = new THREE.HemisphereLight(0x6a7aa8, 0x2a1a18, 0.55 * (opts.ambient ?? 1));
    scene.add(this.hemi);
    this.moon = new THREE.DirectionalLight(0x9fb4ff, 0.55 * Math.min(2.5, opts.ambient ?? 1));
    this.envIntensity = opts.ambient && opts.ambient > 1 ? 1.6 : 0.9;
    this.moon.position.set(30, 60, 20);
    const sq = settings.shadows;
    this.moon.castShadow = sq > 0;
    const res = sq >= 3 ? 4096 : sq === 2 ? 2048 : 1024;
    this.moon.shadow.mapSize.set(res, res);
    this.shadowSize = sq >= 3 ? opts.shadowExtent : sq === 2 ? opts.shadowExtent * 0.8 : opts.shadowExtent * 0.6;
    const c = this.moon.shadow.camera;
    c.left = -this.shadowSize; c.right = this.shadowSize; c.top = this.shadowSize; c.bottom = -this.shadowSize;
    c.near = 1; c.far = 220;
    this.moon.shadow.bias = -0.00025;
    this.moon.shadow.normalBias = 0.035;
    this.moon.shadow.radius = sq >= 3 ? 3 : 2;
    scene.add(this.moon);
    scene.add(this.moon.target);
    const density = [0.15, 0.35, 0.7, 1.0][settings.particles];
    this.rain = new Rain(density, settings.particles >= 2 ? opts.drips : opts.drips.filter((_, i) => i % 3 === 0));
    this.rain.setShelters(opts.shelters);
    scene.add(this.rain.group);
  }

  setLights(parent: THREE.Object3D, anchors: LightAnchor[]): void {
    const s = this.settings;
    const nPoint = s.shadows >= 3 ? 16 : s.shadows === 2 ? 10 : 6;
    const nSpot = s.shadows >= 3 ? 6 : s.shadows === 2 ? 4 : 2;
    const spotShadows = s.shadows >= 3 ? 2 : s.shadows === 2 ? 1 : 0;
    this.lightPool = new LightPool(parent, anchors, nPoint, nSpot, spotShadows);
  }

  /** Capture a reflection probe from the real scene at `at` (Reflection Probe / CubeCamera). */
  captureProbe(renderer: THREE.WebGLRenderer, at: THREE.Vector3): void {
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT?.dispose();
    const size = this.settings.reflections >= 3 ? 256 : 128;
    const cubeRT = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType });
    const cube = new THREE.CubeCamera(0.5, 600, cubeRT);
    for (const child of cube.children) { child.layers.set(0); child.layers.enable(LAYER_REFLECT_SKIP); }
    cube.position.copy(at);
    this.scene.add(cube);
    const prevEnv = this.scene.environment;
    this.scene.environment = null;
    if (this.settings.reflections <= 0) {
      this.envRT = pmrem.fromScene(neonEnvironmentScene(), 0.04);
    } else {
      cube.update(renderer, this.scene);
      this.envRT = pmrem.fromCubemap(cubeRT.texture);
    }
    this.scene.remove(cube);
    cubeRT.dispose();
    pmrem.dispose();
    this.scene.environment = this.envRT.texture ?? prevEnv;
    this.scene.environmentIntensity = this.envIntensity;
  }

  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3): void {
    // keep the shadow frustum centered on the player, snapped to texels to avoid shimmering
    const texel = (this.shadowSize * 2) / this.moon.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.moon.target.position.set(fx, 0, fz);
    this.moon.position.set(fx + 40, 90, fz + 28);
    this.moon.target.updateMatrixWorld();
    this.sky.position.copy(camera.position);
    this.rain.update(dt, camera);
    const cp = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    this.lightPool?.update(dt, cp);
  }
}
