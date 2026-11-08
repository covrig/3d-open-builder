import * as THREE from 'three';
import type { Piece } from '../geometry/cut';
import { findEdges, type EdgeSegment, type V3 } from '../geometry/edges';
import { bakeMesh } from '../geometry/meshData';
import { runOp } from '../geometry/workerClient';
import type { ObjectState, SceneDocument, SceneObject } from '../scene/document';
import type { Viewport } from '../scene/viewport';
import { EdgePicker } from './edgePicker';
import { previewMesh, type FeatureBar, type Values } from './featureBar';

type Heavy = <T>(objs: SceneObject[], compute: () => Promise<T>, apply: (r: T) => void) => Promise<void>;

const AXES: Record<string, V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/**
 * The More menu (chamfer, fillet, shell, gusset) and the Pattern button. Each opens
 * the feature bar with its settings and a live preview.
 */
export class ModifyTools {
  private readonly edges: EdgePicker;

  constructor(
    viewport: Viewport,
    private readonly doc: SceneDocument,
    private readonly bar: FeatureBar,
    private readonly heavy: Heavy,
    private readonly toast: (msg: string) => void,
  ) {
    this.edges = new EdgePicker(viewport);
    const actions: Record<string, () => void> = {
      chamfer: () => this.edgeTool('chamfer'),
      fillet: () => this.edgeTool('fillet'),
      shell: () => this.shell(),
      gusset: () => this.gusset(),
      pattern: () => this.pattern(),
    };
    for (const b of document.querySelectorAll<HTMLElement>('[data-modify]')) {
      b.addEventListener('click', () => actions[b.dataset.modify!]?.());
    }
  }

  private one(): SceneObject | undefined {
    if (this.doc.selection.length !== 1) {
      this.toast('Select one object first');
      return undefined;
    }
    return this.doc.selection[0];
  }

  /** Replace an object's geometry with a computed piece (undoable). */
  private replace(obj: SceneObject, piece: Piece): void {
    if (!this.doc.objects.includes(obj)) return;
    this.doc.checkpoint();
    this.doc.setData(obj, piece.mesh);
    obj.mesh.position.set(...piece.center);
    obj.mesh.quaternion.identity();
    obj.mesh.scale.set(1, 1, 1);
    this.doc.emit('transform');
  }

  private pieceSpec(obj: SceneObject) {
    return {
      hide: [obj],
      show: (p: Piece) => [previewMesh(p.mesh, p.center)],
      apply: (p: Piece) => this.replace(obj, p),
    };
  }

  // --- Chamfer / Fillet -------------------------------------------------------

  private edgeTool(kind: 'chamfer' | 'fillet'): void {
    const obj = this.one();
    if (!obj) return;
    const set = findEdges(bakeMesh(this.doc.placed(obj)));
    if (set.segments.length === 0) return this.toast(`${obj.name} has no sharp edges to ${kind}`);
    const name = kind === 'chamfer' ? 'Chamfer' : 'Fillet';
    this.bar.open<Piece>({
      title: name,
      hint: `${name}: click edges to pick them (click again to drop), or choose "All sharp edges". Esc to cancel.`,
      fields: [
        {
          key: 'size', label: kind === 'chamfer' ? 'Distance' : 'Radius', type: 'number', value: 2, min: 0.1, step: 0.5, unit: 'mm',
          tip: kind === 'chamfer' ? 'How far the cut reaches along each face from the edge.' : 'Radius of the rounding. Inside corners get filled with the same radius.',
        },
        {
          key: 'scope', label: 'Edges', type: 'select', value: 'picked',
          options: [['picked', 'Picked edges'], ['all', 'All sharp edges']],
          tip: 'Only the edges you click, or every sharp edge of the object (outside and inside).',
        },
      ],
      ...this.pieceSpec(obj),
      compute: async (v) => {
        const segments = v.scope === 'all' ? set.segments : this.edges.segments;
        if (segments.length === 0) return null;
        return runOp('edgeTreatment', { item: this.doc.placed(obj), segments, kind, size: Number(v.size) });
      },
      onClose: () => this.edges.stop(),
    });
    this.edges.start(set, { onChange: () => this.bar.refresh(50) });
  }

  // --- Gusset -----------------------------------------------------------------

  private gusset(): void {
    const obj = this.one();
    if (!obj) return;
    const set = findEdges(bakeMesh(this.doc.placed(obj)));
    const inside = (s: EdgeSegment) => !s.convex;
    if (!set.segments.some(inside)) return this.toast(`${obj.name} has no inside corner where two walls meet`);
    this.bar.open<Piece>({
      title: 'Gusset',
      hint: 'Gusset: click the inside corner where two walls meet. Esc to cancel.',
      fields: [
        { key: 'leg1', label: 'Leg 1', type: 'number', value: 10, min: 0.5, step: 1, unit: 'mm', tip: 'How far the gusset reaches up the first wall.' },
        { key: 'leg2', label: 'Leg 2', type: 'number', value: 10, min: 0.5, step: 1, unit: 'mm', tip: 'How far it reaches along the second wall.' },
        { key: 'thickness', label: 'Thickness', type: 'number', value: 2, min: 0.4, step: 0.5, unit: 'mm', tip: 'Thickness of the triangular plate.' },
        { key: 'position', label: 'Position', type: 'number', value: 50, min: 0, max: 100, step: 5, unit: '%', tip: 'Where along the corner the gusset sits (0 = one end, 100 = the other).' },
      ],
      ...this.pieceSpec(obj),
      compute: async (v) => {
        const edge = this.edges.segments.find(inside);
        if (!edge) return null;
        // Position runs along the whole picked corner, not one segment.
        const run = this.edges.segments.filter(inside);
        const idx = Math.min(run.length - 1, Math.floor((Number(v.position) / 100) * run.length));
        const seg = run[idx];
        const within = (Number(v.position) / 100) * run.length - idx;
        return runOp('gusset', {
          item: this.doc.placed(obj), edge: seg,
          leg1: Number(v.leg1), leg2: Number(v.leg2), thickness: Number(v.thickness), position: Math.min(1, within),
        });
      },
      onClose: () => this.edges.stop(),
    });
    this.edges.start(set, { single: true, filter: inside, onChange: () => this.bar.refresh(50) });
  }

  // --- Shell --------------------------------------------------------------------

  private shell(): void {
    const obj = this.one();
    if (!obj) return;
    this.bar.open<Piece>({
      title: 'Shell',
      hint: 'Shell: hollow the object, keeping walls of the given thickness. Apply when the preview looks right.',
      fields: [
        { key: 'thickness', label: 'Wall', type: 'number', value: 2, min: 0.2, step: 0.2, unit: 'mm', tip: 'Thickness of the walls that remain.' },
      ],
      ...this.pieceSpec(obj),
      compute: (v) => runOp('shell', { item: this.doc.placed(obj), thickness: Number(v.thickness) }),
    });
  }

  // --- Pattern ------------------------------------------------------------------

  private pattern(): void {
    const objs = [...this.doc.selection];
    if (objs.length === 0) return this.toast('Select the objects to repeat');
    const box = this.doc.worldBox(objs);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const spacing = Math.round(Math.max(size.x, size.y, 5) + 5);
    const transforms = (v: Values): ObjectState[][] => {
      const count = Math.max(2, Math.min(200, Math.round(Number(v.count))));
      const states = objs.map((o) => this.doc.capture(o));
      const out: ObjectState[][] = [];
      for (let k = 1; k < count; k++) {
        out.push(states.map((s) => {
          const pos = new THREE.Vector3(...s.position);
          const q = new THREE.Quaternion(...s.quaternion);
          if (v.type === 'linear') {
            pos.addScaledVector(new THREE.Vector3(...AXES[String(v.direction)]), Number(v.spacing) * k);
          } else {
            const total = Number(v.angle);
            const step = THREE.MathUtils.degToRad(total) / (Math.abs(total) >= 360 ? count : count - 1);
            const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...AXES[String(v.axis)]), step * k);
            const c = new THREE.Vector3(Number(v.cx), Number(v.cy), Number(v.cz));
            pos.sub(c).applyQuaternion(rot).add(c);
            q.premultiply(rot);
          }
          return { ...s, position: pos.toArray() as [number, number, number], quaternion: q.toArray() as [number, number, number, number] };
        }));
      }
      return out;
    };
    const ghost = new THREE.MeshStandardMaterial({ color: 0xf2a33a, transparent: true, opacity: 0.55 });
    this.bar.open<ObjectState[][]>({
      title: 'Pattern',
      hint: 'Pattern: repeat the selection in a row or around an axis. Apply to add the copies.',
      fields: [
        { key: 'type', label: 'Type', type: 'select', value: 'linear', options: [['linear', 'Linear'], ['circular', 'Circular']], tip: 'Copies in a straight row, or around an axis.' },
        { key: 'count', label: 'Count', type: 'number', value: 4, min: 2, max: 200, step: 1, tip: 'Total number, including the original.' },
        { key: 'spacing', label: 'Spacing', type: 'number', value: spacing, step: 1, unit: 'mm', showIf: ['type', 'linear'], tip: 'Distance from one copy to the next.' },
        { key: 'direction', label: 'Along', type: 'select', value: 'x', options: [['x', 'X'], ['y', 'Y'], ['z', 'Z']], showIf: ['type', 'linear'], tip: 'Direction of the row.' },
        { key: 'angle', label: 'Angle', type: 'number', value: 360, step: 15, unit: '°', showIf: ['type', 'circular'], tip: 'Total angle covered. 360° spreads copies evenly all the way round.' },
        { key: 'axis', label: 'Axis', type: 'select', value: 'z', options: [['z', 'Z (vertical)'], ['x', 'X'], ['y', 'Y']], showIf: ['type', 'circular'], tip: 'Axis the copies turn around.' },
        { key: 'cx', label: 'Centre X', type: 'number', value: Math.round(centre.x - spacing), step: 1, unit: 'mm', showIf: ['type', 'circular'], tip: 'Point the axis goes through.' },
        { key: 'cy', label: 'Y', type: 'number', value: Math.round(centre.y), step: 1, unit: 'mm', showIf: ['type', 'circular'] },
        { key: 'cz', label: 'Z', type: 'number', value: 0, step: 1, unit: 'mm', showIf: ['type', 'circular'] },
        { key: 'merge', label: 'Merge into one', type: 'checkbox', value: false, tip: 'Join the original and all copies into a single object.' },
      ],
      targets: objs,
      compute: async (v) => transforms(v),
      show: (copies) => copies.flatMap((states) => states.map((s, i) => {
        const m = new THREE.Mesh(objs[i].mesh.geometry, ghost);
        m.position.fromArray(s.position);
        m.quaternion.fromArray(s.quaternion);
        m.scale.fromArray(s.scale);
        m.userData.sharedGeometry = true; // the preview must not free the object's geometry
        return m;
      })),
      apply: (copies, v) => {
        if (!objs.every((o) => this.doc.objects.includes(o))) return;
        this.doc.checkpoint();
        const added = copies.flatMap((states) => this.doc.addCopies(states));
        const all = [...objs, ...added];
        if (!v.merge) return this.doc.setSelection(all);
        void this.heavy(all, () => runOp('union', { items: all.map((o) => this.doc.placed(o)) }), (r) => {
          if (r.empty) return;
          const color = objs[0].color;
          this.doc.remove(all);
          const merged = this.doc.add('Pattern', r.mesh, color);
          merged.mesh.position.set(...r.center);
          this.doc.setSelection([merged]);
        });
      },
    });
  }
}
