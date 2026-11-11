import * as THREE from 'three';
import { bakeMesh, type MeshData } from '../geometry/meshData';
import { mirrorMesh, recenter } from '../geometry/meshOps';
import type { SceneDocument, SceneObject } from '../scene/document';
import { units } from './arrange';
import { FeatureBar, previewMesh } from './featureBar';
import { showHint } from './hint';

const AXIS_NAMES = ['X', 'Y', 'Z'] as const;

/**
 * Mirror and Rotate 90° (Edit group of the toolbar). Both open the parameter
 * bar with an orange preview of the result; Apply is one undo step, Cancel
 * leaves everything as it was.
 */
export class TurnTools {
  constructor(
    private readonly doc: SceneDocument,
    private readonly bar: FeatureBar,
    private readonly toast: (msg: string) => void,
  ) {
    for (const b of document.querySelectorAll('[data-action="mirror"]')) b.addEventListener('click', () => this.mirror());
    for (const b of document.querySelectorAll('[data-action="rotate90"]')) b.addEventListener('click', () => this.rotate());
  }

  // --- Mirror -------------------------------------------------------------------

  private mirror(): void {
    const objs = [...this.doc.selection];
    if (objs.length === 0) return this.toast('Select an object first');
    const doc = this.doc;
    interface Flipped { obj: SceneObject; mesh: MeshData; position: THREE.Vector3 }
    this.bar.open<Flipped[]>({
      title: 'Mirror',
      hint: 'Mirror: pick the axis to flip along. Apply to flip the selection.',
      fields: [
        { key: 'axis', label: 'Axis', type: 'select', value: 'x', options: [['x', 'X'], ['y', 'Y'], ['z', 'Z']], tip: 'The selection is flipped along this axis.' },
      ],
      hide: objs,
      targets: objs,
      compute: async (v) => {
        const axis = AXIS_NAMES.indexOf(String(v.axis).toUpperCase() as 'X') as 0 | 1 | 2;
        const out: Flipped[] = [];
        // A group mirrors as a whole: through the middle of the group, so its
        // parts swap sides too. A loose object mirrors through its own middle.
        for (const unit of units(doc, objs)) {
          const mid = (unit.box.min.getComponent(axis) + unit.box.max.getComponent(axis)) / 2;
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
        return out;
      },
      show: (flipped) => flipped.map((f) => previewMesh(f.mesh, f.position.toArray())),
      apply: (flipped) => {
        if (!flipped.every((f) => doc.objects.includes(f.obj))) return;
        doc.checkpoint();
        for (const f of flipped) {
          doc.setData(f.obj, f.mesh);
          f.obj.mesh.position.copy(f.position);
          f.obj.mesh.quaternion.identity();
          f.obj.mesh.scale.set(1, 1, 1);
        }
        doc.emit('transform');
      },
    });
  }

  // --- Rotate 90° ----------------------------------------------------------------

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
      if (title) title.textContent = t ? `Rotate 90°: ${t}` : 'Rotate 90°';
      showHint('feature', t
        ? `Rotate 90°: total ${t}. Click X, Y or Z to turn further, Reset to start again, Apply to turn the selection.`
        : 'Rotate 90°: click X, Y or Z for a quarter turn clockwise (as often as you like), then Apply.');
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
      title: 'Rotate 90°',
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
        doc.checkpoint();
        objs.forEach((o, i) => {
          o.mesh.position.copy(placed[i].position);
          o.mesh.quaternion.copy(placed[i].quaternion);
        });
        doc.emit('transform');
      },
      onClose: () => ghost.dispose(),
    });
    show();
  }
}
