import * as THREE from 'three';
import type { MeasureKind, MeasurePoint, SceneDocument, SceneObject } from '../scene/document';
import type { SectionCut } from './crossSection';
import type { Viewport } from '../scene/viewport';
import { settings, toUnit, updateUi } from '../settings';
import { hideHint, showHint } from './hint';
import { beginTool, endTool } from './toolLock';
import { edgeFeatures } from '../geometry/edgeMiddles';

const POINTS_NEEDED: Record<MeasureKind, number> = { distance: 2, angle: 3, circle: 3 };
const HINTS: Record<MeasureKind, string> = {
  distance: 'Distance: click two points. Click Distance again or press Esc to stop.',
  angle: 'Angle: click the start, the corner, then the end. Esc to stop.',
  circle: 'Circle: click three points on the edge of a circle or hole. Esc to stop.',
};
/** Colours of the 1st, 2nd and 3rd point. */
const POINT_COLORS = ['#4cb8ff', '#7ed321', '#c77dff'];
const SNAP_PX = 14;
const EDGE_ANGLE = 25;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Circle through three points in 3D, or null if they are (nearly) in a line. */
export function circleThrough(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
  const ab = b.clone().sub(a);
  const ac = c.clone().sub(a);
  const n = ab.clone().cross(ac);
  const n2 = n.lengthSq();
  if (n2 < 1e-12) return null;
  const center = a.clone().add(
    n.clone().cross(ab).multiplyScalar(ac.lengthSq())
      .add(ac.clone().cross(n).multiplyScalar(ab.lengthSq()))
      .divideScalar(2 * n2),
  );
  return { center, radius: center.distanceTo(a), normal: n.normalize() };
}

/** What a measuring point snapped to (shown while hovering, so a point isn't misplaced). */
export type SnapKind = 'corner' | 'middle' | 'edge';
const SNAP_NAMES: Record<SnapKind, string> = { corner: 'Corner', middle: 'Middle of edge', edge: 'On edge' };

interface FeatureEdges {
  /** Sharp-edge segments, 6 numbers (two points) each, local space */
  segs: Float32Array;
  /** Real corners and the middles of straight edges, 3 numbers each (see edgeFeatures) */
  corners: Float32Array;
  mids: Float32Array;
}

/** Sharp edges of a geometry, its real corners and the middles of its straight edges, computed once per geometry. */
const edgeCache = new WeakMap<THREE.BufferGeometry, FeatureEdges>();
function featureEdges(geometry: THREE.BufferGeometry): FeatureEdges {
  let edges = edgeCache.get(geometry);
  if (!edges) {
    const g = new THREE.EdgesGeometry(geometry, EDGE_ANGLE);
    const segs = g.getAttribute('position').array as Float32Array;
    g.dispose();
    edges = { segs, ...edgeFeatures(segs) };
    edgeCache.set(geometry, edges);
  }
  return edges;
}

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Measuring on the model: distances, angles and circle diameters. Points are
 * picked on objects (or the plate) and drawn over the view. While a tool is
 * active, clicks in the view place points instead of selecting.
 */
export class MeasureTool {
  private kind: MeasureKind | null = null;
  private pending: MeasurePoint[] = [];
  private hover: MeasurePoint | null = null;
  /** What the point under the cursor snapped to (null: not snapped) */
  private hoverSnap: SnapKind | null = null;
  /** Remembered between visits (saved with the other UI choices). */
  private readonly options = settings.ui.measure;
  private readonly svg: SVGSVGElement;
  private readonly labels: HTMLElement;

  constructor(
    private readonly viewport: Viewport,
    private readonly doc: SceneDocument,
    private readonly toast: (msg: string) => void,
  ) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('measure');
    this.svg.classList.toggle('dotted', this.options.dotted);
    this.labels = document.createElement('div');
    this.labels.className = 'measure-labels';
    viewport.element.append(this.svg, this.labels);
    viewport.onFrame(() => this.draw());

    const panel = document.querySelector<HTMLElement>('#measure-panel')!;
    for (const b of panel.querySelectorAll<HTMLButtonElement>('[data-measure]')) {
      b.addEventListener('click', () => {
        const kind = b.dataset.measure as MeasureKind;
        this.setKind(this.kind === kind ? null : kind);
      });
    }
    for (const b of panel.querySelectorAll<HTMLButtonElement>('[data-measure-option]')) {
      const key = b.dataset.measureOption as keyof typeof this.options;
      b.classList.toggle('active', this.options[key]);
      b.addEventListener('click', () => {
        updateUi(() => (this.options[key] = !this.options[key]));
        b.classList.toggle('active', this.options[key]);
        this.svg.classList.toggle('dotted', this.options.dotted);
        this.viewport.invalidate();
      });
    }
    panel.querySelector('[data-action="measure-clear"]')!.addEventListener('click', () => this.clear());
  }

  get active(): boolean {
    return this.kind !== null;
  }

  setKind(kind: MeasureKind | null): void {
    // Light tool: measuring locks nothing else (it even works with the cross-section on).
    if (kind) beginTool('measure', () => this.setKind(null), false);
    else endTool('measure');
    this.kind = kind;
    this.pending = [];
    this.hover = null;
    this.hoverSnap = null;
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-measure]')) {
      b.classList.toggle('active', b.dataset.measure === kind);
    }
    this.viewport.element.classList.toggle('measuring', kind !== null);
    if (kind) showHint('measure', HINTS[kind]);
    else hideHint('measure');
    this.viewport.invalidate();
  }

  /** Remove all measurements (undoable). */
  clear(): void {
    this.pending = [];
    if (this.doc.measurements.length === 0) return this.viewport.invalidate();
    this.doc.checkpoint();
    this.doc.setMeasurements([]);
  }

  /** A click in the view while measuring. */
  click(clientX: number, clientY: number): void {
    if (!this.kind) return;
    const picked = this.pickPoint(clientX, clientY);
    if (!picked) return;
    const p = picked.point;
    this.pending.push(p);
    // Placed: the point goes back to its normal look until the mouse moves again.
    this.hover = null;
    this.hoverSnap = null;
    if (this.pending.length === POINTS_NEEDED[this.kind]) {
      const w = this.pending.map((q) => this.world(q)!);
      if (this.kind === 'circle' && !circleThrough(w[0], w[1], w[2])) {
        this.toast('Those three points are in a line; pick points around the circle');
      } else {
        this.doc.checkpoint();
        this.doc.setMeasurements([...this.doc.measurements, { kind: this.kind, points: this.pending }]);
      }
      this.pending = [];
    }
    this.viewport.invalidate();
  }

  move(clientX: number, clientY: number): void {
    if (!this.kind) return;
    const picked = this.pickPoint(clientX, clientY);
    this.hover = picked?.point ?? null;
    this.hoverSnap = picked?.snap ?? null;
    this.viewport.invalidate();
  }

  /** World position of a point, or null if its object no longer exists. */
  private world(p: MeasurePoint): THREE.Vector3 | null {
    if (p.objectId === undefined) return p.local.clone();
    const obj = this.doc.objects.find((o) => o.id === p.objectId);
    if (!obj) return null;
    obj.mesh.updateMatrixWorld();
    return obj.mesh.localToWorld(p.local.clone());
  }

  /** The cross-section, when on: measuring then works on what is still shown and on the cut. */
  section: { active: boolean; plane: THREE.Plane; cutOf(obj: SceneObject): SectionCut | null } | null = null;

  /**
   * Point under the cursor: on an object (snapped, when close, to a corner,
   * the middle of a straight edge or an edge, in that order), else on the
   * plate. Also says what it snapped to. With the cross-section on, cut-away
   * parts are ignored, the filled cut face can be measured on, and its outline
   * counts as edges.
   */
  private pickPoint(clientX: number, clientY: number): { point: MeasurePoint; snap: SnapKind | null } | null {
    const raycaster = this.viewport.rayAt(clientX, clientY);
    const section = this.section?.active ? this.section : null;
    const shown = (world: THREE.Vector3) => !section || section.plane.distanceToPoint(world) >= -1e-4;
    const hit = section ? this.viewport.hitsOn(raycaster)[0] : raycaster.intersectObjects(this.viewport.objectRoot.children, false)[0];
    if (!hit) {
      const onPlate = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
      return onPlate ? { point: { local: onPlate }, snap: null } : null;
    }
    const mesh = hit.object as THREE.Mesh;
    const obj = this.doc.byMesh(mesh);
    // Looking into the cut: the first surface still shown faces away, so what
    // is seen is the filled cut face, where the ray meets the plane.
    let worldHit = hit.point;
    if (section && hit.face && hit.face.normal.clone().transformDirection(mesh.matrixWorld).dot(raycaster.ray.direction) > 0) {
      const onPlane = raycaster.ray.intersectPlane(section.plane, new THREE.Vector3());
      if (onPlane) worldHit = onPlane;
    }
    const toLocal = (w: THREE.Vector3) => mesh.worldToLocal(w.clone());
    const snapped = (local: THREE.Vector3, snap: SnapKind | null) => ({ point: { objectId: obj?.id, local }, snap });
    if (!this.options.snap || !hit.face) return snapped(toLocal(worldHit), null);

    const r = this.viewport.element.getBoundingClientRect();
    const cursor = new THREE.Vector2(clientX - r.left, clientY - r.top);
    const toWorld = (localPoint: THREE.Vector3) => localPoint.clone().applyMatrix4(mesh.matrixWorld);
    const screenDist = (localPoint: THREE.Vector3) => this.viewport.project(toWorld(localPoint)).distanceTo(cursor);
    const localHit = toLocal(worldHit);
    // Cheap filter for edges and middles: only those near the hit point.
    const near = (mesh.geometry.boundingSphere?.radius ?? 20) * 0.2;

    // Snap targets: the object's sharp edges, plus the outline of the cut (in the object's own coordinates).
    const own = featureEdges(mesh.geometry);
    const cut = section && obj ? section.cutOf(obj) : null;
    const inverse = mesh.matrixWorld.clone().invert();
    const toLocalList = (list: Float32Array) => {
      const out = new Float32Array(list.length);
      const v = new THREE.Vector3();
      for (let i = 0; i < list.length; i += 3) {
        v.set(list[i], list[i + 1], list[i + 2]).applyMatrix4(inverse);
        out.set([v.x, v.y, v.z], i);
      }
      return out;
    };
    const cutLocal = cut ? { corners: toLocalList(cut.corners), mids: toLocalList(cut.mids), segs: toLocalList(cut.segs) } : null;

    // 1. Real corners, then 2. middles of straight edges. (Not the points of the
    // triangles: on a sphere or a cylinder's rim those are only where the
    // smooth surface was divided up.)
    let best: THREE.Vector3 | null = null;
    let bestPx = SNAP_PX;
    /**
     * The one corner (or middle) within snapping distance of the cursor. Where
     * several crowd together, as along a thread whose crests zigzag across the
     * triangles, none of them is a real corner: no snap of this kind (zooming
     * in spreads a small part's real corners apart again).
     */
    const single = (...lists: (Float32Array | undefined)[]): THREE.Vector3 | null => {
      const found: { at: THREE.Vector3; px: number; screen: THREE.Vector2 }[] = [];
      const v = new THREE.Vector3();
      for (const list of lists) {
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          v.set(list[i], list[i + 1], list[i + 2]);
          if (v.distanceTo(localHit) > near || !shown(toWorld(v))) continue;
          const screen = this.viewport.project(toWorld(v));
          const px = screen.distanceTo(cursor);
          if (px >= SNAP_PX) continue;
          // The same point listed twice (an own corner the cut passes through) counts once.
          if (found.some((f) => f.screen.distanceTo(screen) < 2)) continue;
          found.push({ at: v.clone(), px, screen });
        }
      }
      return found.length === 1 ? found[0].at : null;
    };
    const corner = single(own.corners, cutLocal?.corners);
    if (corner) return snapped(corner, 'corner');
    const middle = single(own.mids, cutLocal?.mids);
    if (middle) return snapped(middle, 'middle');

    // 3. The nearest sharp edge (cube edges, hole rims, the cut's outline...), never a flat face's diagonal.
    const localRay = raycaster.ray.clone().applyMatrix4(inverse);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), onSeg = new THREE.Vector3();
    const seg = new THREE.Line3();
    for (const segs of [own.segs, cutLocal?.segs]) {
      if (!segs) continue;
      for (let i = 0; i < segs.length; i += 6) {
        a.set(segs[i], segs[i + 1], segs[i + 2]);
        b.set(segs[i + 3], segs[i + 4], segs[i + 5]);
        seg.set(a, b);
        if (seg.closestPointToPoint(localHit, true, onSeg).distanceTo(localHit) > near) continue;
        localRay.distanceSqToSegment(a, b, undefined, onSeg);
        if (!shown(toWorld(onSeg))) continue;
        const px = screenDist(onSeg);
        if (px < bestPx) {
          bestPx = px;
          best = onSeg.clone();
        }
      }
    }
    return best ? snapped(best, 'edge') : snapped(localHit, null);
  }
  // --- Drawing ------------------------------------------------------------

  private draw(): void {
    // Forget measurements whose object was deleted.
    const svg: string[] = [];
    const html: string[] = [];
    const P = (v: THREE.Vector3) => this.viewport.project(v);
    const num = (mm: number, signed = false) => {
      const v = Math.round(toUnit(mm) * 100) / 100;
      const s = v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return signed && v > 0 ? `+${s}` : s.replace('-', '−');
    };
    const unit = settings.unit;
    const line = (a: THREE.Vector3, b: THREE.Vector3) => {
      const pa = P(a), pb = P(b);
      svg.push(`<line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}"/>`);
    };
    const dot = (v: THREE.Vector3, i: number) => {
      const p = P(v);
      svg.push(`<circle class="point" cx="${p.x}" cy="${p.y}" r="4.5" stroke="${POINT_COLORS[i % 3]}"/>`);
    };
    const label = (at: THREE.Vector3, main: string, sub?: string) => {
      const p = P(at);
      html.push(
        `<div class="m-label" style="left:${p.x}px;top:${p.y}px"><div class="m-main">${escapeHtml(main)}</div>${
          sub ? `<div class="m-sub">${escapeHtml(sub)}</div>` : ''
        }</div>`,
      );
    };

    const render = (kind: MeasureKind, pts: THREE.Vector3[]) => {
      if (kind === 'distance' && pts.length === 2) {
        line(pts[0], pts[1]);
        const d = pts[1].clone().sub(pts[0]);
        label(
          pts[0].clone().lerp(pts[1], 0.5),
          `${num(d.length())} ${unit}`,
          this.options.deltas ? `ΔX ${num(d.x, true)}   ΔY ${num(d.y, true)}   ΔZ ${num(d.z, true)}` : undefined,
        );
      }
      if (kind === 'angle') {
        if (pts.length >= 2) line(pts[0], pts[1]);
        if (pts.length === 3) {
          line(pts[1], pts[2]);
          const u = pts[0].clone().sub(pts[1]);
          const v = pts[2].clone().sub(pts[1]);
          if (u.lengthSq() > 0 && v.lengthSq() > 0) {
            const angle = u.angleTo(v);
            // Arc at the corner, a third of the shorter arm long.
            const r = Math.min(u.length(), v.length()) / 3;
            const axis = u.clone().cross(v).normalize();
            const arc: THREE.Vector2[] = [];
            for (let i = 0; i <= 24; i++) {
              const dir = u.clone().normalize().applyAxisAngle(axis, (angle * i) / 24);
              arc.push(P(pts[1].clone().addScaledVector(dir, r)));
            }
            svg.push(`<path d="M${arc.map((p) => `${p.x},${p.y}`).join('L')}"/>`);
            const bisector = u.clone().normalize().add(v.clone().normalize()).normalize();
            label(pts[1].clone().addScaledVector(bisector, r * 1.6), `${(Math.round(THREE.MathUtils.radToDeg(angle) * 10) / 10).toLocaleString()}°`);
          }
        }
      }
      if (kind === 'circle' && pts.length === 3) {
        const c = circleThrough(pts[0], pts[1], pts[2]);
        if (c) {
          const e1 = pts[0].clone().sub(c.center).normalize();
          const ring: THREE.Vector2[] = [];
          for (let i = 0; i <= 72; i++) {
            const dir = e1.clone().applyAxisAngle(c.normal, (Math.PI * 2 * i) / 72);
            ring.push(P(c.center.clone().addScaledVector(dir, c.radius)));
          }
          svg.push(`<path d="M${ring.map((p) => `${p.x},${p.y}`).join('L')}"/>`);
          line(pts[0], c.center);
          // The radius is exactly half the diameter shown (both rounded the same way would
          // disagree, e.g. Ø 10.01 with R 5.01): up to one more decimal.
          const d = Math.round(toUnit(c.radius * 2) * 100) / 100;
          const half = (d / 2).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 3 });
          label(c.center, `Ø ${num(c.radius * 2)} ${unit}  ·  R ${half} ${unit}`);
        }
      }
      pts.forEach(dot);
    };

    // Measurements on a deleted object are hidden (undo brings both back).
    for (const m of this.doc.measurements) {
      const pts = m.points.map((p) => this.world(p));
      if (pts.every((p) => p !== null)) render(m.kind, pts);
    }
    if (this.kind) {
      const pending = [...this.pending, ...(this.hover ? [this.hover] : [])]
        .map((p) => this.world(p))
        .filter((p) => p !== null);
      render(this.kind, pending);
      if (this.hover) {
        const h = this.world(this.hover);
        if (h) {
          const p = P(h);
          // A snapped point lights up and says what it caught, so a point that only
          // looks right from this angle isn't placed by mistake.
          if (this.hoverSnap) {
            svg.push(`<circle class="hover snapped" cx="${p.x}" cy="${p.y}" r="9"/>`);
            svg.push(`<circle class="snap-dot" cx="${p.x}" cy="${p.y}" r="4.5"/>`);
            html.push(`<div class="m-snap" style="left:${p.x}px;top:${p.y}px">${SNAP_NAMES[this.hoverSnap]}</div>`);
          } else {
            svg.push(`<circle class="hover" cx="${p.x}" cy="${p.y}" r="8"/>`);
          }
        }
      }
    }
    this.svg.innerHTML = svg.join('');
    this.labels.innerHTML = html.join('');
  }
}
