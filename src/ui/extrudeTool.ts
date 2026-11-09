import * as THREE from 'three';
import type { Piece } from '../geometry/cut';
import { bakeMesh } from '../geometry/meshData';
import { runOp } from '../geometry/workerClient';
import type { SceneDocument, SceneObject } from '../scene/document';
import type { Viewport } from '../scene/viewport';
import { previewMesh, type FeatureBar } from './featureBar';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PLANE_COLOR = 0xf2a33a;

/**
 * Extrude down: a level plane through the selected object. Above the plane
 * the object stays as it is; below it, it becomes the shape cut by the plane,
 * pushed straight down to the plate. The plane moves with its arrow or the
 * height field; the result shows in orange before Apply.
 */
export class ExtrudeTool {
  private readonly plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly handleSvg: SVGSVGElement;
  private readonly handle: SVGPolygonElement;
  private target: SceneObject | null = null;
  private height = 0;
  private range: [number, number] = [0, 0];
  private pxPerMm = 1;
  private dir = new THREE.Vector2(0, -1);

  constructor(
    private readonly viewport: Viewport,
    private readonly doc: SceneDocument,
    private readonly bar: FeatureBar,
    private readonly toast: (msg: string) => void,
  ) {
    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: PLANE_COLOR, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.plane.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
      new THREE.LineBasicMaterial({ color: PLANE_COLOR }),
    ));
    this.plane.raycast = () => {};
    this.plane.visible = false;
    viewport.scene.add(this.plane);

    // Up/down arrow in the middle of the plane, like Split's.
    this.handleSvg = document.createElementNS(SVG_NS, 'svg');
    this.handleSvg.classList.add('gizmo');
    this.handleSvg.style.display = 'none';
    this.handle = document.createElementNS(SVG_NS, 'polygon');
    this.handle.setAttribute('points', '-20,0 -11,-7 -11,-2 11,-2 11,-7 20,0 11,7 11,2 -11,2 -11,7');
    this.handle.setAttribute('fill', '#f2a33a');
    this.handle.classList.add('handle');
    this.handleSvg.append(this.handle);
    viewport.element.append(this.handleSvg);
    this.handle.addEventListener('pointerdown', (e) => this.startDrag(e));
    viewport.onFrame(() => this.updateHandle());

    for (const b of document.querySelectorAll('[data-action="extrude-down"]')) b.addEventListener('click', () => this.start());
  }

  /**
   * One object, a group or several: the plane goes across all of them. Every
   * object it crosses is extended down; objects it misses stay as they are.
   */
  private start(): void {
    const objs = [...this.doc.selection];
    if (objs.length === 0) return this.toast('Select the objects to extrude down');
    const box = this.doc.worldBox(objs);
    const lo = box.min.z, hi = box.max.z;
    if (hi <= 0) return this.toast('The objects are below the plate; move them up first');
    // Start just above the lowest point (inside the object), so for a bolt
    // standing on its head Apply simply extends the head down to the plate.
    const bottom = Math.max(lo, 0);
    const start = Math.min(hi - 0.05, bottom + Math.min(1, (hi - bottom) * 0.1));
    this.range = [Math.max(bottom, 0.05), hi];
    this.target = objs[0];
    this.setHeight(start);
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, 10) * 1.5;
    this.plane.scale.set(span, span, 1);
    this.plane.position.x = (box.min.x + box.max.x) / 2;
    this.plane.position.y = (box.min.y + box.max.y) / 2;
    this.plane.visible = true;

    this.bar.open<(Piece | null)[]>({
      title: 'Extrude down',
      hint: 'Extrude down: drag the orange arrow or type a height. Below the plane, each object becomes its shape at the plane, extended straight down to the plate. Apply when the orange result looks right.',
      fields: [
        {
          key: 'height', label: 'Plane height', type: 'number', value: round(start), min: 0, step: 0.5, unit: 'mm',
          tip: 'Height of the plane above the plate. What is above it stays; below it the shape at the plane goes straight down.',
        },
      ],
      hide: objs,
      compute: async (v) => {
        this.setHeight(Number(v.height));
        // A height outside the objects is pulled back in; show where the plane really is.
        if (round(this.height) !== Number(v.height)) this.bar.setValue('height', round(this.height), null);
        // An object the plane misses stays as it is (null).
        const pieces = await Promise.all(objs.map((o) =>
          runOp('extrudeDown', { item: this.doc.placed(o), height: this.height }).catch(() => null)));
        if (pieces.every((p) => p === null)) throw new Error('Move the plane so it cuts through the objects');
        return pieces;
      },
      // The new shapes, and the objects the plane misses as they are.
      show: (pieces) => pieces.map((p, i) => p ? previewMesh(p.mesh, p.center) : previewMesh(bakeMesh(this.doc.placed(objs[i])), [0, 0, 0])),
      apply: (pieces) => {
        if (!objs.every((o) => this.doc.objects.includes(o))) return;
        this.doc.checkpoint();
        pieces.forEach((p, i) => {
          if (!p) return;
          const obj = objs[i];
          this.doc.setData(obj, p.mesh);
          obj.mesh.position.set(...p.center);
          obj.mesh.quaternion.identity();
          obj.mesh.scale.set(1, 1, 1);
        });
        this.doc.emit('transform');
      },
      onClose: () => this.stop(),
    });
  }
  private stop(): void {
    this.target = null;
    this.plane.visible = false;
    this.handleSvg.style.display = 'none';
    this.viewport.invalidate();
  }

  /** Move the plane, kept within the object's height. */
  private setHeight(h: number): void {
    if (!Number.isFinite(h)) return;
    this.height = THREE.MathUtils.clamp(h, this.range[0], this.range[1]);
    this.plane.position.z = this.height;
    this.viewport.invalidate();
  }

  private updateHandle(): void {
    if (!this.target) return;
    this.handleSvg.style.display = '';
    const p = this.plane.position;
    const s0 = this.viewport.project(p);
    const ref = 10;
    const d = this.viewport.project(p.clone().add(new THREE.Vector3(0, 0, ref))).sub(s0);
    const len = d.length();
    this.dir = len > 1e-6 ? d.divideScalar(len) : new THREE.Vector2(0, -1);
    this.pxPerMm = Math.max(len / ref, 1e-3);
    const deg = THREE.MathUtils.radToDeg(Math.atan2(this.dir.y, this.dir.x));
    this.handle.setAttribute('transform', `translate(${s0.x.toFixed(1)},${s0.y.toFixed(1)}) rotate(${deg.toFixed(1)})`);
  }

  private startDrag(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const r = this.viewport.element.getBoundingClientRect();
    const start = new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
    const startHeight = this.height;
    const dir = this.dir.clone();
    const px = this.pxPerMm;
    this.handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const p = new THREE.Vector2(ev.clientX - r.left, ev.clientY - r.top);
      this.setHeight(startHeight + p.sub(start).dot(dir) / px);
      this.bar.setValue('height', round(this.height));
    };
    const up = () => {
      this.handle.removeEventListener('pointermove', move);
      this.handle.removeEventListener('pointerup', up);
    };
    this.handle.addEventListener('pointermove', move);
    this.handle.addEventListener('pointerup', up);
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
