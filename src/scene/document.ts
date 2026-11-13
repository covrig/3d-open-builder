import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { meshId, type MeshData } from '../geometry/meshData';
import { CLIP_BUDGET_MS, subtractChords } from '../geometry/subtractSegments';
import { runOp } from '../geometry/workerClient';
import type { ThreadInfo } from '../geometry/threads';
import type { ColoredPlacedMesh } from '../io/threemf';
import { overhangLayer, overhangMaterial } from './overhang';

/**
 * Colours given to new objects in turn. Mid-tone and fairly saturated so they
 * read well against both the dark and the light background.
 */
export const OBJECT_COLORS = [
  '#4c9be8', '#e8774c', '#4fbf86', '#e0b93a', '#a27de8', '#e05c8f', '#3fc1cf', '#93b83a',
];
const SELECTED_EMISSIVE = 0x1a3050;
/** Edges sharper than this get hard shading; smoother ones are blended. */
const CREASE_ANGLE = THREE.MathUtils.degToRad(30);
const MAX_UNDO = 100;
/** Undo steps kept whatever the memory budget says. */
const MIN_UNDO = 5;

/**
 * The most memory (bytes) that mesh data kept alive only by the undo and redo
 * history may use. Not more, because a browser tab usually fails somewhere
 * between 2 and 4 GB in total, and the live scene, its copies on the graphics
 * card and the geometry worker's copies need that room too. Devices that say
 * they have 4 GB or less get a quarter of it.
 */
function defaultUndoBudget(): number {
  const mem = typeof navigator !== 'undefined' ? (navigator as { deviceMemory?: number }).deviceMemory : undefined;
  return mem !== undefined && mem <= 4 ? 128 * 1024 * 1024 : 512 * 1024 * 1024;
}
let undoBudgetBytes = defaultUndoBudget();

/** Change the history memory budget (for tests). */
export function setUndoBudget(bytes: number): void {
  undoBudgetBytes = bytes;
}

export function undoBudget(): number {
  return undoBudgetBytes;
}

export interface SceneObject {
  id: number;
  name: string;
  /** Geometry in local coordinates, centred on the object's origin. Never mutated. */
  data: MeshData;
  color: string;
  /** The colour the object got when it was created; "Reset" returns to it. */
  defaultColor: string;
  /** Objects sharing a group id are selected and moved together. */
  groupId?: number;
  /** Set on bolts, nuts and rods from Add object; dropped when the shape changes. */
  thread?: ThreadInfo;
  /** Hidden from the view (eye button in the Objects list): not drawn, picked or selected. */
  hidden?: boolean;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
}

/** Everything needed to recreate an object. MeshData is shared, not copied. */
export interface ObjectState {
  id: number;
  name: string;
  data: MeshData;
  color: string;
  defaultColor?: string;
  groupId?: number;
  thread?: ThreadInfo;
  hidden?: boolean;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

export type MeasureKind = 'distance' | 'angle' | 'circle';

/**
 * A measured point. Points on an object are kept in that object's own
 * coordinates, so they move, turn and scale with it; points on the ground
 * are in world coordinates.
 */
export interface MeasurePoint {
  objectId?: number;
  local: THREE.Vector3;
}

export interface Measurement {
  kind: MeasureKind;
  points: MeasurePoint[];
}

export interface SceneState {
  objects: ObjectState[];
  measurements: readonly Measurement[];
}

interface Snapshot {
  objects: ObjectState[];
  selection: number[];
  measurements: Measurement[];
  /** State kept by other features (e.g. the reference picture) */
  extras: Record<string, unknown>;
}

/** A feature outside the document whose state undo and redo take along. */
export interface UndoExtra {
  capture(): unknown;
  restore(value: unknown): void;
}

export interface ViewMode {
  wireframe: boolean;
  xray: boolean;
  /** Draw lines along every sharp edge */
  edges: boolean;
}

/** Edges sharper than this get a line in the Edges view. */
const EDGE_ANGLE = 25;
/** Meshes with more triangles than this get their edge lines worked out in the geometry worker. */
const EDGE_WORKER_TRIANGLES = 50_000;
/** How far (mm) an overlap line may be off an edge line and still count as lying on it. */
const EDGE_CLIP_TOLERANCE = 1e-3;
/** Look of objects faded out while a tool works on others */
const FADED_OPACITY = 0.08;
const FADED_COLOR = 0x8f98a3;
/** Sharp-edge lines (Edges view); the cross-section draws its cut outline with it too. */
export const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xe6edf5 });
/** Fainter, dotted lines where the surfaces of overlapping objects cross (see OverlapLines). Dash sizes are mm, so the geometry needs computeLineDistances(). */
/** How rough object surfaces are: 0.55 is the matt look the app always had; the Shine slider lowers it (see Viewport.setLook). */
export const lookDefaults = { roughness: 0.55 };
export const overlapMaterial = new THREE.LineDashedMaterial({ color: 0xe6edf5, transparent: true, opacity: 0.45, dashSize: 1.5, gapSize: 1 });

/** How solid the edge lines are (Edges tile's Strength slider; 1 = fully solid, as before). */
export function setEdgeStrength(strength: number): void {
  edgeMaterial.transparent = strength < 1;
  edgeMaterial.opacity = strength;
  edgeMaterial.needsUpdate = true;
}

export function setEdgeColor(hex: number): void {
  edgeMaterial.color.setHex(hex);
  overlapMaterial.color.setHex(hex);
}

type DocEvent = 'change' | 'selection' | 'transform' | 'history';
/** The order in which events held back by a batch are sent. */
const EVENT_ORDER: DocEvent[] = ['change', 'transform', 'selection', 'history'];

/**
 * The objects in the scene, the selection, and undo/redo history.
 *
 * Undo works on whole-scene snapshots. That is cheap because mesh data is
 * immutable and shared between snapshots; only transforms, names and colours
 * are copied.
 */
export class SceneDocument extends EventTarget {
  readonly objects: SceneObject[] = [];
  /** In the order the user selected them; Subtract keeps the first one. */
  selection: SceneObject[] = [];
  readonly view: ViewMode = { wireframe: false, xray: false, edges: false };
  /** Never changed in place (replaced instead), so undo snapshots can share it. */
  measurements: readonly Measurement[] = [];
  private nextId = 1;
  private nextGroupId = 1;
  private colorIndex = 0;
  private nameCounters = new Map<string, number>();
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private readonly extras = new Map<string, UndoExtra>();
  /** Objects drawn faintly while a tool works on others (see setFaded) */
  private readonly faded = new Set<SceneObject>();
  /** How many batches are open, and the events they are holding back (see batch) */
  private batchDepth = 0;
  private pendingEvents = new Set<DocEvent>();

  constructor(private readonly root: THREE.Group) {
    super();
  }

  // --- Objects ------------------------------------------------------------

  /** The next colour in the cycle for a new object. */
  nextColor(): string {
    return OBJECT_COLORS[this.colorIndex++ % OBJECT_COLORS.length];
  }

  /** Add a new object, named "<baseName> <n>". Without a colour it gets the next one in the cycle. */
  add(baseName: string, data: MeshData, color?: string): SceneObject {
    return this.create({
      id: this.nextId++,
      name: this.uniqueName(baseName),
      data,
      color: color ?? this.nextColor(),
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
  }

  /** Add a copy of a captured object under a fresh id and name. */
  addCopy(state: ObjectState): SceneObject {
    const base = state.name.replace(/ \d+$/, '');
    return this.create({ ...state, id: this.nextId++, name: this.uniqueName(base) });
  }

  /** Copies of several objects; copies of one group form a new group together. */
  addCopies(states: ObjectState[]): SceneObject[] {
    const groupMap = new Map<number, number>();
    return this.batch(() =>
      states.map((s) => {
        let groupId: number | undefined;
        if (s.groupId !== undefined) {
          if (!groupMap.has(s.groupId)) groupMap.set(s.groupId, this.nextGroupId++);
          groupId = groupMap.get(s.groupId);
        }
        return this.addCopy({ ...s, groupId });
      }),
    );
  }

  // --- Groups -------------------------------------------------------------

  group(objs: SceneObject[]): void {
    const id = this.nextGroupId++;
    for (const o of objs) o.groupId = id;
    this.emit('change');
  }

  ungroup(objs: SceneObject[]): void {
    for (const o of objs) o.groupId = undefined;
    this.emit('change');
  }

  /** The objects plus every other member of their groups. */
  withGroups(objs: SceneObject[]): SceneObject[] {
    const groups = new Set(objs.map((o) => o.groupId).filter((g) => g !== undefined));
    return this.objects.filter((o) => objs.includes(o) || (o.groupId !== undefined && groups.has(o.groupId)));
  }

  /** A new name like "Object 3", numbered per base name. */
  uniqueName(base: string): string {
    const n = (this.nameCounters.get(base) ?? 0) + 1;
    this.nameCounters.set(base, n);
    return `${base} ${n}`;
  }

  private create(state: ObjectState): SceneObject {
    const material = new THREE.MeshStandardMaterial({
      color: state.color,
      roughness: lookDefaults.roughness,
      metalness: 0,
      // Faces of different objects in exactly the same plane (e.g. two 40 mm
      // tall shapes side by side) would flicker as the GPU can't decide which
      // is in front. Each object's faces are pushed back by a slightly
      // different amount, less for newer objects, so the newest one always
      // wins. Pushing back (not forward) also keeps edge lines visible.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1 + 2 * (7 - (state.id % 8)),
    });
    material.clippingPlanes = this.clipping;
    const mesh = new THREE.Mesh(buildGeometry(state.data), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.add(overhangLayer(mesh.geometry));
    mesh.visible = !state.hidden;
    mesh.userData.userHidden = state.hidden === true;
    mesh.position.fromArray(state.position);
    mesh.quaternion.fromArray(state.quaternion);
    mesh.scale.fromArray(state.scale);
    const obj: SceneObject = {
      id: state.id,
      name: state.name,
      data: state.data,
      color: state.color,
      defaultColor: state.defaultColor ?? state.color,
      groupId: state.groupId,
      thread: state.thread,
      hidden: state.hidden,
      mesh,
    };
    if (state.groupId !== undefined) this.nextGroupId = Math.max(this.nextGroupId, state.groupId + 1);
    this.nextId = Math.max(this.nextId, state.id + 1);
    this.applyView(obj);
    this.root.add(mesh);
    this.objects.push(obj);
    this.emit('change');
    return obj;
  }

  remove(objs: SceneObject[]): void {
    this.batch(() => this.removeNow(objs));
  }

  private removeNow(objs: SceneObject[]): void {
    for (const obj of objs) {
      const i = this.objects.indexOf(obj);
      if (i < 0) continue;
      this.objects.splice(i, 1);
      this.faded.delete(obj);
      this.root.remove(obj.mesh);
      delete obj.mesh.userData.edgesPending;
      this.disposeEdgeGeometries(obj);
      obj.mesh.geometry.dispose();
      obj.mesh.material.dispose();
    }
    this.selection = this.selection.filter((o) => !objs.includes(o));
    // Measurements on a removed object go with it (undo brings both back).
    const gone = new Set(objs.map((o) => o.id));
    const onGone = (m: Measurement) => m.points.some((p) => p.objectId !== undefined && gone.has(p.objectId));
    if (this.measurements.some(onGone)) this.measurements = this.measurements.filter((m) => !onGone(m));
    this.emit('change');
    this.emit('selection');
  }

  /** Replace an object's geometry (e.g. after mirroring). */
  setData(obj: SceneObject, data: MeshData): void {
    obj.data = data;
    // A changed shape is no longer the plain threaded part it was made as.
    obj.thread = undefined;
    obj.mesh.geometry.dispose();
    obj.mesh.geometry = buildGeometry(data);
    for (const c of obj.mesh.children) if (c.userData.overhangLayer) (c as THREE.Mesh).geometry = obj.mesh.geometry;
    // Rebuild edge lines for the new shape (a request still out for the old one is dropped).
    delete obj.mesh.userData.edgesPending;
    const edges = obj.mesh.userData.edges as THREE.LineSegments | undefined;
    if (edges) {
      obj.mesh.remove(edges);
      this.disposeEdgeGeometries(obj);
      delete obj.mesh.userData.edges;
    }
    if (this.view.edges) this.applyView(obj);
    this.emit('change');
  }

  /** Give an object a computed shape: the piece's mesh, placed at its centre with no turn or scaling. */
  replaceWithPiece(obj: SceneObject, piece: { mesh: MeshData; center: [number, number, number] }): void {
    this.setData(obj, piece.mesh);
    obj.mesh.position.set(...piece.center);
    obj.mesh.quaternion.identity();
    obj.mesh.scale.set(1, 1, 1);
  }

  setColor(objs: SceneObject[], color: string): void {
    for (const obj of objs) {
      obj.color = color;
      if (!this.faded.has(obj)) obj.mesh.material.color.set(color);
    }
    this.emit('change');
  }

  byMesh(object: THREE.Object3D): SceneObject | undefined {
    return this.objects.find((o) => o.mesh === object);
  }

  capture(obj: SceneObject): ObjectState {
    const m = obj.mesh;
    return {
      id: obj.id,
      name: obj.name,
      data: obj.data,
      color: obj.color,
      defaultColor: obj.defaultColor,
      groupId: obj.groupId,
      thread: obj.thread,
      hidden: obj.hidden,
      position: m.position.toArray() as [number, number, number],
      quaternion: m.quaternion.toArray() as [number, number, number, number],
      scale: m.scale.toArray() as [number, number, number],
    };
  }

  // --- Selection ----------------------------------------------------------

  /** Hide objects from the view or show them again (callers checkpoint first). Hidden objects leave the selection. */
  setHidden(objs: SceneObject[], hidden: boolean): void {
    for (const o of objs) {
      o.hidden = hidden || undefined;
      o.mesh.visible = !hidden;
      o.mesh.userData.userHidden = hidden;
    }
    this.emit('change');
    if (hidden && this.selection.some((o) => objs.includes(o))) this.setSelection(this.selection);
  }

  setSelection(objs: SceneObject[]): void {
    // Hidden objects can't be selected (the eye button shows them again).
    this.selection = objs.filter((o) => !o.hidden);
    for (const o of this.objects) {
      o.mesh.material.emissive.setHex(this.selection.includes(o) ? SELECTED_EMISSIVE : 0x000000);
    }
    this.emit('selection');
  }

  /** Click-select: an object brings its whole group with it. */
  select(obj: SceneObject, additive: boolean): void {
    const members = this.withGroups([obj]);
    if (!additive) return this.setSelection(members);
    const selected = this.selection.includes(obj);
    this.setSelection(
      selected ? this.selection.filter((o) => !members.includes(o)) : [...this.selection, ...members],
    );
  }

  // --- Geometry queries ---------------------------------------------------

  /** World-space bounding box of some objects (exact: from every vertex). */
  worldBox(objs: SceneObject[]): THREE.Box3 {
    const box = new THREE.Box3();
    for (const o of objs) box.union(this.objectBox(o));
    return box;
  }

  /**
   * One object's exact world box, remembered until its shape or placement
   * changes. Dragging asks for boxes many times per mouse move (handles,
   * rulers, the transform bar); this way the vertices are walked once.
   */
  private readonly boxCache = new WeakMap<SceneObject, { data: MeshData; matrix: number[]; box: THREE.Box3 }>();
  private objectBox(o: SceneObject): THREE.Box3 {
    o.mesh.updateMatrixWorld();
    const m = o.mesh.matrixWorld.elements;
    const cached = this.boxCache.get(o);
    if (cached && cached.data === o.data && cached.matrix.every((v, i) => v === m[i])) return cached.box;
    const p = o.data.positions;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (wx < x0) x0 = wx;
      if (wx > x1) x1 = wx;
      if (wy < y0) y0 = wy;
      if (wy > y1) y1 = wy;
      if (wz < z0) z0 = wz;
      if (wz > z1) z1 = wz;
    }
    const box = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
    if (p.length === 0) box.makeEmpty();
    this.boxCache.set(o, { data: o.data, matrix: [...m], box });
    return box;
  }

  placed(obj: SceneObject): ColoredPlacedMesh {
    obj.mesh.updateMatrixWorld();
    // The id (same arrays, nothing copied) lets the geometry worker reuse what it worked out for this mesh; it is never saved.
    return { mesh: { ...obj.data, id: meshId(obj.data) }, matrix: obj.mesh.matrixWorld.elements, name: obj.name, color: obj.color };
  }

  // --- View modes ---------------------------------------------------------

  /** Clipping planes for every object and its edge lines (the cross-section), or null. */
  private clipping: THREE.Plane[] | null = null;

  setClipping(planes: THREE.Plane[] | null): void {
    this.clipping = planes;
    for (const o of this.objects) {
      o.mesh.material.clippingPlanes = planes;
      o.mesh.material.needsUpdate = true;
    }
    for (const m of [edgeMaterial, overlapMaterial, overhangMaterial]) {
      m.clippingPlanes = planes;
      m.needsUpdate = true;
    }
  }

  setView(mode: Partial<ViewMode>): void {
    Object.assign(this.view, mode);
    for (const o of this.objects) this.applyView(o);
  }

  private applyView(obj: SceneObject): void {
    const m = obj.mesh.material;
    m.wireframe = this.view.wireframe;
    m.transparent = this.view.xray;
    m.opacity = this.view.xray ? 0.35 : 1;
    m.depthWrite = !this.view.xray;
    m.needsUpdate = true;

    const existing = obj.mesh.userData.edges as THREE.LineSegments | undefined;
    if (this.view.edges && !existing) {
      if (obj.data.indices.length / 3 > EDGE_WORKER_TRIANGLES) this.requestEdgeLines(obj);
      else this.attachEdgeLines(obj, new THREE.EdgesGeometry(obj.mesh.geometry, EDGE_ANGLE));
    } else if (!this.view.edges) {
      delete obj.mesh.userData.edgesPending; // a late answer from the worker is not wanted any more
      if (existing) {
        obj.mesh.remove(existing);
        this.disposeEdgeGeometries(obj);
        delete obj.mesh.userData.edges;
      }
    }

    // Faded bystanders (see setFaded): very faint plain grey, no lines.
    const faded = this.faded.has(obj);
    if (faded) {
      m.transparent = true;
      m.opacity = FADED_OPACITY;
      m.depthWrite = false;
      m.color.set(FADED_COLOR);
    }
    const lines = obj.mesh.userData.edges as THREE.LineSegments | undefined;
    if (lines) lines.visible = !faded;
    for (const c of obj.mesh.children) if (c.userData.overhangLayer) c.visible = !faded;
  }

  private attachEdgeLines(obj: SceneObject, geometry: THREE.BufferGeometry): void {
    const lines = new THREE.LineSegments(geometry, edgeMaterial);
    lines.raycast = () => {}; // never picked
    obj.mesh.add(lines);
    obj.mesh.userData.edges = lines;
    this.clipEdgeLinesOf(obj);
  }

  /** The edge lines' geometries (the drawn one, and the full one while the drawn one is clipped). */
  private disposeEdgeGeometries(obj: SceneObject): void {
    const lines = obj.mesh.userData.edges as THREE.LineSegments | undefined;
    lines?.geometry.dispose();
    (lines?.userData.full as THREE.BufferGeometry | undefined)?.dispose();
  }

  /** World-space pieces of edges that run inside another object, taken out of the solid lines (see clipEdgeLines). */
  private innerChords: Float32Array | null = null;

  /**
   * Draw each object's solid edge lines without the stretches that run inside
   * another object (`chords`, world space, 6 numbers per segment): there the
   * dashed internal lines are drawn instead, and a solid line under them would
   * hide their gaps. The full geometry stays in `lines.userData.full` (the one
   * measuring snaps read) and comes back with null.
   */
  clipEdgeLines(chords: Float32Array | null): void {
    this.innerChords = chords && chords.length ? chords : null;
    // One time budget for all objects: past it the rest keep their whole solid lines (dashes drawn over them).
    const deadline = performance.now() + CLIP_BUDGET_MS;
    for (const o of this.objects) this.clipEdgeLinesOf(o, deadline);
  }

  private clipEdgeLinesOf(obj: SceneObject, deadline = performance.now() + CLIP_BUDGET_MS): void {
    const lines = obj.mesh.userData.edges as THREE.LineSegments | undefined;
    if (!lines) return;
    const full = (lines.userData.full as THREE.BufferGeometry | undefined) ?? lines.geometry;
    let clipped: Float32Array | null = null;
    const chords = this.innerChords;
    if (chords) {
      obj.mesh.updateMatrixWorld();
      const back = obj.mesh.matrixWorld.clone().invert();
      const box = full.boundingBox ?? (full.computeBoundingBox(), full.boundingBox!);
      const near = box.clone().expandByScalar(EDGE_CLIP_TOLERANCE);
      // Only the chords inside this object's box can lie on its edges, in its own coordinates.
      const local: number[] = [];
      const p = new THREE.Vector3(), q = new THREE.Vector3();
      for (let i = 0; i < chords.length; i += 6) {
        p.set(chords[i], chords[i + 1], chords[i + 2]).applyMatrix4(back);
        q.set(chords[i + 3], chords[i + 4], chords[i + 5]).applyMatrix4(back);
        if (near.containsPoint(p) && near.containsPoint(q)) local.push(p.x, p.y, p.z, q.x, q.y, q.z);
      }
      if (local.length) clipped = subtractChords(full.getAttribute('position').array, local, EDGE_CLIP_TOLERANCE, deadline);
    }
    if (clipped) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(clipped, 3));
      if (lines.userData.full) lines.geometry.dispose();
      lines.userData.full = full;
      lines.geometry = g;
    } else if (lines.userData.full) {
      lines.geometry.dispose();
      lines.geometry = full;
      delete lines.userData.full;
    }
  }

  /**
   * Work out a big mesh's edge lines in the worker and attach them when they
   * arrive, unless things changed meanwhile: the object is gone, its shape was
   * replaced, Edges was switched off (or off and on again, which asks again),
   * or lines are there already. `edgesPending` holds a token for the request
   * that is still wanted; anything else is stale.
   */
  private requestEdgeLines(obj: SceneObject): void {
    if (obj.mesh.userData.edgesPending) return;
    const token = {};
    const data = obj.data;
    obj.mesh.userData.edgesPending = token;
    runOp('edgeLines', { mesh: { ...data, id: meshId(data) }, angle: EDGE_ANGLE }, true).then(
      (positions) => {
        if (obj.mesh.userData.edgesPending !== token) return;
        delete obj.mesh.userData.edgesPending;
        if (obj.data !== data || !this.objects.includes(obj) || !this.view.edges || obj.mesh.userData.edges) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        this.attachEdgeLines(obj, geometry);
        this.applyView(obj); // the faded state, if any
      },
      () => {
        // Stopped or failed: forget the request so the next view change asks again.
        if (obj.mesh.userData.edgesPending === token) delete obj.mesh.userData.edgesPending;
      },
    );
  }

  /**
   * Draw these objects very faintly (plain grey, no edge or overhang lines) so
   * a tool's own objects stand out; null puts everything back. Survives view
   * changes made meanwhile, and an object's own colour is never lost.
   */
  setFaded(objs: SceneObject[] | null): void {
    const before = [...this.faded];
    this.faded.clear();
    for (const o of objs ?? []) this.faded.add(o);
    for (const o of before) {
      if (this.faded.has(o)) continue;
      o.mesh.material.color.set(o.color);
      this.applyView(o);
    }
    for (const o of this.faded) this.applyView(o);
  }

  rename(obj: SceneObject, name: string): void {
    obj.name = name;
    this.emit('change');
  }

  // --- Undo / redo --------------------------------------------------------

  private snapshot(): Snapshot {
    return {
      objects: this.objects.map((o) => this.capture(o)),
      selection: this.selection.map((o) => o.id),
      measurements: [...this.measurements],
      extras: Object.fromEntries([...this.extras].map(([k, e]) => [k, e.capture()])),
    };
  }

  /** Let undo and redo also restore a feature's own state. */
  registerUndoExtra(key: string, extra: UndoExtra): void {
    this.extras.set(key, extra);
  }

  /** Call before every change the user should be able to undo. */
  checkpoint(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.enforceBudget();
    this.emit('history');
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.batch(() => {
      this.redoStack.push(this.snapshot());
      this.restore(snap);
      this.enforceBudget();
    });
  }

  redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.batch(() => {
      this.undoStack.push(this.snapshot());
      this.restore(snap);
      this.enforceBudget();
    });
  }

  /** Bytes of mesh data that only the undo and redo history keeps alive (each mesh counted once). */
  historyBytes(): number {
    const seen = new Set<MeshData>(this.objects.map((o) => o.data));
    let bytes = 0;
    for (const stack of [this.undoStack, this.redoStack]) {
      for (const snap of stack) {
        for (const o of snap.objects) {
          if (seen.has(o.data)) continue;
          seen.add(o.data);
          bytes += o.data.positions.byteLength + o.data.indices.byteLength;
        }
      }
    }
    return bytes;
  }

  /** Drop the oldest history while it holds more mesh data than the budget (keeping the newest few undo steps). */
  private enforceBudget(): void {
    let dropped = false;
    while (this.undoStack.length > MIN_UNDO && this.historyBytes() > undoBudgetBytes) {
      this.undoStack.shift();
      dropped = true;
    }
    // Redo pops from the end, so the start of the list is the farthest from the present.
    while (this.redoStack.length > 0 && this.historyBytes() > undoBudgetBytes) {
      this.redoStack.shift();
      dropped = true;
    }
    if (dropped) this.emit('history');
  }

  private restore(snap: Snapshot): void {
    this.batch(() => {
      this.remove([...this.objects]);
      for (const state of snap.objects) this.create(state);
      this.measurements = snap.measurements;
      for (const [k, e] of this.extras) if (k in snap.extras) e.restore(snap.extras[k]);
      this.setSelection(this.objects.filter((o) => snap.selection.includes(o.id)));
      this.emit('history');
    });
  }

  /** Replace the measurement list (callers checkpoint first if it should be undoable). */
  setMeasurements(list: readonly Measurement[]): void {
    this.measurements = list;
    this.emit('change');
  }

  /** Everything needed to rebuild the scene (for autosave). */
  exportState(): SceneState {
    return { objects: this.objects.map((o) => this.capture(o)), measurements: [...this.measurements] };
  }

  /** Replace the scene with a saved state; the undo history starts fresh. */
  loadState(state: SceneState): void {
    this.batch(() => {
      this.clear();
      for (const s of state.objects) this.create(s);
      this.measurements = state.measurements;
      // Continue each base name's numbering after the restored objects.
      for (const o of this.objects) {
        const m = /^(.*) (\d+)$/.exec(o.name);
        if (m) this.nameCounters.set(m[1], Math.max(this.nameCounters.get(m[1]) ?? 0, Number(m[2])));
      }
      this.colorIndex = this.objects.length;
      this.setSelection([]);
      this.emit('change');
    });
  }

  /** Remove everything and forget the history. */
  clear(): void {
    this.batch(() => {
      this.remove([...this.objects]);
      this.measurements = [];
      this.undoStack = [];
      this.redoStack = [];
      this.nameCounters.clear();
      this.colorIndex = 0;
      this.emit('history');
    });
  }

  /**
   * Run `fn` and tell listeners once at the end, not once per change inside it.
   * Each event type that was emitted meanwhile fires a single time, when the
   * outermost batch ends (also when `fn` throws).
   */
  batch<T>(fn: () => T): T {
    this.batchDepth++;
    try {
      return fn();
    } finally {
      if (--this.batchDepth === 0) {
        const pending = this.pendingEvents;
        this.pendingEvents = new Set();
        for (const type of EVENT_ORDER) if (pending.has(type)) this.dispatchEvent(new Event(type));
      }
    }
  }

  /** One undo step: take a checkpoint, then run `fn` as a batch. The checkpoint stays if `fn` throws. */
  transact<T>(fn: () => T): T {
    return this.batch(() => {
      this.checkpoint();
      return fn();
    });
  }

  emit(type: DocEvent): void {
    if (this.batchDepth > 0) this.pendingEvents.add(type);
    else this.dispatchEvent(new Event(type));
  }
}

export function buildGeometry(data: MeshData): THREE.BufferGeometry {
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  indexed.setIndex(new THREE.BufferAttribute(data.indices, 1));
  const geometry = toCreasedNormals(indexed, CREASE_ANGLE);
  indexed.dispose();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
