// WebGL2 renderer + EffectComposer post-processing chain, driven by GraphicsSettings.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import type { GraphicsSettings } from '../config/settings';
import { GLOBAL, LAYER_FX, LAYER_REFLECT_SKIP, PlanarReflection, WET } from './shaders';
import { setMaxAnisotropy } from './textures';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uVignette: { value: 0.55 },
    uCA: { value: 0.0025 },
    uGrain: { value: 0.035 },
    uSat: { value: 1.08 },
    uContrast: { value: 1.06 },
    uLift: { value: new THREE.Vector3(0.006, 0.008, 0.02) },
    uGain: { value: new THREE.Vector3(1.0, 0.99, 1.03) },
    uFlash: { value: 0 },
    uDamage: { value: 0 },
    uDesat: { value: 0 },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uTime, uVignette, uCA, uGrain, uSat, uContrast, uFlash, uDamage, uDesat;
    uniform vec3 uLift, uGain; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec3 c;
      c.r = texture2D(tDiffuse, vUv + d * uCA * (1.0 + r2 * 4.0)).r;
      c.g = texture2D(tDiffuse, vUv).g;
      c.b = texture2D(tDiffuse, vUv - d * uCA * (1.0 + r2 * 4.0)).b;
      c = c * uGain + uLift * (1.0 - c);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat * (1.0 - uDesat));
      c = (c - 0.5) * uContrast + 0.5;
      c += mix(vec3(-0.004, 0.004, 0.018), vec3(0.012, -0.002, 0.006), smoothstep(0.15, 0.85, l));
      vec2 vd = d * vec2(uRes.x / uRes.y, 1.0);
      float vig = smoothstep(1.05, 0.25, length(vd));
      c *= mix(1.0, vig, uVignette);
      c = mix(c, c * vec3(1.0, 0.25, 0.25) + vec3(0.25, 0.0, 0.0), uDamage * smoothstep(0.15, 0.75, length(vd)));
      c += (h(vUv * uRes + fract(uTime) * 100.0) - 0.5) * uGrain;
      c = mix(c, vec3(1.0), clamp(uFlash, 0.0, 1.0));
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }`,
};

/** Camera-rotation motion blur. Rotation-induced screen motion is depth independent, so no depth buffer is needed. */
const MotionBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    uInvProj: { value: new THREE.Matrix4() },
    uProj: { value: new THREE.Matrix4() },
    uCurRot: { value: new THREE.Matrix3() },
    uPrevRotInv: { value: new THREE.Matrix3() },
    uStrength: { value: 0.6 },
  },
  vertexShader: GradeShader.vertexShader,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform mat4 uInvProj, uProj; uniform mat3 uCurRot, uPrevRotInv; uniform float uStrength; varying vec2 vUv;
    void main(){
      vec2 ndc = vUv * 2.0 - 1.0;
      vec4 v = uInvProj * vec4(ndc, 1.0, 1.0);
      vec3 dirW = uCurRot * normalize(v.xyz / v.w);
      vec4 pc = uProj * vec4(uPrevRotInv * dirW, 0.0);
      vec2 prev = pc.xy / max(pc.w, 1e-4);
      vec2 vel = (ndc - prev) * 0.5 * uStrength;
      float len = length(vel);
      if (len > 0.04) vel *= 0.04 / len;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 8; i++) acc += texture2D(tDiffuse, vUv - vel * (float(i) / 7.0 - 0.5)).rgb;
      gl_FragColor = vec4(acc / 8.0, 1.0);
    }`,
};

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  composer!: EffectComposer;
  readonly reflection = new PlanarReflection(0);
  scene: THREE.Scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera = new THREE.PerspectiveCamera(75, 1, 0.05, 1500);
  viewmodelScene: THREE.Scene | null = null;
  viewmodelCamera: THREE.PerspectiveCamera | null = null;
  grade!: ShaderPass;
  private renderPass!: RenderPass;
  private vmPass: RenderPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private gtao: GTAOPass | null = null;
  private motion: ShaderPass | null = null;
  private bokeh: BokehPass | null = null;
  private fxaa: ShaderPass | null = null;
  private settings!: GraphicsSettings;
  private dynScale = 1;
  private frameTimes: number[] = [];
  private prevRot = new THREE.Matrix3();
  menuDof = false;
  width = 1;
  height = 1;

  constructor(container: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false });
    if (!this.gl.capabilities.isWebGL2) throw new Error('WebGL 2 is required.');
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.domElement.id = 'game-canvas';
    container.appendChild(this.gl.domElement);
    setMaxAnisotropy(Math.min(8, this.gl.capabilities.getMaxAnisotropy()));
    this.camera.layers.enable(LAYER_FX);
    this.camera.layers.enable(LAYER_REFLECT_SKIP);
    window.addEventListener('resize', () => this.resize());
  }

  get maxPixelRatio(): number { return Math.min(window.devicePixelRatio || 1, 2); }

  apply(settings: GraphicsSettings): void {
    this.settings = settings;
    const g = this.gl;
    g.shadowMap.enabled = settings.shadows > 0;
    g.shadowMap.type = settings.shadows >= 2 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.reflection.enabled = settings.reflections >= 2;
    this.reflection.scale = settings.reflections >= 3 ? 0.5 : 0.25;
    this.reflection.frameSkip = settings.reflections >= 3 ? 0 : 1;
    WET.uReflectStrength.value = settings.reflections >= 3 ? 1 : 0.85;
    this.dynScale = 1;
    this.buildComposer();
    this.resize();
    // force material recompiles (shadow type change etc.)
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
      else if (m) m.needsUpdate = true;
    });
  }

  private buildComposer(): void {
    const s = this.settings;
    this.composer?.dispose();
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: s.aa === 'msaa' ? 4 : 0 });
    this.composer = new EffectComposer(this.gl, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.gtao = null;
    if (s.post >= 3) {
      this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
      this.gtao.blendIntensity = 0.85;
      this.gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5, scale: 1, samples: 12 });
      this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      this.composer.addPass(this.gtao);
    }
    this.vmPass = null;
    if (this.viewmodelScene && this.viewmodelCamera) this.attachViewmodelPass();
    this.bloom = null;
    if (s.post >= 2) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.55, 0.92);
      this.composer.addPass(this.bloom);
    }
    this.motion = null;
    if (s.motionBlur && s.post >= 1) {
      this.motion = new ShaderPass(MotionBlurShader);
      this.composer.addPass(this.motion);
    }
    this.bokeh = new BokehPass(this.scene, this.camera, { focus: 18, aperture: 0.0012, maxblur: 0.008 });
    this.bokeh.enabled = this.menuDof && s.post >= 2;
    this.composer.addPass(this.bokeh);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    const post = s.post;
    this.grade.uniforms.uCA.value = post >= 3 ? 0.0028 : 0.0;
    this.grade.uniforms.uGrain.value = post >= 2 ? 0.03 : 0.0;
    this.grade.uniforms.uVignette.value = post >= 1 ? 0.55 : 0.3;
    this.composer.addPass(this.grade);
    this.fxaa = null;
    if (s.aa === 'fxaa') {
      this.fxaa = new ShaderPass(FXAAShader);
      this.composer.addPass(this.fxaa);
    } else if (s.aa === 'smaa') {
      this.composer.addPass(new SMAAPass(1, 1));
    }
  }

  private attachViewmodelPass(): void {
    if (!this.viewmodelScene || !this.viewmodelCamera || this.vmPass) return;
    const p = new RenderPass(this.viewmodelScene, this.viewmodelCamera);
    p.clear = false;
    p.clearDepth = true;
    this.vmPass = p;
    // insert after the main render / AO passes
    const idx = this.composer.passes.indexOf(this.gtao ?? this.renderPass) + 1;
    this.composer.insertPass(p, idx);
  }

  setViewmodel(scene: THREE.Scene | null, cam: THREE.PerspectiveCamera | null): void {
    if (this.vmPass) { this.composer.removePass(this.vmPass); this.vmPass = null; }
    this.viewmodelScene = scene;
    this.viewmodelCamera = cam;
    if (scene && cam) this.attachViewmodelPass();
  }

  setScene(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.scene = scene;
    this.camera = camera;
    camera.layers.enable(LAYER_FX);
    camera.layers.enable(LAYER_REFLECT_SKIP);
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
    if (this.gtao) { this.gtao.scene = scene; this.gtao.camera = camera; }
    if (this.bokeh) { (this.bokeh as any).scene = scene; (this.bokeh as any).camera = camera; }
    this.resize();
  }

  setMenuDof(on: boolean): void {
    this.menuDof = on;
    if (this.bokeh) this.bokeh.enabled = on && this.settings.post >= 2;
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.width = w;
    this.height = h;
    const pr = this.maxPixelRatio * this.settings.renderScale * this.dynScale;
    this.gl.setPixelRatio(pr);
    this.gl.setSize(w, h);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.reflection.setSize(w * pr, h * pr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.viewmodelCamera) { this.viewmodelCamera.aspect = w / h; this.viewmodelCamera.updateProjectionMatrix(); }
    if (this.bloom) this.bloom.resolution.set(w * pr * 0.5, h * pr * 0.5);
    this.grade.uniforms.uRes.value.set(w * pr, h * pr);
    if (this.fxaa) this.fxaa.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
  }

  /** Adaptive resolution: keeps frame time near the target by scaling the internal render size. */
  trackFrame(dtMs: number): void {
    if (!this.settings.dynamicResolution) return;
    this.frameTimes.push(dtMs);
    if (this.frameTimes.length < 45) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes.length = 0;
    const target = 1000 / (this.settings.fpsLimit || 60);
    let next = this.dynScale;
    if (avg > target * 1.2) next = Math.max(0.55, this.dynScale - 0.1);
    else if (avg < target * 0.85) next = Math.min(1, this.dynScale + 0.05);
    if (Math.abs(next - this.dynScale) > 0.01) { this.dynScale = next; this.resize(); }
  }
  get dynamicScale(): number { return this.dynScale; }

  render(dt: number): void {
    GLOBAL.uTime.value += dt;
    this.grade.uniforms.uTime.value = GLOBAL.uTime.value;
    this.reflection.render(this.gl, this.scene, this.camera);
    if (this.motion) {
      const u = this.motion.uniforms;
      const cur = new THREE.Matrix3().setFromMatrix4(this.camera.matrixWorld);
      u.uProj.value.copy(this.camera.projectionMatrix);
      u.uInvProj.value.copy(this.camera.projectionMatrixInverse);
      u.uCurRot.value.copy(cur);
      u.uPrevRotInv.value.copy(this.prevRot).transpose();
      u.uStrength.value = Math.min(1, 0.016 / Math.max(dt, 0.001)) * 0.7;
      this.prevRot.copy(cur);
    }
    this.composer.render(dt);
  }
}
