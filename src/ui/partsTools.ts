import type { Mat4 } from 'manifold-3d';
import * as THREE from 'three';
import type { Piece } from '../geometry/cut';
import type { MeshData } from '../geometry/meshData';
import { flatFaceCentre } from '../geometry/faceRegion';
import { FONTS, loadFont, textOutlines, type FontName } from '../geometry/text';
import { ISO_THREADS, threadLabel, type ThreadKind, type ThreadSize } from '../geometry/threads';
import { runOp } from '../geometry/workerClient';
import { buildGeometry, type SceneDocument, type SceneObject } from '../scene/document';
import type { Viewport } from '../scene/viewport';
import { settings } from '../settings';
import { previewMesh, type FeatureBar, type Values } from './featureBar';
import { viewClicks } from './interaction';

const KIND_NAMES: Record<Exclude<ThreadKind, 'tap'>, string> = { bolt: 'bolt', nut: 'nut', rod: 'thread' };
/** The letters while the text is being placed: strong blue, drawn just in front of the surface they sit on. */
const letterMaterial = new THREE.MeshStandardMaterial({
  color: 0x4aa8ff, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});
const SIZES = Object.keys(ISO_THREADS).map((s) => [s, threadLabel(s as ThreadSize)] as [string, string]);

/**
 * Where something sits on a face: the clicked object, a base point on its
 * surface, the face direction, and an offset within the face that the arrow
 * keys change. Used by text on a face.
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
 * Threaded parts (Add object menu) and text on a face (Text button). A thread
 * for a hole is added as an object like the others; Subtract cuts it out.
 */
export class PartsTools {
  constructor(
    private readonly viewport: Viewport,
    private readonly doc: SceneDocument,
    private readonly bar: FeatureBar,
    private readonly toast: (msg: string) => void,
  ) {
    for (const b of document.querySelectorAll<HTMLElement>('[data-thread]')) {
      b.addEventListener('click', () => this.part(b.dataset.thread as Exclude<ThreadKind, 'tap'>));
    }
    for (const b of document.querySelectorAll('[data-modify="text"]')) b.addEventListener('click', () => this.text());
  }

  /** Clicks on an object's face place `p`; arrow keys nudge it. */
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

  // --- Bolts, nuts, threads ------------------------------------------------------

  private part(kind: Exclude<ThreadKind, 'tap'>): void {
    // Place the new part beside whatever is already there.
    const box = this.doc.objects.length ? this.doc.worldBox(this.doc.objects) : null;
    const x = box ? box.max.x + 20 : 0;
    const place = (p: Piece): [number, number, number] => {
      const b = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(p.mesh.positions, 3));
      return [x, 0, -b.min.z]; // resting on the plate
    };
    /** A thread can be made as a cutter for a hole ("For a hole"): it is then built as kind 'tap', with clearance. */
    const forHole = (v: Values) => kind === 'rod' && v.hole === true;
    const clearanceOf = (v: Values) => (kind === 'nut' || forHole(v) ? Number(v.clearance ?? 0) : 0);
    this.bar.open<Piece>({
      focusFirst: true,
      title: `Add ${KIND_NAMES[kind]}`,
      hint: kind === 'rod'
        ? 'Thread: choose the size and length, then Apply. To make a threaded hole, tick "For a hole", place the thread where the hole should go, select it and press Subtract.'
        : `${KIND_NAMES[kind][0].toUpperCase()}${KIND_NAMES[kind].slice(1)}: choose the size${kind === 'nut' ? '' : ' and length'}, then Apply.`,
      fields: [
        { key: 'size', label: 'Size', type: 'select', value: 'M6', options: SIZES, tip: 'Metric (M6 = 6 mm) or imperial UNC (1/4″-20 = ¼ inch, 20 threads per inch).' },
        ...(kind !== 'nut' ? [{
          key: 'length', label: 'Length', type: 'number' as const, value: 20, min: 1, step: 1, unit: 'mm',
          tip: kind === 'bolt' ? 'Length of the threaded part under the head.' : 'Length of the thread.',
        }] : []),
        ...(kind === 'rod' ? [{
          key: 'hole', label: 'For a hole', type: 'checkbox' as const, value: false,
          tip: 'Make a thread to cut a threaded hole: place it where the hole should go, then select it and press Subtract. It is a little wider, so a bolt fits.',
        }] : []),
        ...(kind === 'nut' || kind === 'rod' ? [{
          key: 'clearance', label: 'Clearance', type: 'number' as const, value: 0.2, min: 0, max: 1, step: 0.05, unit: 'mm',
          tip: 'Extra room all round the thread so a bolt fits. About 0.2 mm suits most FDM printers.',
          ...(kind === 'rod' ? { showIf: ['hole', 'true'] as [string, string] } : {}),
        }] : []),
      ],
      compute: (v) => runOp('threaded', {
        kind: forHole(v) ? 'tap' : kind, size: v.size as ThreadSize, length: Number(v.length ?? 0), clearance: clearanceOf(v),
      }),
      show: (p) => [previewMesh(p.mesh, place(p))],
      apply: (p, v) => {
        this.doc.checkpoint();
        const label = threadLabel(v.size as ThreadSize);
        const obj = this.doc.add(forHole(v) ? `${label} thread for a hole` : `${label} ${KIND_NAMES[kind]}`, p.mesh);
        // Remember how it was made, so Shell can hollow it from a plain stand-in.
        // (A thread for a hole is only a cutter, not a solid to hollow, so it gets none.)
        if (!forHole(v)) {
          obj.thread = { kind, size: v.size as ThreadSize, length: Number(v.length ?? 0), clearance: clearanceOf(v), origin: p.center };
        }
        obj.mesh.position.set(...place(p));
        this.doc.setSelection([obj]);
      },
    });
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

    this.bar.open<Piece & { letters: MeshData }>({
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
      show: (p) => {
        const shown = [previewMesh(p.mesh, p.center)];
        // The letters in strong colour on top of the ghost (their data is already in world space).
        if (p.letters.indices.length) shown.push(new THREE.Mesh(buildGeometry(p.letters), letterMaterial));
        return shown;
      },
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
