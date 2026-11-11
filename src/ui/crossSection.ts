import * as THREE from 'three';
import { edgeFeatures, type EdgeFeatures } from '../geometry/edgeMiddles';
import { cutSegments } from '../geometry/sectionCut';
import { edgeMaterial, type SceneDocument, type SceneObject } from '../scene/document';
import type { Gizmo } from '../scene/gizmo';
import type { Viewport } from '../scene/viewport';
import { fromUnit, settings, toUnit } from '../settings';
import { beginViewTool, endViewTool } from './toolLock';

type Axis = 0 | 1 | 2;
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

/** The cut through one object: its outline segments and snap targets, in world space. */
export interface SectionCut extends EdgeFeatures {
  segs: Float32Array;
}

interface Helpers {
  back: THREE.Mesh;
  front: THREE.Mesh;
  cap: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  outline: THREE.LineSegments;
}

/**
 * Cross-section view (More menu): a plane across X, Y or Z hides everything on
 * one side, so the inside shows. Only the view changes, never the objects.
 * The cut faces are filled in (stencil-buffer caps: each object's back faces
 * count up and front faces count down, and where the count isn't zero the
 * plane lies inside the solid) and outlined like the Edges view. Measuring
 * works on the cut and snaps to its corners and edges. A view tool: while it is
 * open, objects can't be edited or moved (docs/tool-rules.md); Close or Esc ends it.
 */
export class CrossSection {
  readonly plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private on = false;
  private axis: Axis = 2;
  private offset = 0;
  private flipped = false;
  private readonly group = new THREE.Group();
  private readonly helpers = new Map<SceneObject, Helpers>();
  private readonly cuts = new Map<SceneObject, SectionCut>();
  private dirty = true;
  private readonly bar = document.querySelector<HTMLElement>('#section-bar')!;
  private readonly range = this.bar.querySelector<HTMLInputElement>('#section-range')!;
  private readonly value = this.bar.querySelector<HTMLInputElement>('#section-value')!;

  constructor(
    private readonly viewport: Viewport,
    private readonly doc: SceneDocument,
    private readonly gizmo: Gizmo,
  ) {
    this.group.visible = false;
    viewport.scene.add(this.group);
    viewport.beforeFrame(() => this.update());
    for (const type of ['change', 'transform'] as const) doc.addEventListener(type, () => this.markDirty());

    // The More menu item and, when there is room, its toolbar button.
    for (const b of document.querySelectorAll('[data-action="cross-section"]')) b.addEventListener('click', () => (this.on ? this.close() : this.open()));
    for (const b of this.bar.querySelectorAll<HTMLButtonElement>('[data-section-axis]')) {
      b.addEventListener('click', () => this.setAxis(Number(b.dataset.sectionAxis) as Axis));
    }
    this.range.addEventListener('input', () => this.setOffset(fromUnit(Number(this.range.value))));
    this.value.addEventListener('change', () => this.setOffset(fromUnit(Number(this.value.value))));
    this.bar.querySelector('[data-section="flip"]')!.addEventListener('click', () => {
      this.flipped = !this.flipped;
      this.applyPlane();
    });
    this.bar.querySelector('[data-section="close"]')!.addEventListener('click', () => this.close());
  }

  get active(): boolean {
    return this.on;
  }

  open(): void {
    if (this.doc.objects.length === 0) return;
    beginViewTool('section', () => this.close());
    this.gizmo.enabled = false;
    this.on = true;
    this.bar.hidden = false;
    this.group.visible = true;
    this.doc.setClipping([this.plane]);
    this.viewport.clipFilter = (p) => this.plane.distanceToPoint(p) >= -1e-4;
    this.setAxis(this.axis);
  }

  /** Close the cross-section; false if it wasn't open. */
  close(): boolean {
    if (!this.on) return false;
    this.on = false;
    endViewTool('section');
    this.gizmo.enabled = true;
    this.bar.hidden = true;
    this.group.visible = false;
    this.doc.setClipping(null);
    this.viewport.clipFilter = null;
    for (const h of this.helpers.values()) this.disposeHelpers(h);
    this.helpers.clear();
    this.cuts.clear();
    this.viewport.invalidate();
    return true;
  }

  /** The cut through an object (world space), for measuring; null when off or not cut. */
  cutOf(obj: SceneObject): SectionCut | null {
    if (!this.on) return null;
    this.update();
    return this.cuts.get(obj) ?? null;
  }

  private markDirty(): void {
    if (!this.on) return;
    this.dirty = true;
    this.viewport.invalidate();
  }

  /** Where the plane can go along the axis: across all objects. */
  private limits(): [number, number] {
    const box = this.doc.worldBox(this.doc.objects.filter((o) => !o.hidden));
    return [box.min.getComponent(this.axis), box.max.getComponent(this.axis)];
  }

  private setAxis(axis: Axis): void {
    this.axis = axis;
    // Keep the half away from the camera, so the cut faces the viewer (Flip swaps it).
    const v = this.viewport;
    this.flipped = v.camera.position.getComponent(axis) < v.orbit.target.getComponent(axis);
    for (const b of this.bar.querySelectorAll<HTMLButtonElement>('[data-section-axis]')) {
      b.classList.toggle('active', Number(b.dataset.sectionAxis) === axis);
    }
    const [lo, hi] = this.limits();
    this.range.min = String(toUnit(lo));
    this.range.max = String(toUnit(hi));
    this.range.step = String(toUnit(Math.max((hi - lo) / 400, 0.01)));
    this.bar.querySelector('.unit')!.textContent = settings.unit;
    this.setOffset((lo + hi) / 2);
  }

  private setOffset(offset: number): void {
    if (!Number.isFinite(offset)) return;
    const [lo, hi] = this.limits();
    this.offset = THREE.MathUtils.clamp(offset, lo, hi);
    this.range.value = String(toUnit(this.offset));
    if (document.activeElement !== this.value) this.value.value = String(Math.round(toUnit(this.offset) * 100) / 100);
    this.applyPlane();
  }

  /** Keep the side below the cut (left, front, below), or the other side when flipped. */
  private applyPlane(): void {
    const n = AXES[this.axis].clone().multiplyScalar(this.flipped ? 1 : -1);
    this.plane.set(n, this.flipped ? -this.offset : this.offset);
    this.markDirty();
  }

  // --- Drawing the cut ---------------------------------------------------------

  private update(): void {
    if (!this.on || !this.dirty) return;
    this.dirty = false;
    const objs = this.doc.objects;
    for (const [obj, h] of this.helpers) {
      if (!objs.includes(obj)) {
        this.disposeHelpers(h);
        this.helpers.delete(obj);
      }
    }
    this.cuts.clear();
    objs.forEach((obj, i) => {
      let h = this.helpers.get(obj);
      if (!h) {
        h = this.makeHelpers(obj);
        this.helpers.set(obj, h);
      }
      obj.mesh.updateMatrixWorld();
      for (const m of [h.back, h.front]) {
        m.geometry = obj.mesh.geometry;
        m.matrix.copy(obj.mesh.matrixWorld);
        m.matrixWorldNeedsUpdate = true;
        m.visible = obj.mesh.visible;
      }
      // Each object fills its own cut: stencil counts, then the cap (which clears the stencil after it).
      h.back.renderOrder = h.front.renderOrder = 10 + i * 2;
      h.cap.renderOrder = 11 + i * 2;
      h.cap.material.color.set(obj.color).multiplyScalar(0.8);
      // The cap: a square on the plane, big enough to cover the object's cut.
      const sphere = obj.mesh.geometry.boundingSphere!.clone().applyMatrix4(obj.mesh.matrixWorld);
      h.cap.position.copy(this.plane.projectPoint(sphere.center, new THREE.Vector3()));
      h.cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.plane.normal);
      h.cap.scale.setScalar(sphere.radius * 2.2);
      h.cap.visible = obj.mesh.visible;
      // The outline of the cut, also used for measuring snaps.
      const { segs, sharp } = cutSegments(obj.mesh, this.plane);
      h.outline.geometry.dispose();
      h.outline.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(segs, 3));
      h.outline.visible = obj.mesh.visible;
      if (segs.length) this.cuts.set(obj, { segs, ...edgeFeatures(segs, sharp) });
    });
  }

  private makeHelpers(obj: SceneObject): Helpers {
    const stencil = (side: THREE.Side, op: THREE.StencilOp) => new THREE.MeshBasicMaterial({
      side, colorWrite: false, depthWrite: false, depthTest: false,
      stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc,
      stencilFail: op, stencilZFail: op, stencilZPass: op,
      clippingPlanes: [this.plane],
    });
    const back = new THREE.Mesh(obj.mesh.geometry, stencil(THREE.BackSide, THREE.IncrementWrapStencilOp));
    const front = new THREE.Mesh(obj.mesh.geometry, stencil(THREE.FrontSide, THREE.DecrementWrapStencilOp));
    for (const m of [back, front]) {
      m.matrixAutoUpdate = false;
      m.raycast = () => {};
    }
    const cap = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({
      roughness: 0.75, side: THREE.DoubleSide,
      stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
      // Pushed back a little so the outline drawn on it stays visible.
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    }));
    cap.onAfterRender = (renderer) => renderer.clearStencil();
    cap.raycast = () => {};
    const outline = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: edgeMaterial.color }));
    outline.raycast = () => {};
    outline.renderOrder = 50;
    this.group.add(back, front, cap, outline);
    return { back, front, cap, outline };
  }

  private disposeHelpers(h: Helpers): void {
    this.group.remove(h.back, h.front, h.cap, h.outline);
    (h.back.material as THREE.Material).dispose();
    (h.front.material as THREE.Material).dispose();
    h.cap.geometry.dispose();
    h.cap.material.dispose();
    h.outline.geometry.dispose();
    (h.outline.material as THREE.Material).dispose();
  }
}
