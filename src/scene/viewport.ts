import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { Ground, type GroundColors } from './ground';
import { makeLabel } from './labels';

// 3D printing files (STL, 3MF) use Z as "up"; make Three.js agree so no
// axis conversion is ever needed on import or export. Must run before any
// camera or light is created.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export interface Palette extends GroundColors {
  dark: boolean;
  background: number;
  label: string;
  outline: number;
  edges: number;
}

const DARK: Palette = {
  dark: true,
  background: 0x0f1318,
  fill: 0x1c2735,
  fillOpacity: 0.35,
  minor: 0x2a3644,
  major: 0x41505f,
  label: '#8a9bb0',
  outline: 0x8cc4ff,
  edges: 0xe6edf5,
};

const LIGHT: Palette = {
  dark: false,
  background: 0xeef1f5,
  fill: 0xc5d0dc,
  fillOpacity: 0.35,
  minor: 0xc2cbd6,
  major: 0x9eabbb,
  label: '#5f6d7d',
  outline: 0x1f6fd1,
  edges: 0x1d2733,
};

/**
 * The 3D view. It draws only when something changed (camera, objects,
 * settings) instead of 60 times a second, so an idle page uses no CPU/GPU.
 * Anything that changes what is on screen calls invalidate().
 */
export class Viewport extends EventTarget {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly orbit: OrbitControls;
  /** Parent of all user objects; picking only looks here. */
  readonly objectRoot = new THREE.Group();
  readonly element: HTMLElement;
  private readonly composer: EffectComposer;
  private readonly outline: OutlinePass;
  private readonly ground = new Ground();
  private readonly sun: THREE.DirectionalLight;
  private readonly raycaster = new THREE.Raycaster();
  private readonly frameCallbacks: (() => void)[] = [];
  private readonly shadowFocus = new THREE.Sphere(new THREE.Vector3(), 100);
  private frameRequested = false;
  private originLabel?: THREE.Mesh;
  palette = DARK;

  constructor(container: HTMLElement) {
    super();
    this.element = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.prepend(this.renderer.domElement);

    this.scene.add(this.objectRoot);

    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
    this.camera.position.set(-170, -260, 210);

    // No damping: the view stops the moment the mouse is released.
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0, 0, 20);
    this.orbit.update();
    this.orbit.addEventListener('change', () => this.invalidate());
    // The controls set an inline "cursor: auto" on the canvas, which would beat
    // every cursor in the stylesheet (turning, panning, zooming, measuring…).
    this.renderer.domElement.style.removeProperty('cursor');
    this.watchCameraCursor(container);

    // A modest even light plus a strong directional one: enough contrast that
    // shallow detail (threads, holes, chamfers) reads clearly.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x303844, 1.15));
    this.sun = new THREE.DirectionalLight(0xffffff, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 4000;
    // Without these, faces shadow themselves in moving stripes ("shadow acne").
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);
    // A weaker light from below so undersides seen through the ground aren't black.
    const under = new THREE.DirectionalLight(0xffffff, 0.4);
    under.position.set(-60, 80, -200);
    this.scene.add(under);

    this.scene.add(this.ground.group);

    // Render through a composer so the selection gets a silhouette outline.
    // The multisampled target keeps edges smooth (the default one has no anti-aliasing).
    const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.outline = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.camera);
    Object.assign(this.outline, { edgeStrength: 5, edgeThickness: 1.5, edgeGlow: 0 });
    this.composer.addPass(this.outline);
    this.composer.addPass(new OutputPass());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  /**
   * Show what a drag or the wheel does to the camera with the mouse cursor:
   * a closed hand while turning, arrows while panning, a magnifier while zooming.
   * Uses the same buttons as the orbit controls: left turns, right (or
   * Ctrl/Shift/Cmd + left) pans, middle drag and the wheel zoom.
   */
  private watchCameraCursor(container: HTMLElement): void {
    const canvas = this.renderer.domElement;
    const modes = ['orbiting', 'panning', 'zooming-in', 'zooming-out'];
    const set = (mode: string | null) => {
      for (const m of modes) container.classList.toggle(m, m === mode);
    };
    let pending: string | null = null;
    let dragging = false;
    canvas.addEventListener('pointerdown', (e) => {
      const pan = e.button === 2 || (e.button === 0 && (e.ctrlKey || e.shiftKey || e.metaKey));
      pending = e.button === 1 ? 'zooming-in' : pan ? 'panning' : e.button === 0 ? 'orbiting' : null;
    });
    this.orbit.addEventListener('start', () => (dragging = true));
    // Only once the camera actually moves, so a plain click keeps the normal cursor.
    this.orbit.addEventListener('change', () => {
      if (dragging && pending) set(pending);
    });
    this.orbit.addEventListener('end', () => {
      dragging = false;
      pending = null;
      set(null);
    });
    let wheelTimer: number | undefined;
    canvas.addEventListener('wheel', (e) => {
      if (dragging) return;
      set(e.deltaY < 0 ? 'zooming-in' : 'zooming-out');
      clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => set(null), 350);
    }, { passive: true });
  }

  /** Ask for one redraw on the next animation frame. Cheap to call often. */
  invalidate(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      for (const cb of this.beforeCallbacks) cb();
      this.updateLightAndGround();
      // The selection outline costs several extra passes; skip them when nothing is selected.
      this.outline.enabled = this.outline.selectedObjects.length > 0;
      this.composer.render();
      for (const cb of this.frameCallbacks) cb();
    });
  }

  private readonly beforeCallbacks: (() => void)[] = [];

  /** Run something just before every frame is drawn (e.g. placing 3D helpers). */
  beforeFrame(cb: () => void): void {
    this.beforeCallbacks.push(cb);
  }

  /** Run something after every rendered frame (e.g. updating overlays). */
  onFrame(cb: () => void): void {
    this.frameCallbacks.push(cb);
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.element;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  /**
   * Keep the light above and behind the viewer's left shoulder (shadows fall
   * away from the viewer), aim it at the objects, and centre the ground fade
   * on what the camera looks at.
   */
  private updateLightAndGround(): void {
    const t = this.orbit.target;
    const view = this.camera.position.clone().sub(t);
    const distance = view.length();
    this.ground.follow(t, distance);
    // Near and far planes follow the zoom. A fixed 1 mm near plane wastes the
    // depth precision when zoomed far out, and the grid starts to show
    // through objects resting on it.
    const near = THREE.MathUtils.clamp(distance / 100, 0.1, 100);
    const far = Math.max(2000, distance * 40);
    if (Math.abs(near - this.camera.near) > near * 0.05 || Math.abs(far - this.camera.far) > far * 0.05) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    view.setZ(0);
    if (view.lengthSq() < 1e-6) view.set(0, -1, 0);
    view.normalize().applyAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(35));
    const c = this.shadowFocus.center;
    const r = this.shadowFocus.radius;
    this.sun.target.position.set(c.x, c.y, 0);
    this.sun.position.set(c.x + view.x * r * 1.5, c.y + view.y * r * 1.5, Math.max(c.z, 0) + r * 3);
  }

  /** Make the shadow map cover these objects (sharp shadows without a huge map). */
  setShadowFocus(box: THREE.Box3 | null): void {
    const want = new THREE.Sphere(new THREE.Vector3(), 100);
    if (box && !box.isEmpty()) box.getBoundingSphere(want);
    // Snap the covered area to steps (size doubles, centre on a grid) so that
    // moving an object doesn't re-aim the light every frame, which makes
    // shadows shimmer and jump.
    const radius = 25 * 2 ** Math.ceil(Math.log2(Math.max(want.radius, 25) / 25));
    const grid = radius / 2;
    const c = want.center;
    const snapped = new THREE.Vector3(Math.round(c.x / grid) * grid, Math.round(c.y / grid) * grid, 0);
    if (snapped.equals(this.shadowFocus.center) && radius === this.shadowFocus.radius) return;
    this.shadowFocus.set(snapped, radius);
    // Room for the shadow to fall beside the objects (and for the snapping).
    const r = radius * 2.5;
    const s = this.sun.shadow.camera;
    s.left = s.bottom = -r;
    s.right = s.top = r;
    s.far = r * 10;
    s.updateProjectionMatrix();
    this.invalidate();
  }

  get width(): number {
    return this.element.clientWidth;
  }

  get height(): number {
    return this.element.clientHeight;
  }

  /** World point → pixel position inside the viewport element. */
  project(p: THREE.Vector3): THREE.Vector2 {
    const v = p.clone().project(this.camera);
    return new THREE.Vector2(((v.x + 1) / 2) * this.width, ((1 - v.y) / 2) * this.height);
  }

  /** Ray through a screen point (client coordinates). */
  rayAt(clientX: number, clientY: number): THREE.Raycaster {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster;
  }

  /** Return the user object under a screen point, or null. */
  pick(clientX: number, clientY: number): THREE.Object3D | null {
    const hit = this.rayAt(clientX, clientY).intersectObjects(this.objectRoot.children, false)[0];
    return hit?.object ?? null;
  }

  setOutlined(objects: THREE.Object3D[]): void {
    this.outline.selectedObjects = objects;
    this.invalidate();
  }

  setTheme(dark: boolean): void {
    this.palette = dark ? DARK : LIGHT;
    this.scene.background = new THREE.Color(this.palette.background);
    this.ground.setColors(this.palette);
    // "0" where the red X and green Y axis lines cross: the origin.
    if (this.originLabel) {
      this.ground.group.remove(this.originLabel);
      this.originLabel.geometry.dispose();
      (this.originLabel.material as THREE.Material).dispose();
    }
    this.originLabel = makeLabel('0', this.palette.label, 5);
    this.originLabel.position.set(-3.5, -4, 0.05);
    this.ground.group.add(this.originLabel);
    this.outline.visibleEdgeColor.setHex(this.palette.outline);
    this.outline.hiddenEdgeColor.setHex(this.palette.outline);
    this.dispatchEvent(new Event('theme'));
    this.invalidate();
  }

  setGridVisible(visible: boolean): void {
    this.ground.group.visible = visible;
    this.invalidate();
  }

  setShadows(enabled: boolean): void {
    this.sun.castShadow = enabled;
    this.invalidate();
  }

  /** Point the camera at a box (or the area around the origin) without changing the viewing angle. */
  fit(box?: THREE.Box3): void {
    const target = box && !box.isEmpty()
      ? box
      : new THREE.Box3(new THREE.Vector3(-60, -60, 0), new THREE.Vector3(60, 60, 20));
    const sphere = target.getBoundingSphere(new THREE.Sphere());
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    // Leave room around the object (and for the rulers and the transform bar).
    const distance = (Math.max(sphere.radius, 10) / Math.sin(fov / 2)) * 1.9;
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, distance);
    this.orbit.update();
    this.invalidate();
  }
}
