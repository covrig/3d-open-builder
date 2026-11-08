import * as THREE from 'three';
import type { MeasureKind, MeasurePoint, SceneDocument } from '../scene/document';
import type { Viewport } from '../scene/viewport';
import { settings, toUnit, updateUi } from '../settings';
import { hideHint, showHint } from './hint';
import { beginTool, endTool } from './toolLock';

const POINTS_NEEDED: Record<MeasureKind, number> = { distance: 2, angle: 3, circle: 3 };
const HINTS: Record<MeasureKind, string> = {
  distance: 'Distance: click two points. Click Distance again or press Esc to stop.',
  angle: 'Angle: click the start, the corner, then the end. Esc to stop.',
  circle: 'Circle: click three points on the edge of a circle or hole. Esc to stop.',
};
/** Colours of the 1st, 2nd and 3rd point, as in PrintView3D. */
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

/** Sharp-edge segments of a geometry (local space), computed once per geometry. */
const edgeCache = new WeakMap<THREE.BufferGeometry, Float32Array>();
function featureEdges(geometry: THREE.BufferGeometry): Float32Array {
  let edges = edgeCache.get(geometry);
  if (!edges) {
    const g = new THREE.EdgesGeometry(geometry, EDGE_ANGLE);
    edges = g.getAttribute('position').array as Float32Array;
    g.dispose();
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
    if (kind) beginTool('measure', () => this.setKind(null));
    else endTool('measure');
    this.kind = kind;
    this.pending = [];
    this.hover = null;
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
    const p = this.pickPoint(clientX, clientY);
    if (!p) return;
    this.pending.push(p);
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
    this.hover = this.pickPoint(clientX, clientY);
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

  /** Point under the cursor: on an object (snapped to a corner or edge when close), else on the plate. */
  private pickPoint(clientX: number, clientY: number): MeasurePoint | null {
    const raycaster = this.viewport.rayAt(clientX, clientY);
    const hit = raycaster.intersectObjects(this.viewport.objectRoot.children, false)[0];
    if (!hit) {
      const onPlate = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
      return onPlate ? { local: onPlate } : null;
    }
    const mesh = hit.object as THREE.Mesh;
    const obj = this.doc.byMesh(mesh);
    const toLocal = (w: THREE.Vector3) => mesh.worldToLocal(w.clone());
    const result = (w: THREE.Vector3): MeasurePoint => ({ objectId: obj?.id, local: toLocal(w) });
    if (!this.options.snap || !hit.face) return result(hit.point);

    const r = this.viewport.element.getBoundingClientRect();
    const cursor = new THREE.Vector2(clientX - r.left, clientY - r.top);
    const screenDist = (localPoint: THREE.Vector3) =>
      this.viewport.project(localPoint.clone().applyMatrix4(mesh.matrixWorld)).distanceTo(cursor);

    // 1. Corners of the triangle under the cursor.
    const pos = mesh.geometry.getAttribute('position');
    let best: THREE.Vector3 | null = null;
    let bestPx = SNAP_PX;
    for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i);
      const px = screenDist(v);
      if (px < bestPx) {
        bestPx = px;
        best = v;
      }
    }
    if (best) return { objectId: obj?.id, local: best };

    // 2. The nearest sharp edge (cube edges, hole rims...), never a flat face's diagonal.
    const edges = featureEdges(mesh.geometry);
    const localRay = raycaster.ray.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
    const localHit = toLocal(hit.point);
    const near = (mesh.geometry.boundingSphere?.radius ?? 20) * 0.2;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), onSeg = new THREE.Vector3();
    const seg = new THREE.Line3();
    for (let i = 0; i < edges.length; i += 6) {
      a.set(edges[i], edges[i + 1], edges[i + 2]);
      b.set(edges[i + 3], edges[i + 4], edges[i + 5]);
      seg.set(a, b);
      // Cheap filter: only edges near the hit point.
      if (seg.closestPointToPoint(localHit, true, onSeg).distanceTo(localHit) > near) continue;
      localRay.distanceSqToSegment(a, b, undefined, onSeg);
      const px = screenDist(onSeg);
      if (px < bestPx) {
        bestPx = px;
        best = onSeg.clone();
      }
    }
    return best ? { objectId: obj?.id, local: best } : result(hit.point);
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
          label(c.center, `Ø ${num(c.radius * 2)} ${unit}  ·  R ${num(c.radius)} ${unit}`);
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
          svg.push(`<circle class="hover" cx="${p.x}" cy="${p.y}" r="8"/>`);
        }
      }
    }
    this.svg.innerHTML = svg.join('');
    this.labels.innerHTML = html.join('');
  }
}
