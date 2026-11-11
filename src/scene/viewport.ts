import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { Ground, type GroundColors } from './ground';
import { GRID_NUMBER_HEIGHT, makeLabel } from './labels';
import { Reflection } from './reflection';
import { MM_PER_UNIT, settings, settingsEvents, type Unit } from '../settings';
import { acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';

/** Below this many triangles, testing every triangle is already quick. */
const BVH_TRIANGLES = 2000;

/**
 * Let a big object's ray tests skip most of its triangles: a tree of boxes
 * around them (three-mesh-bvh), built the first time the object is tested and
 * kept with its geometry (an object gets new geometry whenever its shape
 * changes, so the tree never goes stale). "Indirect" leaves the geometry
 * exactly as it is, so a hit's triangle number still matches the object's
 * own triangles (face-centre snapping relies on that). The hits are the same
 * as without it, only found faster.
 */
function accelerate(mesh: THREE.Mesh): void {
  const g = mesh.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
  if (g.boundsTree) return;
  const position = g.getAttribute('position');
  const triangles = (g.index ? g.index.count : position?.count ?? 0) / 3;
  if (triangles < BVH_TRIANGLES) return;
  g.boundsTree = new MeshBVH(g, { indirect: true });
  mesh.raycast = acceleratedRaycast;
}

/** Grid lines per unit (mm): minor and major spacing. Inches get quarter-inch and one-inch lines. */
const GRID_STEPS: Record<Unit, { minor: number; major: number }> = {
  mm: { minor: 10, major: 50 },
  cm: { minor: 10, major: 50 },
  in: { minor: 6.35, major: 25.4 },
};
/** Height (mm) of the "0" at the origin, and of the numbers along the axis lines: smaller, and not growing with the step. */
const ORIGIN_HEIGHT = 5;
/** Least distance (px) between two numbers along an axis line */
const GRID_NUMBER_GAP = 60;

// 3D printing files (STL, 3MF) use Z as "up"; make Three.js agree so no
// axis conversion is ever needed on import or export. Must run before any
// camera or light is created.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

/** The camera the page starts with; Home returns to this angle. */
const HOME_POSITION = new THREE.Vector3(-170, -260, 210);
const HOME_TARGET = new THREE.Vector3(0, 0, 20);
/** The middle of the plate, shown when there is nothing else to look at. */
const HOME_AREA = new THREE.Box3(new THREE.Vector3(-60, -60, 0), new THREE.Vector3(60, 60, 20));

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
  /** Numbers along the plate's X and Y axis lines (Plate popover: "Grid values"), rebuilt when the step changes */
  private gridValues = false;
  private gridLabels: { group: THREE.Group; step: number; unit: Unit; dark: boolean; cx: number; cy: number; radius: number } | null = null;
  /** Mirror image of the objects in the plate (Settings; off by default) */
  readonly reflection: Reflection;
  /** The plate fill's see-through value from Settings (null: the colour theme's own) */
  private plateOpacity: number | null = null;
  palette = DARK;

  constructor(container: HTMLElement) {
    super();
    this.element = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Clipping planes per material (Split's preview, the cross-section).
    this.renderer.localClippingEnabled = true;
    container.prepend(this.renderer.domElement);

    this.scene.add(this.objectRoot);

    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
    this.camera.position.copy(HOME_POSITION);

    // No damping: the view stops the moment the mouse is released.
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.copy(HOME_TARGET);
    this.orbit.update();
    this.orbit.addEventListener('change', () => this.invalidate());
    // Dragging the view stops a running turn to a view cube side.
    this.orbit.addEventListener('start', () => this.cameraRun++);
    // The controls set an inline "cursor: auto" on the canvas, which would beat
    // every cursor in the stylesheet (turning, panning, zooming, measuring…).
    this.renderer.domElement.style.removeProperty('cursor');
    this.watchCameraCursor(container);
    this.watchTrackpad(container);

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
    this.applyGridUnit();
    settingsEvents.addEventListener('change', () => {
      this.applyGridUnit();
      this.invalidate();
    });
    this.reflection = new Reflection(this.scene, this.objectRoot);
    this.beforeFrame(() => this.reflection.sync());

    // Render through a composer so the selection gets a silhouette outline.
    // The multisampled target keeps edges smooth (the default one has no anti-aliasing).
    // A stencil buffer too: the cross-section fills its cut faces with it.
    const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType, stencilBuffer: true });
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

  /**
   * Trackpads (a MacBook's, a Windows precision touchpad): a two-finger swipe
   * pans, like two fingers on a phone; a pinch zooms (browsers send it as a
   * wheel event with Ctrl held, which the orbit controls already zoom with).
   * A mouse wheel keeps zooming. A swipe is told apart from a wheel by its
   * sideways part or, in Chrome, Edge and Safari, by its fine-grained legacy
   * value (a wheel moves in steps of 120); once a swipe starts, the rest of
   * that gesture pans too, even the purely vertical events.
   */
  private watchTrackpad(container: HTMLElement): void {
    let swipeUntil = 0;
    let idle: number | undefined;
    // Capture on the container runs before the orbit controls' own wheel handler on the canvas.
    container.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.target !== this.renderer.domElement) return;
      const now = performance.now();
      const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY ?? 0;
      const swipe = now < swipeUntil
        || (e.deltaMode === 0 && (e.deltaX !== 0 || (legacy !== 0 && Math.abs(legacy) === Math.abs(e.deltaY) * 3)));
      if (!swipe) return;
      swipeUntil = now + 200;
      e.preventDefault();
      e.stopPropagation();
      this.panBy(e.deltaX, e.deltaY);
      container.classList.add('panning');
      clearTimeout(idle);
      idle = window.setTimeout(() => container.classList.remove('panning'), 250);
    }, { capture: true, passive: false });
  }

  /** Move the camera and what it looks at sideways by a distance in screen pixels. */
  private panBy(dx: number, dy: number): void {
    this.cameraRun++;
    const distance = this.camera.position.distanceTo(this.orbit.target);
    const perPixel = (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / Math.max(1, this.height);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    // Scrolled content follows the fingers, so the camera moves the other way.
    const move = right.multiplyScalar(dx * perPixel).addScaledVector(up, -dy * perPixel);
    this.camera.position.add(move);
    this.orbit.target.add(move);
    this.orbit.update();
    this.invalidate();
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
    this.updateGridValues(t, distance);
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

  /** While the cross-section hides part of the view: which points are still shown. */
  clipFilter: ((p: THREE.Vector3) => boolean) | null = null;

  /**
   * Hits of a ray on the user objects, nearest first, without cut-away parts.
   * With the cross-section on, both sides of surfaces count: looking into a
   * cut, the ray's first hit is the inside of the far wall.
   */
  /** `bothSides`: also hit faces turned away from the camera (X-ray picking of hidden corners and edges). */
  hitsOn(raycaster: THREE.Raycaster, bothSides = false): THREE.Intersection[] {
    // Objects hidden with the eye button can't be clicked (objects a tool hides for its preview still can).
    const meshes = this.objectRoot.children.filter((o): o is THREE.Mesh => (o as THREE.Mesh).isMesh && !o.userData.userHidden);
    for (const m of meshes) accelerate(m);
    if (!this.clipFilter && !bothSides) return raycaster.intersectObjects(meshes, false);
    const sides = meshes.map((m) => (m.material as THREE.Material).side);
    for (const m of meshes) (m.material as THREE.Material).side = THREE.DoubleSide;
    try {
      const hits = raycaster.intersectObjects(meshes, false);
      return this.clipFilter ? hits.filter((h) => this.clipFilter!(h.point)) : hits;
    } finally {
      meshes.forEach((m, i) => ((m.material as THREE.Material).side = sides[i]));
    }
  }

  /** Return the user object under a screen point (ignoring hidden, cut-away parts), or null. */
  pick(clientX: number, clientY: number): THREE.Object3D | null {
    return this.hitsOn(this.rayAt(clientX, clientY))[0]?.object ?? null;
  }

  setOutlined(objects: THREE.Object3D[]): void {
    this.outline.selectedObjects = objects;
    this.invalidate();
  }

  setTheme(dark: boolean): void {
    this.palette = dark ? DARK : LIGHT;
    this.scene.background = new THREE.Color(this.palette.background);
    this.ground.setColors({ ...this.palette, fillOpacity: this.plateOpacity ?? this.palette.fillOpacity });
    // "0" where the red X and green Y axis lines cross: the origin.
    if (this.originLabel) {
      this.ground.group.remove(this.originLabel);
      this.originLabel.geometry.dispose();
      (this.originLabel.material as THREE.Material).dispose();
    }
    this.originLabel = makeLabel('0', this.palette.label, ORIGIN_HEIGHT);
    this.originLabel.position.set(-3.5, -4, 0.05);
    this.ground.group.add(this.originLabel);
    this.outline.visibleEdgeColor.setHex(this.palette.outline);
    this.outline.hiddenEdgeColor.setHex(this.palette.outline);
    this.dispatchEvent(new Event('theme'));
    this.invalidate();
  }

  /** The grid lines follow the unit setting. */
  private applyGridUnit(): void {
    const { minor, major } = GRID_STEPS[settings.unit];
    this.ground.setSteps(minor, major);
  }

  /** Show numbers (in the scene's unit) along the X and Y axis lines of the plate. */
  setGridValues(on: boolean): void {
    this.gridValues = on;
    if (!on) this.clearGridValues();
    this.invalidate();
  }

  /** How strongly the minor and major grid lines show (1: as designed). */
  setGridLineOpacity(value: number): void {
    this.ground.setLineOpacity(value);
    this.invalidate();
  }

  private clearGridValues(): void {
    const old = this.gridLabels;
    if (!old) return;
    this.gridLabels = null;
    this.ground.group.remove(old.group);
    for (const child of old.group.children) {
      const m = child as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose(); // the text texture is shared and stays cached
    }
  }

  /**
   * Numbers on the axis lines, all the same small size. Which lines get one
   * depends on the zoom: the major lines by default, the minor lines too when
   * zoomed in far enough, and every 2nd, 5th, 10th... major line when zoomed
   * out, so two numbers are never less than about 60 px (or a number's width)
   * apart. They cover the area the grid has not faded out of, and are only
   * rebuilt when the step, the unit, the theme or the area changes.
   */
  private updateGridValues(target: THREE.Vector3, distance: number): void {
    if (!this.gridValues) return;
    const unit = settings.unit;
    const { minor, major } = GRID_STEPS[unit];
    const perUnit = MM_PER_UNIT[unit];
    const pxPerMm = this.height / (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    const radius = Math.max(400, distance * 3) * 0.7;
    // Characters in the widest number: its whole digits, plus the decimals of the step.
    const digits = Math.max(1, Math.floor(Math.log10(Math.max(radius / perUnit, 1))) + 1);
    const text = (mm: number) => String(Math.round((mm / perUnit) * 1e4) / 1e4);
    const fits = (step: number) => {
      const t = text(step);
      const decimals = t.includes('.') ? t.length - t.indexOf('.') : 0;
      const width = GRID_NUMBER_HEIGHT * ((digits + decimals + 1) * 0.5 + 0.3);
      return step * pxPerMm >= Math.max(GRID_NUMBER_GAP, width * pxPerMm * 1.3);
    };
    let step = minor;
    if (!fits(minor)) {
      step = major;
      for (let mag = 1; !fits(step) && mag < 1e9; mag *= 10) {
        step = [1, 2, 5, 10].map((m) => major * mag * m).find(fits) ?? major * mag * 10;
      }
    }
    const cur = this.gridLabels;
    if (cur && cur.step === step && cur.unit === unit && cur.dark === this.palette.dark
      && Math.hypot(target.x - cur.cx, target.y - cur.cy) < cur.radius * 0.25
      && radius < cur.radius * 1.3 && radius > cur.radius * 0.6) return;
    this.clearGridValues();
    const group = new THREE.Group();
    const height = GRID_NUMBER_HEIGHT;
    const fadeAt = Math.max(400, distance * 3);
    const add = (index: number, x: number, y: number, alongX: boolean) => {
      if (index === 0) return; // the "0" label is already there
      const label = makeLabel(text(index * step), this.palette.label, height);
      const w = (label.geometry as THREE.PlaneGeometry).parameters.width;
      // Under the X axis line, left of the Y axis line; clear of the "0" at the origin.
      label.position.set(alongX ? x : -w / 2 - height * 0.2, alongX ? -height * 0.8 : y, 0.05);
      const d = Math.hypot(x - target.x, y - target.y) / fadeAt;
      const fade = 1 - THREE.MathUtils.smoothstep(d, 0.35, 1);
      (label.material as THREE.MeshBasicMaterial).opacity = fade;
      if (fade > 0.02) group.add(label);
      else {
        label.geometry.dispose();
        (label.material as THREE.Material).dispose();
      }
    };
    const from = (c: number) => Math.ceil((c - radius) / step);
    for (let k = from(target.x); k * step <= target.x + radius; k++) add(k, k * step, 0, true);
    for (let k = from(target.y); k * step <= target.y + radius; k++) add(k, 0, k * step, false);
    this.ground.group.add(group);
    this.gridLabels = { group, step, unit, dark: this.palette.dark, cx: target.x, cy: target.y, radius };
  }

  setGridVisible(visible: boolean): void {
    this.ground.group.visible = visible;
    this.invalidate();
  }

  /** How much of the plate's fill shows (0 = clear, 1 = solid); null goes back to the theme's value. */
  setPlateOpacity(value: number | null): void {
    this.plateOpacity = value;
    this.ground.setColors({ ...this.palette, fillOpacity: value ?? this.palette.fillOpacity });
    this.invalidate();
  }

  /**
   * Turn the camera to look from a direction (e.g. a side of the view cube),
   * around the same point and at the same distance, in a short animation.
   */
  /** Bumped by every camera move, so a running viewFrom() animation stops when something else moves the camera. */
  private cameraRun = 0;

  viewFrom(direction: THREE.Vector3): void {
    const target = this.orbit.target.clone();
    const distance = this.camera.position.distanceTo(target);
    const from = this.camera.position.clone().sub(target).normalize();
    const to = direction.clone().normalize();
    // Straight up or down has no "up" on screen; lean a hair towards the front
    // so the front stays at the bottom of the screen.
    if (Math.abs(to.z) > 0.9999) to.set(0, -0.002, Math.sign(to.z)).normalize();
    const turn = new THREE.Quaternion().setFromUnitVectors(from, to);
    const start = performance.now();
    const run = ++this.cameraRun;
    const step = () => {
      if (run !== this.cameraRun) return; // another camera move took over
      const t = Math.min(1, (performance.now() - start) / 280);
      const eased = 1 - (1 - t) ** 3;
      const q = new THREE.Quaternion().slerp(turn, eased);
      this.camera.position.copy(target).addScaledVector(from.clone().applyQuaternion(q), distance);
      this.orbit.update();
      this.invalidate();
      if (t < 1) requestAnimationFrame(step);
    };
    step();
  }

  setShadows(enabled: boolean): void {
    this.sun.castShadow = enabled;
    this.invalidate();
  }

  /** Point the camera at a box (or the area around the origin) without changing the viewing angle. */
  fit(box?: THREE.Box3): void {
    const target = box && !box.isEmpty() ? box : HOME_AREA;
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.look(target, dir, 0);
  }

  /**
   * Back to the view the page starts with: the same viewing angle, zoomed out
   * just enough to show the middle of the plate and every object in `box`.
   */
  home(box?: THREE.Box3): void {
    const area = HOME_AREA.clone();
    if (box && !box.isEmpty()) area.union(box);
    const dir = HOME_POSITION.clone().sub(HOME_TARGET).normalize();
    if (!box || box.isEmpty()) {
      this.cameraRun++;
      this.orbit.target.copy(HOME_TARGET);
      this.camera.position.copy(HOME_POSITION);
      this.orbit.update();
      this.invalidate();
      return;
    }
    this.look(area, dir, HOME_POSITION.distanceTo(HOME_TARGET));
  }

  /** Aim along `dir` at the box's middle, far enough back to see all of it (and at least `minDistance`). */
  private look(box: THREE.Box3, dir: THREE.Vector3, minDistance: number): void {
    this.cameraRun++;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    // Leave room around the object (and for the rulers and the transform bar).
    const distance = Math.max(minDistance, (Math.max(sphere.radius, 10) / Math.sin(fov / 2)) * 1.9);
    this.orbit.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, distance);
    this.orbit.update();
    this.invalidate();
  }
}
