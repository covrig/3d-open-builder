import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MeshData } from '../geometry/meshData';
import type { ColoredPlacedMesh } from '../io/threemf';

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
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xe6edf5 });

export function setEdgeColor(hex: number): void {
  edgeMaterial.color.setHex(hex);
}

type DocEvent = 'change' | 'selection' | 'transform' | 'history';

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
    return states.map((s) => {
      let groupId: number | undefined;
      if (s.groupId !== undefined) {
        if (!groupMap.has(s.groupId)) groupMap.set(s.groupId, this.nextGroupId++);
        groupId = groupMap.get(s.groupId);
      }
      return this.addCopy({ ...s, groupId });
    });
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

  private uniqueName(base: string): string {
    const n = (this.nameCounters.get(base) ?? 0) + 1;
    this.nameCounters.set(base, n);
    return `${base} ${n}`;
  }

  private create(state: ObjectState): SceneObject {
    const material = new THREE.MeshStandardMaterial({
      color: state.color,
      roughness: 0.55,
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
    const mesh = new THREE.Mesh(buildGeometry(state.data), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
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
    for (const obj of objs) {
      const i = this.objects.indexOf(obj);
      if (i < 0) continue;
      this.objects.splice(i, 1);
      this.root.remove(obj.mesh);
      (obj.mesh.userData.edges as THREE.LineSegments | undefined)?.geometry.dispose();
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
    obj.mesh.geometry.dispose();
    obj.mesh.geometry = buildGeometry(data);
    // Rebuild edge lines for the new shape.
    const edges = obj.mesh.userData.edges as THREE.LineSegments | undefined;
    if (edges) {
      obj.mesh.remove(edges);
      edges.geometry.dispose();
      delete obj.mesh.userData.edges;
      this.applyView(obj);
    }
    this.emit('change');
  }

  setColor(objs: SceneObject[], color: string): void {
    for (const obj of objs) {
      obj.color = color;
      obj.mesh.material.color.set(color);
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
      position: m.position.toArray() as [number, number, number],
      quaternion: m.quaternion.toArray() as [number, number, number, number],
      scale: m.scale.toArray() as [number, number, number],
    };
  }

  // --- Selection ----------------------------------------------------------

  setSelection(objs: SceneObject[]): void {
    this.selection = [...objs];
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
    return { mesh: obj.data, matrix: obj.mesh.matrixWorld.elements, name: obj.name, color: obj.color };
  }

  // --- View modes ---------------------------------------------------------

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
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(obj.mesh.geometry, EDGE_ANGLE), edgeMaterial);
      lines.raycast = () => {}; // never picked
      obj.mesh.add(lines);
      obj.mesh.userData.edges = lines;
    } else if (!this.view.edges && existing) {
      obj.mesh.remove(existing);
      existing.geometry.dispose();
      delete obj.mesh.userData.edges;
    }
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
    this.redoStack.push(this.snapshot());
    this.restore(snap);
  }

  redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(this.snapshot());
    this.restore(snap);
  }

  private restore(snap: Snapshot): void {
    this.remove([...this.objects]);
    for (const state of snap.objects) this.create(state);
    this.measurements = snap.measurements;
    for (const [k, e] of this.extras) if (k in snap.extras) e.restore(snap.extras[k]);
    this.setSelection(this.objects.filter((o) => snap.selection.includes(o.id)));
    this.emit('history');
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
  }

  /** Remove everything and forget the history. */
  clear(): void {
    this.remove([...this.objects]);
    this.measurements = [];
    this.undoStack = [];
    this.redoStack = [];
    this.nameCounters.clear();
    this.colorIndex = 0;
    this.emit('history');
  }

  emit(type: DocEvent): void {
    this.dispatchEvent(new Event(type));
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
