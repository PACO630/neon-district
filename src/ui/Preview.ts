// Turntable 3D previews for shop / profile panels. One small shared WebGL renderer draws into
// any number of 2D canvases, so panels never create extra GL contexts.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Assets } from '../engine/Assets';
import { Avatar } from '../player/Avatar';
import type { Look } from '../room/RoomState';

class PreviewRenderer {
  private gl: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 4 / 3, 0.05, 50);
  private holder = new THREE.Group();
  private targets = new Map<HTMLCanvasElement, { obj: THREE.Object3D; dist: number; height: number; avatar?: Avatar }>();
  private raf = 0;
  private last = 0;

  private init(): void {
    if (this.gl) return;
    this.gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.gl.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.gl.setSize(480, 360, false);
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    const pm = new THREE.PMREMGenerator(this.gl);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.6;
    const key = new THREE.DirectionalLight(0xffffff, 2);
    key.position.set(2, 3, 2);
    const rimC = new THREE.PointLight(0x00e5ff, 6, 8);
    rimC.position.set(-2, 1, -1.5);
    const rimM = new THREE.PointLight(0xff2bd6, 5, 8);
    rimM.position.set(2, 0.5, -2);
    this.scene.add(key, rimC, rimM, this.holder);
  }

  show(canvas: HTMLCanvasElement, kind: 'weapon' | 'character', id: string, opts: { finish?: string; look?: Look } = {}): void {
    if (!Assets.loaded) return;
    this.init();
    const prev = this.targets.get(canvas);
    if (prev) { prev.obj.removeFromParent(); prev.avatar?.dispose(); }
    let obj: THREE.Object3D;
    let dist = 1.6, height = 0;
    let avatar: Avatar | undefined;
    if (kind === 'weapon') {
      obj = Assets.weapon(id, opts.finish);
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3()).length();
      const c = box.getCenter(new THREE.Vector3());
      obj.position.sub(c);
      const g = new THREE.Group();
      g.add(obj);
      obj = g;
      dist = size * 1.9 + 0.15;
    } else {
      avatar = new Avatar(opts.look ?? { jacket: 0x1c2230, visor: 0x00e5ff, trim: 0x00e5ff });
      avatar.play(id === 'dance' ? 'dance' : 'idle', 0);
      avatar.setWeapon(null);
      obj = avatar.root;
      dist = 4.4;
      height = 1;
    }
    this.targets.set(canvas, { obj, dist, height, avatar });
    if (!this.raf) this.loop(performance.now());
  }

  release(canvas: HTMLCanvasElement): void {
    const t = this.targets.get(canvas);
    if (t) { t.obj.removeFromParent(); t.avatar?.dispose(); }
    this.targets.delete(canvas);
  }

  private loop = (now: number) => {
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    for (const [canvas, t] of [...this.targets]) {
      if (!canvas.isConnected) { this.release(canvas); continue; }
      this.holder.add(t.obj);
      t.obj.rotation.y = now / 1000 * 0.6;
      t.avatar?.char.mixer.update(dt);
      this.camera.position.set(0, t.height + 0.15, t.dist);
      this.camera.lookAt(0, t.height, 0);
      this.gl!.render(this.scene, this.camera);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        if (canvas.width !== 480) { canvas.width = 480; canvas.height = 360; }
        ctx.clearRect(0, 0, 480, 360);
        ctx.drawImage(this.gl!.domElement, 0, 0, 480, 360);
      }
      this.holder.remove(t.obj);
    }
    this.raf = this.targets.size ? requestAnimationFrame(this.loop) : 0;
  };
}

export const Preview = new PreviewRenderer();
