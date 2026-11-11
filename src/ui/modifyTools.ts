import * as THREE from 'three';
import type { Piece } from '../geometry/cut';
import { findEdges, type EdgeSegment, type V3 } from '../geometry/edges';
import { centredRowMoves } from '../geometry/features';
import { bakeMesh } from '../geometry/meshData';
import { runOp } from '../geometry/workerClient';
import type { ObjectState, SceneDocument, SceneObject } from '../scene/document';
import type { Viewport } from '../scene/viewport';
import { EdgePicker } from './edgePicker';
import { previewMesh, type FeatureBar, type Values } from './featureBar';
import { SnapPicker } from './snapPicker';

type Heavy = <T>(objs: SceneObject[], compute: () => Promise<T>, apply: (r: T) => void) => Promise<void>;

const AXES: Record<string, V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/**
 * The More menu (bevel, round, brace, shell) and the Pattern button. Each opens
 * the feature bar with its settings and a live preview.
 */
export class ModifyTools {
  private readonly edges: EdgePicker;
  private readonly points: SnapPicker;

  constructor(
    viewport: Viewport,
    private readonly doc: SceneDocument,
    private readonly bar: FeatureBar,
    private readonly heavy: Heavy,
    private readonly toast: (msg: string) => void,
  ) {
    this.edges = new EdgePicker(viewport);
    this.points = new SnapPicker(viewport, doc);
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

  // --- Bevel / Round (chamfer / fillet) --------------------------------------

  private edgeTool(kind: 'chamfer' | 'fillet'): void {
    const obj = this.one();
    if (!obj) return;
    const set = findEdges(bakeMesh(this.doc.placed(obj)));
    if (set.segments.length === 0) return this.toast(`${obj.name} has no sharp edges to ${kind === 'chamfer' ? 'bevel' : 'round'}`);
    const name = kind === 'chamfer' ? 'Bevel' : 'Round';
    this.bar.open<Piece>({
      title: name,
      hint: `${name}: click edges to pick them (blue; click again to drop). The result shows in orange.`,
      fields: [
        {
          key: 'size', label: kind === 'chamfer' ? 'Distance' : 'Radius', type: 'number', value: 2, min: 0.1, step: 0.5, unit: 'mm',
          tip: kind === 'chamfer' ? 'How far the cut reaches along each face from the edge.' : 'Radius of the rounding. Inside corners get filled with the same radius.',
        },
      ],
      ...this.pieceSpec(obj),

      compute: async (v) => {
        const segments = this.edges.segments;
        if (segments.length === 0) return null;
        return runOp('edgeTreatment', { item: this.doc.placed(obj), segments, kind, size: Number(v.size) });
      },
      onClose: () => this.edges.stop(),
    });
    this.edges.start(set, { onChange: () => this.bar.refresh(50) });
  }

  // --- Brace (gusset) ----------------------------------------------------------

  private gusset(): void {
    const obj = this.one();
    if (!obj) return;
    const set = findEdges(bakeMesh(this.doc.placed(obj)));
    const inside = (s: EdgeSegment) => !s.convex;
    if (!set.segments.some(inside)) return this.toast(`${obj.name} has no inside corner where two walls meet`);
    this.bar.open<Piece>({
      title: 'Brace',
      hint: 'Brace: click the inside corner where two walls meet.',
      fields: [
        { key: 'leg1', label: 'Leg 1', type: 'number', value: 10, min: 0.5, step: 1, unit: 'mm', tip: 'How far the brace reaches up the first wall.' },
        { key: 'leg2', label: 'Leg 2', type: 'number', value: 10, min: 0.5, step: 1, unit: 'mm', tip: 'How far it reaches along the second wall.' },
        { key: 'thickness', label: 'Thickness', type: 'number', value: 2, min: 0.4, step: 0.5, unit: 'mm', tip: 'Thickness of the triangular plate.' },
        { key: 'position', label: 'Position', type: 'number', value: 50, min: 0, max: 100, step: 5, unit: '%', tip: 'Where along the corner the brace sits (0 = one end, 100 = the other).' },
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
      compute: (v) => runOp('shell', { item: this.doc.placed(obj), thickness: Number(v.thickness), thread: obj.thread }),
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
    const round2 = (n: number) => Math.round(n * 100) / 100;
    /** The point the row or the axis is centred on (null: linear without a point) */
    const centreOf = (v: Values): THREE.Vector3 | null =>
      v.type === 'linear'
        ? (v.centreOn === 'on' ? new THREE.Vector3(Number(v.px), Number(v.py), Number(v.pz)) : null)
        : new THREE.Vector3(Number(v.cx), Number(v.cy), Number(v.cz));
    const transforms = (v: Values): { moved: ObjectState[] | null; copies: ObjectState[][]; centre: THREE.Vector3 | null } => {
      const count = Math.max(2, Math.min(200, Math.round(Number(v.count))));
      const states = objs.map((o) => this.doc.capture(o));
      const about = centreOf(v);
      const shift = (s: ObjectState, by: V3): ObjectState => ({
        ...s, position: [s.position[0] + by[0], s.position[1] + by[1], s.position[2] + by[2]],
      });
      // Linear, centred on a point: the row of `count` items (the original included) is centred there.
      if (v.type === 'linear' && about) {
        const moves = centredRowMoves(count, Number(v.spacing), AXES[String(v.direction)], about.toArray() as V3, centre.toArray() as V3);
        return { moved: states.map((s) => shift(s, moves[0])), copies: moves.slice(1).map((m) => states.map((s) => shift(s, m))), centre: about };
      }
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
            pos.sub(about!).applyQuaternion(rot).add(about!);
            q.premultiply(rot);
          }
          return { ...s, position: pos.toArray() as [number, number, number], quaternion: q.toArray() as [number, number, number, number] };
        }));
      }
      return { moved: null, copies: out, centre: about };
    };
    const ghost = new THREE.MeshStandardMaterial({ color: 0xf2a33a, transparent: true, opacity: 0.55 });
    const markerMaterial = new THREE.MeshBasicMaterial({ color: 0x4cb8ff, depthTest: false, transparent: true });
    const markerSize = Math.max(1, Math.max(size.x, size.y, size.z) * 0.04);
    /** A small ball at the point the pattern is centred on */
    const marker = (at: THREE.Vector3) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(markerSize, 16, 12), markerMaterial);
      m.position.copy(at);
      m.renderOrder = 10;
      return m;
    };
    const pickPoint = () => {
      const typeSelect = document.querySelector<HTMLSelectElement>('#feature-bar [data-key="type"] select');
      const circular = typeSelect?.value === 'circular';
      this.toast('Click a point on the model (Esc stops picking)');
      this.points.start({
        onPick: (at) => {
          const [x, y, z] = at.toArray().map(round2);
          const [kx, ky, kz] = circular ? ['cx', 'cy', 'cz'] : ['px', 'py', 'pz'];
          if (!circular) this.bar.setValue('centreOn', 'on', null);
          this.bar.setValue(kx, x, null);
          this.bar.setValue(ky, y, null);
          this.bar.setValue(kz, z);
        },
      });
    };
    const linear: [string, string] = ['type', 'linear'];
    const centred = (v: Values) => v.type === 'linear' && v.centreOn === 'on';
    this.bar.open<ReturnType<typeof transforms>>({
      title: 'Pattern',
      hint: 'Pattern: repeat the selection in a row or around an axis. Pick a point on the model to centre it there. Apply to add the copies.',
      fields: [
        { key: 'type', label: 'Type', type: 'select', value: 'linear', options: [['linear', 'Linear'], ['circular', 'Circular']], tip: 'Copies in a straight row, or around an axis.' },
        { key: 'count', label: 'Count', type: 'number', value: 4, min: 2, max: 200, step: 1, tip: 'Total number, including the original.' },
        { key: 'spacing', label: 'Spacing', type: 'number', value: spacing, step: 1, unit: 'mm', showIf: linear, tip: 'Distance from one copy to the next.' },
        { key: 'direction', label: 'Along', type: 'select', value: 'x', options: [['x', 'X'], ['y', 'Y'], ['z', 'Z']], showIf: linear, tip: 'Direction of the row.' },
        { key: 'centreOn', label: 'Centre', type: 'select', value: 'off', options: [['off', 'Off'], ['on', 'On a point']], showIf: linear, tip: 'Off: the row starts at the original. On a point: the row (original included) is centred on that point.' },
        { key: 'px', label: 'Point X', type: 'number', value: round2(centre.x), step: 1, unit: 'mm', showIf: centred, tip: 'The point the row is centred on.' },
        { key: 'py', label: 'Point Y', type: 'number', value: round2(centre.y), step: 1, unit: 'mm', showIf: centred, tip: 'The point the row is centred on.' },
        { key: 'pz', label: 'Point Z', type: 'number', value: round2(centre.z), step: 1, unit: 'mm', showIf: centred, tip: 'The point the row is centred on.' },
        { key: 'angle', label: 'Angle', type: 'number', value: 360, step: 15, unit: '°', showIf: ['type', 'circular'], tip: 'Total angle covered. 360° spreads copies evenly all the way round.' },
        { key: 'axis', label: 'Axis', type: 'select', value: 'z', options: [['z', 'Z (vertical)'], ['x', 'X'], ['y', 'Y']], showIf: ['type', 'circular'], tip: 'Axis the copies turn around.' },
        { key: 'cx', label: 'Centre X', type: 'number', value: Math.round(centre.x - spacing), step: 1, unit: 'mm', showIf: (v) => v.type === 'circular' && v.axis !== 'x', tip: 'Where the axis passes through.' },
        { key: 'cy', label: 'Centre Y', type: 'number', value: Math.round(centre.y), step: 1, unit: 'mm', showIf: (v) => v.type === 'circular' && v.axis !== 'y', tip: 'Where the axis passes through.' },
        { key: 'cz', label: 'Centre Z', type: 'number', value: 0, step: 1, unit: 'mm', showIf: (v) => v.type === 'circular' && v.axis !== 'z', tip: 'Where the axis passes through.' },
        { key: 'pick', label: 'Pick point', type: 'button', value: '', onClick: pickPoint, showIf: (v) => v.type === 'circular' || v.centreOn === 'on', tip: 'Click a corner, edge or face on the model to centre the pattern there (Esc stops picking).' },
        { key: 'merge', label: 'Merge into one', type: 'checkbox', value: false, tip: 'Join the original and all copies into a single object.' },
      ],
      targets: objs,
      onClose: () => this.points.stop(),
      compute: async (v) => transforms(v),
      show: ({ moved, copies, centre: about }) => {
        const ghostOf = (states: ObjectState[]) => states.map((s, i) => {
          const m = new THREE.Mesh(objs[i].mesh.geometry, ghost);
          m.position.fromArray(s.position);
          m.quaternion.fromArray(s.quaternion);
          m.scale.fromArray(s.scale);
          m.userData.sharedGeometry = true; // the preview must not free the object's geometry
          return m;
        });
        return [...(moved ? ghostOf(moved) : []), ...copies.flatMap(ghostOf), ...(about ? [marker(about)] : [])];
      },
      apply: ({ moved, copies }, v) => {
        if (!objs.every((o) => this.doc.objects.includes(o))) return;
        this.doc.checkpoint();
        // Centred on a point: the original moves to the first place of the row.
        if (moved) {
          objs.forEach((o, i) => o.mesh.position.fromArray(moved[i].position));
          this.doc.emit('transform');
        }
        const added = copies.flatMap((states) => this.doc.addCopies(states));
        const all = [...objs, ...added];
        if (!v.merge) return this.doc.setSelection(all);
        void this.heavy(all, () => runOp('union', { items: all.map((o) => this.doc.placed(o)) }), (r) => {
          if (r.empty) return;
          const color = objs[0].color;
          this.doc.remove(all);
          const merged = this.doc.add('Object', r.mesh, color);
          merged.mesh.position.set(...r.center);
          this.doc.setSelection([merged]);
        });
      },
    });
  }
}
