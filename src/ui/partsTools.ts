import type { Mat4 } from 'manifold-3d';
import * as THREE from 'three';
import type { Piece } from '../geometry/cut';
import { flatFaceCentre } from '../geometry/faceRegion';
import { FONTS, loadFont, textOutlines, type FontName } from '../geometry/text';
import { ISO_THREADS, threadLabel, type ThreadKind, type ThreadSize } from '../geometry/threads';
import { runOp } from '../geometry/workerClient';
import type { SceneDocument, SceneObject } from '../scene/document';
import type { Viewport } from '../scene/viewport';
import { settings } from '../settings';
import { previewMesh, type FeatureBar } from './featureBar';
import { viewClicks } from './interaction';

type Heavy = <T>(objs: SceneObject[], compute: () => Promise<T>, apply: (r: T) => void) => Promise<void>;

const KIND_NAMES: Record<Exclude<ThreadKind, 'tap'>, string> = { bolt: 'bolt', nut: 'nut', rod: 'threaded rod' };
const SIZES = Object.keys(ISO_THREADS).map((s) => [s, threadLabel(s as ThreadSize)] as [string, string]);

/**
 * Where something sits on a face: the clicked object, a base point on its
 * surface, the face direction, and an offset within the face that the arrow
 * keys change. Shared by text on a face and threaded holes.
 */
class FacePlacement {
  obj: SceneObject | null = null;
  private base = new THREE.Vector3();
  normal = new THREE.Vector3(0, 0, 1);
  private tri = 0;
  offset = new THREE.Vector2();

  get placed(): boolean {
    return this.obj !== null;
  }

  /** In-face directions: horizontal "right" and "up", text reads left to right from outside. */
  axes(angleDeg = 0): { x: THREE.Vector3; y: THREE.Vector3 } {
    const n = this.normal;
    const x = Math.abs(n.z) > 0.9
      ? new THREE.Vector3(1, 0, 0).projectOnPlane(n).normalize()
      : new THREE.Vector3(0, 0, 1).cross(n).normalize();
    x.applyAxisAngle(n, THREE.MathUtils.degToRad(angleDeg));
    return { x, y: n.clone().cross(x) };
  }

  point(angleDeg = 0): THREE.Vector3 {
    const { x, y } = this.axes(angleDeg);
    return this.base.clone().addScaledVector(x, this.offset.x).addScaledVector(y, this.offset.y);
  }

  setFromHit(obj: SceneObject, hit: THREE.Intersection): void {
    this.obj = obj;
    this.base.copy(hit.point);
    this.normal.copy(hit.face!.normal).transformDirection(obj.mesh.matrixWorld);
    this.tri = hit.faceIndex ?? 0;
    this.offset.set(0, 0);
  }

  /** Move to the middle of the flat face that was clicked. */
  centre(): void {
    if (!this.obj) return;
    const c = flatFaceCentre(this.obj.data, this.tri);
    this.obj.mesh.updateMatrixWorld();
    this.base.set(...c).applyMatrix4(this.obj.mesh.matrixWorld);
    this.offset.set(0, 0);
  }

  /** Arrow keys nudge within the face: 1 mm with snapping on, 0.1 mm off, Shift ×10. */
  nudge(e: KeyboardEvent): boolean {
    if (!this.obj || !e.key.startsWith('Arrow')) return false;
    const step = (settings.snapping ? 1 : 0.1) * (e.shiftKey ? 10 : 1);
    if (e.key === 'ArrowLeft') this.offset.x -= step;
    if (e.key === 'ArrowRight') this.offset.x += step;
    if (e.key === 'ArrowUp') this.offset.y += step;
    if (e.key === 'ArrowDown') this.offset.y -= step;
    return true;
  }
}

/**
 * Threaded parts (Add object menu) and text on a face (Text button). A
 * threaded hole is placed by clicking a face and is cut into that object on
 * Apply, so no separate cutter object is ever left behind.
 */
export class PartsTools {
  constructor(
    private readonly viewport: Viewport,
    private readonly doc: SceneDocument,
    private readonly bar: FeatureBar,
    private readonly heavy: Heavy,
    private readonly toast: (msg: string) => void,
  ) {
    for (const b of document.querySelectorAll<HTMLElement>('[data-thread]')) {
      b.addEventListener('click', () => {
        const kind = b.dataset.thread as ThreadKind;
        if (kind === 'tap') this.hole();
        else this.part(kind);
      });
    }
    for (const b of document.querySelectorAll('[data-modify="text"]')) b.addEventListener('click', () => this.text());
  }

  /** Clicks on any object's face place `p`; arrow keys nudge it. */
  private capture(p: FacePlacement, onlyObj: SceneObject | null, changed: () => void): void {
    viewClicks.onClick = (e) => {
      const ray = this.viewport.rayAt(e.clientX, e.clientY);
      const targets = onlyObj ? [onlyObj.mesh] : this.doc.objects.map((o) => o.mesh);
      const hit = ray.intersectObjects(targets, false)[0];
      const obj = hit ? this.doc.byMesh(hit.object) : undefined;
      if (!hit?.face || !obj) return;
      p.setFromHit(obj, hit);
      changed();
    };
    viewClicks.onKey = (e) => {
      if (!p.nudge(e)) return false;
      changed();
      return true;
    };
  }

  private release(): void {
    viewClicks.onClick = null;
    viewClicks.onKey = null;
  }

  private setApplyEnabled(enabled: boolean): void {
    const b = document.querySelector<HTMLButtonElement>('#feature-bar [data-feature="apply"]');
    if (b) b.disabled = !enabled;
  }

  // --- Bolts, nuts, rods ---------------------------------------------------------

  private part(kind: Exclude<ThreadKind, 'tap'>): void {
    // Place the new part beside whatever is already there.
    const box = this.doc.objects.length ? this.doc.worldBox(this.doc.objects) : null;
    const x = box ? box.max.x + 20 : 0;
    const place = (p: Piece): [number, number, number] => {
      const b = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(p.mesh.positions, 3));
      return [x, 0, -b.min.z]; // resting on the plate
    };
    this.bar.open<Piece>({
      title: `Add ${KIND_NAMES[kind]}`,
      hint: `${KIND_NAMES[kind][0].toUpperCase()}${KIND_NAMES[kind].slice(1)}: choose the size${kind === 'nut' ? '' : ' and length'}, then Apply.`,
      fields: [
        { key: 'size', label: 'Size', type: 'select', value: 'M6', options: SIZES, tip: 'Metric (M6 = 6 mm) or imperial UNC (1/4″-20 = ¼ inch, 20 threads per inch).' },
        ...(kind !== 'nut' ? [{
          key: 'length', label: 'Length', type: 'number' as const, value: 20, min: 1, step: 1, unit: 'mm',
          tip: kind === 'bolt' ? 'Length of the threaded part under the head.' : 'Length of the thread.',
        }] : []),
        ...(kind === 'nut' ? [{
          key: 'clearance', label: 'Clearance', type: 'number' as const, value: 0.2, min: 0, max: 1, step: 0.05, unit: 'mm',
          tip: 'Extra room all round the thread so a bolt fits. About 0.2 mm suits most FDM printers.',
        }] : []),
      ],
      compute: (v) => runOp('threaded', {
        kind, size: v.size as ThreadSize, length: Number(v.length ?? 0), clearance: Number(v.clearance ?? 0),
      }),
      show: (p) => [previewMesh(p.mesh, place(p))],
      apply: (p, v) => {
        this.doc.checkpoint();
        const obj = this.doc.add(`${threadLabel(v.size as ThreadSize)} ${KIND_NAMES[kind]}`, p.mesh);
        obj.mesh.position.set(...place(p));
        this.doc.setSelection([obj]);
      },
    });
  }

  // --- Threaded hole --------------------------------------------------------------

  private hole(): void {
    const at = new FacePlacement();
    /** Cutter placement: its top sticks 1 mm out of the face so the hole opens cleanly. */
    const transform = (depth: number) => {
      const n = at.normal.clone().normalize();
      const length = depth + 1;
      const centre = at.point().addScaledVector(n, 1 - length / 2);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      return { centre, q, matrix: new THREE.Matrix4().compose(centre, q, new THREE.Vector3(1, 1, 1)) };
    };
    this.bar.open<{ cutter: Piece; depth: number }>({
      title: 'Threaded hole',
      hint: 'Threaded hole: click the face of an object where the hole should go. Arrow keys move it; Apply cuts it.',
      fields: [
        { key: 'size', label: 'Size', type: 'select', value: 'M6', options: SIZES, tip: 'Thread size of the bolt that goes in.' },
        { key: 'depth', label: 'Depth', type: 'number', value: 10, min: 1, step: 1, unit: 'mm', tip: 'How deep the threaded hole goes.' },
        {
          key: 'clearance', label: 'Clearance', type: 'number', value: 0.2, min: 0, max: 1, step: 0.05, unit: 'mm',
          tip: 'Extra room all round so the bolt fits. About 0.2 mm suits most FDM printers.',
        },
        {
          key: 'centre', label: 'Center on face', type: 'button', value: '',
          tip: 'Move the hole to the middle of the flat face you clicked.',
          onClick: () => {
            at.centre();
            this.bar.refresh(0);
          },
        },
      ],
      hide: [],
      compute: async (v) => {
        this.setApplyEnabled(at.placed);
        if (!at.placed) return null;
        const depth = Number(v.depth);
        const cutter = await runOp('threaded', { kind: 'tap', size: v.size as ThreadSize, length: depth + 1, clearance: Number(v.clearance) });
        return { cutter, depth };
      },
      show: ({ cutter, depth }) => {
        const t = transform(depth);
        const m = previewMesh(cutter.mesh, [0, 0, 0]);
        m.position.copy(t.centre);
        m.quaternion.copy(t.q);
        return [m];
      },
      apply: ({ cutter, depth }) => {
        const target = at.obj;
        if (!target) return;
        const t = transform(depth);
        void this.heavy(
          [target],
          () => runOp('boolean', { op: 'difference', items: [this.doc.placed(target), { mesh: cutter.mesh, matrix: t.matrix.elements }] }),
          (r) => {
            if (r.empty) return this.toast('The hole would remove the whole object');
            this.doc.checkpoint();
            this.doc.setData(target, r.mesh);
            target.mesh.position.set(...r.center);
            target.mesh.quaternion.identity();
            target.mesh.scale.set(1, 1, 1);
            this.doc.emit('transform');
          },
        );
      },
      onClose: () => this.release(),
    });
    this.setApplyEnabled(false);
    this.capture(at, null, () => this.bar.refresh(0));
  }

  // --- Text on a face -------------------------------------------------------------

  private text(): void {
    if (this.doc.selection.length !== 1) return this.toast('Select the object to put text on');
    const obj: SceneObject = this.doc.selection[0];
    const at = new FacePlacement();
    const fonts = Object.entries(FONTS).map(([k, f]) => [k, f.label] as [string, string]);

    /** Text plane at the placement: Z = face normal, text upright on vertical faces. */
    const frame = (angleDeg: number): Mat4 => {
      const n = at.normal.clone().normalize();
      const { x, y } = at.axes(angleDeg);
      const o = at.point();
      return [x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, n.x, n.y, n.z, 0, o.x, o.y, o.z, 1];
    };

    this.bar.open<Piece>({
      title: 'Text on a face',
      hint: 'Text: click the face where the text should go. Arrow keys move it; Apply when it looks right.',
      fields: [
        { key: 'text', label: 'Text', type: 'text', value: 'Text', prominent: true, tip: 'The letters to add.' },
        { key: 'font', label: 'Font', type: 'select', value: 'sans', options: fonts, tip: 'Typeface (bold, for clean printing).' },
        { key: 'size', label: 'Size', type: 'number', value: 8, min: 1, step: 1, unit: 'mm', tip: 'Height of capital letters.' },
        { key: 'mode', label: 'Type', type: 'select', value: 'emboss', options: [['emboss', 'Raised (emboss)'], ['deboss', 'Cut in (deboss)']], tip: 'Raise the letters out of the face or cut them into it.' },
        { key: 'depth', label: 'Height', type: 'number', value: 1, min: 0.1, step: 0.2, unit: 'mm', tip: 'How far the letters stand out, or how deep they are cut.' },
        { key: 'angle', label: 'Rotate', type: 'number', value: 0, step: 15, unit: '°', tip: 'Turn the text on the face.' },
        {
          key: 'centre', label: 'Center on face', type: 'button', value: '',
          tip: 'Move the text to the middle of the flat face you clicked.',
          onClick: () => {
            at.centre();
            this.bar.refresh(0);
          },
        },
      ],
      hide: [],
      targets: [obj],
      compute: async (v) => {
        this.setApplyEnabled(at.placed);
        if (!at.placed) return null;
        const text = String(v.text).trim();
        if (!text) return null;
        const font = await loadFont(v.font as FontName);
        const polygons = textOutlines(font, text, Number(v.size));
        return runOp('text', {
          item: this.doc.placed(obj), polygons, depth: Number(v.depth),
          mode: v.mode as 'emboss' | 'deboss', frame: frame(Number(v.angle)),
        });
      },
      show: (p) => [previewMesh(p.mesh, p.center)],
      apply: (p) => {
        if (!this.doc.objects.includes(obj)) return;
        this.doc.checkpoint();
        this.doc.setData(obj, p.mesh);
        obj.mesh.position.set(...p.center);
        obj.mesh.quaternion.identity();
        obj.mesh.scale.set(1, 1, 1);
        this.doc.emit('transform');
      },
      onClose: () => this.release(),
    });
    this.setApplyEnabled(false);
    this.capture(at, obj, () => this.bar.refresh(0));
  }
}
