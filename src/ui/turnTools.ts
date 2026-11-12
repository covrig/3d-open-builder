import * as THREE from 'three';
import { bakeMesh, type MeshData } from '../geometry/meshData';
import { lineMirrorNormal, mirrorMesh, recenter, reflectMesh, reflectPoint, type Vec3 } from '../geometry/meshOps';
import type { ObjectState, SceneDocument, SceneObject } from '../scene/document';
import { units } from './arrange';
import { FeatureBar, previewMesh } from './featureBar';
import { showHint } from './hint';
import { mirrorPlaneAt } from './mirrorDistance';
import { SnapPicker } from './snapPicker';

const AXIS_NAMES = ['X', 'Y', 'Z'] as const;

/**
 * The states of the mirrored copies made by "Keep the original". Their mesh is
 * baked, so a copy is no longer a plain thread: it keeps no thread info
 * (Shell would otherwise cut through it from a stand-in that is not mirrored).
 */
export function mirroredCopyStates(
  doc: Pick<SceneDocument, 'capture'>,
  flipped: { obj: SceneObject; mesh: MeshData; position: THREE.Vector3 }[],
): ObjectState[] {
  return flipped.map((f) => ({
    ...doc.capture(f.obj),
    data: f.mesh,
    thread: undefined,
    position: f.position.toArray() as [number, number, number],
    quaternion: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  }));
}

/**
 * Mirror and Rotate (Edit group of the toolbar). Both open the parameter
 * bar with an orange preview of the result; Apply is one undo step, Cancel
 * leaves everything as it was.
 */
export class TurnTools {
  private readonly points: SnapPicker;

  constructor(
    private readonly doc: SceneDocument,
    private readonly bar: FeatureBar,
    private readonly toast: (msg: string) => void,
  ) {
    this.points = new SnapPicker(bar.viewport, doc);
    for (const b of document.querySelectorAll('[data-action="mirror"]')) b.addEventListener('click', () => this.mirror());
    for (const b of document.querySelectorAll('[data-action="rotate90"]')) b.addEventListener('click', () => this.rotate());
  }

  // --- Mirror -------------------------------------------------------------------

  private mirror(): void {
    const objs = [...this.doc.selection];
    if (objs.length === 0) return this.toast('Select an object first');
    const doc = this.doc;
    const bar = this.bar;
    const picker = this.points;
    const camera = bar.viewport.camera;
    interface Flipped { obj: SceneObject; mesh: MeshData; position: THREE.Vector3 }
    interface Result { flipped: Flipped[]; ready: boolean; picked: THREE.Vector3[]; normal: Vec3 | null; mode: string; keep: boolean }

    // Picking for the Line (2 points) mode.
    let mode = 'axis';
    let picked: THREE.Vector3[] = [];
    /** Mirror plane (point and unit normal), once both points are picked */
    let plane: { at: Vec3; n: Vec3 } | null = null;
    const needed = () => (mode === 'line' ? 2 : 0);
    const solvePlane = (): void => {
      plane = null;
      if (picked.length < needed()) return;
      const p = picked.map((v) => v.toArray() as Vec3);
      const n = lineMirrorNormal(p[0], p[1], camera.position.toArray() as Vec3);
      if (n) plane = { at: p[0], n };
    };
    const askNext = () => {
      if (picked.length >= needed()) {
        return showHint('feature', plane
          ? 'Mirror: Apply to flip the selection, or Pick again to choose other points.'
          : 'Mirror: those points do not define a plane (they lie in a line). Click Pick again.');
      }
      showHint('feature', `Mirror: click point ${picked.length + 1} of 2 for the line (corners, edge middles and face centres snap). Esc stops picking.`);
      picker.start({
        extraPoints: () => picked,
        onPick: (at) => {
          picked.push(at);
          solvePlane();
          askNext();
          bar.refresh(0);
        },
      });
    };
    const restart = () => {
      picker.stop();
      picked = [];
      plane = null;
      if (needed() > 0) askNext();
      else showHint('feature', 'Mirror: pick the axis to flip along. Apply to flip the selection.');
    };

    const ghost = new THREE.MeshStandardMaterial({
      color: 0xf2a33a, transparent: true, opacity: 0.75, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -1,
    });
    const markMaterial = new THREE.MeshBasicMaterial({ color: 0x4cb8ff, depthTest: false, transparent: true });
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x4cb8ff, depthTest: false });
    const span = Math.max(doc.worldBox(objs).getSize(new THREE.Vector3()).length(), 10);

    const mirrorAbout = (n: Vec3, at: Vec3): Flipped[] => objs.map((obj) => {
      // Rotation and scale are baked into the geometry, which is reflected about the
      // object's own origin; then the origin's mirror image is where it goes.
      const m = obj.mesh;
      const linear = new THREE.Matrix4().compose(new THREE.Vector3(), m.quaternion, m.scale);
      const { mesh, center } = recenter(reflectMesh(bakeMesh({ mesh: obj.data, matrix: linear.elements }), n));
      const position = new THREE.Vector3(...reflectPoint(m.position.toArray() as Vec3, at, n)).add(new THREE.Vector3(...center));
      return { obj, mesh, position };
    });

    bar.open<Result>({
      title: 'Mirror',
      hint: 'Mirror: pick the axis to flip along. Apply to flip the selection.',
      fields: [
        {
          key: 'mode', label: 'Mirror across', type: 'select', value: 'axis',
          tip: 'Axis: flip through the middle of the selection. Line: click two points; the mirror is the vertical plane through them.',
          options: [['axis', 'Axis'], ['line', 'Line (2 points)']],
        },
        { key: 'axis', label: 'Axis', type: 'select', value: 'x', options: [['x', 'X'], ['y', 'Y'], ['z', 'Z']], showIf: ['mode', 'axis'], tip: 'The selection is flipped along this axis.' },
        {
          key: 'distance', label: 'Distance', type: 'number', unit: 'mm', value: 0, step: 1, showIf: ['mode', 'axis'],
          tip: '0 flips in place. Otherwise the copy lands this far from the original (negative: the other side).',
        },
        { key: 'keep', label: 'Keep the original', type: 'checkbox', value: false, tip: 'Keep the original and add the mirrored copy next to it.' },
        {
          key: 'again', label: 'Pick again', type: 'button', value: '', showIf: (v) => v.mode !== 'axis',
          tip: 'Throw away the points and click them again.',
          onClick: () => {
            restart();
            bar.refresh(0);
          },
        },
      ],
      hide: objs,
      targets: objs,
      compute: async (v) => {
        if (String(v.mode) !== mode) {
          mode = String(v.mode);
          restart();
        }
        const keep = v.keep === true;
        if (mode !== 'axis') {
          return { flipped: plane ? mirrorAbout(plane.n, plane.at) : [], ready: plane !== null, picked: [...picked], normal: plane?.n ?? null, mode, keep };
        }
        const axis = AXIS_NAMES.indexOf(String(v.axis).toUpperCase() as 'X') as 0 | 1 | 2;
        const out: Flipped[] = [];
        const distance = Number(v.distance) || 0;
        // A group mirrors as a whole: through the middle of the group, so its
        // parts swap sides too. A loose object mirrors through its own middle.
        for (const unit of units(doc, objs)) {
          const mid = mirrorPlaneAt(unit.box.min.getComponent(axis), unit.box.max.getComponent(axis), distance);
          for (const obj of unit.objs) {
            // Bake rotation and scale into the geometry and mirror it about the
            // object's own origin, then place the origin's mirror image. The
            // object ends up with no rotation, which keeps the transform bar simple.
            const m = obj.mesh;
            const linear = new THREE.Matrix4().compose(new THREE.Vector3(), m.quaternion, m.scale);
            const mirrored = mirrorMesh(bakeMesh({ mesh: obj.data, matrix: linear.elements }), axis);
            const { mesh, center } = recenter(mirrored);
            const position = m.position.clone();
            position.setComponent(axis, 2 * mid - position.getComponent(axis));
            position.add(new THREE.Vector3(...center));
            out.push({ obj, mesh, position });
          }
        }
        return { flipped: out, ready: true, picked: [], normal: null, mode, keep };
      },
      show: (r) => {
        const out: THREE.Object3D[] = [];
        if (r.keep) {
          // The originals are hidden while the bar is open; draw them as they are.
          for (const o of objs) {
            const g = new THREE.Mesh(o.mesh.geometry, o.mesh.material);
            g.position.copy(o.mesh.position);
            g.quaternion.copy(o.mesh.quaternion);
            g.scale.copy(o.mesh.scale);
            g.userData.sharedGeometry = true;
            out.push(g);
          }
        }
        if (r.ready) out.push(...r.flipped.map((f) => previewMesh(f.mesh, f.position.toArray())));
        else {
          // Still picking: show the selection where it is (its own meshes are hidden meanwhile).
          for (const o of objs) {
            const g = new THREE.Mesh(o.mesh.geometry, ghost);
            g.position.copy(o.mesh.position);
            g.quaternion.copy(o.mesh.quaternion);
            g.scale.copy(o.mesh.scale);
            g.userData.sharedGeometry = true; // the preview must not free the object's geometry
            out.push(g);
          }
        }
        const radius = Math.max(0.5, span * 0.012);
        for (const p of r.picked) {
          const dot = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), markMaterial);
          dot.position.copy(p);
          dot.renderOrder = 10;
          out.push(dot);
        }
        if (r.mode === 'line' && r.picked.length === 2) {
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(r.picked), lineMaterial);
          line.renderOrder = 10;
          out.push(line);
        }
        return out;
      },
      apply: (r) => {
        if (!r.ready) return this.toast('Mirror: pick the points first');
        if (!r.flipped.every((f) => doc.objects.includes(f.obj))) return;
        doc.transact(() => {
          if (r.keep) {
            // Mirrored copies; copies of a group form a group of their own.
            doc.setSelection(doc.addCopies(mirroredCopyStates(doc, r.flipped)));
            return;
          }
          for (const f of r.flipped) doc.replaceWithPiece(f.obj, { mesh: f.mesh, center: f.position.toArray() });
          doc.emit('transform');
        });
      },
      onClose: () => {
        picker.stop();
        ghost.dispose();
        markMaterial.dispose();
        lineMaterial.dispose();
      },
    });
  }

  // --- Rotate ----------------------------------------------------------------

  /**
   * Each click on X, Y or Z adds a quarter turn clockwise seen from the positive
   * end of the axis (so -90° by the right-hand rule). The whole selection turns
   * as one about its centre and keeps its lowest point where it was, so things
   * resting on the plate stay on it.
   */
  private rotate(): void {
    const objs = [...this.doc.selection];
    if (objs.length === 0) return this.toast('Select an object first');
    const doc = this.doc;
    const turns: number[] = [];
    interface Placed { position: THREE.Vector3; quaternion: THREE.Quaternion }

    /** Neighbouring turns about the same axis are added up: "X 180°, Z 90°". */
    const total = (): string => {
      const runs: [number, number][] = [];
      for (const a of turns) {
        const last = runs[runs.length - 1];
        if (last && last[0] === a) last[1] += 90;
        else runs.push([a, 90]);
      }
      return runs.map(([a, deg]) => `${AXIS_NAMES[a]} ${deg % 360 === 0 ? 360 : deg % 360}°`).join(', ');
    };
    const title = document.querySelector<HTMLElement>('#feature-bar .bar-title');
    const show = () => {
      const t = total();
      if (title) title.textContent = t ? `Rotate: ${t}` : 'Rotate';
      showHint('feature', t
        ? `Rotate: total ${t}. Click X, Y or Z to turn further, Reset to start again, Apply to turn the selection.`
        : 'Rotate: click X, Y or Z for a quarter turn clockwise (as often as you like), then Apply.');
    };

    /** The placements after all the turns, worked out on the real objects and put back. */
    const solve = (): Placed[] => {
      const saved = objs.map((o) => ({ p: o.mesh.position.clone(), q: o.mesh.quaternion.clone() }));
      for (const a of turns) {
        const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().setComponent(a, 1), -Math.PI / 2);
        const before = doc.worldBox(objs);
        const centre = before.getCenter(new THREE.Vector3());
        for (const o of objs) {
          o.mesh.quaternion.premultiply(turn);
          o.mesh.position.sub(centre).applyQuaternion(turn).add(centre);
        }
        const lift = before.min.z - doc.worldBox(objs).min.z;
        for (const o of objs) o.mesh.position.z += lift;
      }
      const placed = objs.map((o) => ({ position: o.mesh.position.clone(), quaternion: o.mesh.quaternion.clone() }));
      objs.forEach((o, i) => {
        o.mesh.position.copy(saved[i].p);
        o.mesh.quaternion.copy(saved[i].q);
      });
      return placed;
    };

    const ghost = new THREE.MeshStandardMaterial({
      color: 0xf2a33a, transparent: true, opacity: 0.75, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -1,
    });
    const add = (axis: number) => () => {
      turns.push(axis);
      show();
      this.bar.refresh(0);
    };
    this.bar.open<Placed[]>({
      title: 'Rotate',
      hint: '',
      fields: [
        ...AXIS_NAMES.map((name, i) => ({
          key: `turn${name}`, label: name, type: 'button' as const, value: '', onClick: add(i),
          tip: `Turn a quarter turn clockwise about ${name}, seen from its positive end.`,
        })),
        {
          key: 'reset', label: 'Reset', type: 'button', value: '', tip: 'Take back all the turns.',
          onClick: () => {
            turns.length = 0;
            show();
            this.bar.refresh(0);
          },
        },
      ],
      hide: objs,
      targets: objs,
      compute: async () => solve(),
      show: (placed) => placed.map((p, i) => {
        const m = new THREE.Mesh(objs[i].mesh.geometry, ghost);
        m.position.copy(p.position);
        m.quaternion.copy(p.quaternion);
        m.scale.copy(objs[i].mesh.scale);
        m.userData.sharedGeometry = true; // the preview must not free the object's geometry
        return m;
      }),
      apply: (placed) => {
        if (turns.length === 0 || !objs.every((o) => doc.objects.includes(o))) return;
        doc.transact(() => {
          objs.forEach((o, i) => {
            o.mesh.position.copy(placed[i].position);
            o.mesh.quaternion.copy(placed[i].quaternion);
          });
          doc.emit('transform');
        });
      },
      onClose: () => ghost.dispose(),
    });
    show();
  }
}
