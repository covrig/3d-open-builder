import * as THREE from 'three';
import { applyH, invertH, multiplyH, similarityH, solveH, type H } from '../geometry/homography';
import type { SceneDocument } from '../scene/document';
import type { Viewport } from '../scene/viewport';
import type { FeatureBar } from './featureBar';
import { viewClicks } from './interaction';
import { parseNumber } from './numberInputs';

const GRID = 24; // subdivisions; fine enough that the perspective warp looks straight
const START_WIDTH = 200; // mm, initial picture width
/** Colours of the 1st, 2nd, 3rd and 4th point, as for measurements */
const MARK_COLORS = ['#4cb8ff', '#7ed321', '#c77dff', '#ffb224'];

export interface ReferenceData {
  dataUrl: string;
  width: number;
  height: number;
  /** Picture pixels (u right, v down) → ground millimetres */
  h: H;
  opacity: number;
}

/**
 * A picture lying on the ground to model on top of (a scanned drawing, a
 * photo). It can be moved, turned, faded, scaled from two points with a
 * known distance, or straightened from four corners of a known rectangle.
 *
 * The data is never changed in place (each change makes a new object), so
 * undo snapshots can keep it.
 */
export class ReferenceImage {
  private data: ReferenceData | null = null;
  /** The picture the texture was made from, to skip decoding it again on undo */
  private textureUrl: string | null = null;
  /** Calibrate or Straighten is open */
  private editing = false;
  private opacityRecorded = false;
  private readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly panel = document.querySelector<HTMLElement>('#reference-panel')!;
  private readonly fields = {
    opacity: this.panel.querySelector<HTMLInputElement>('#ref-opacity')!,
    x: this.panel.querySelector<HTMLInputElement>('#ref-x')!,
    y: this.panel.querySelector<HTMLInputElement>('#ref-y')!,
    angle: this.panel.querySelector<HTMLInputElement>('#ref-angle')!,
    scale: this.panel.querySelector<HTMLElement>('#ref-scale')!,
  };

  constructor(
    private readonly viewport: Viewport,
    private readonly doc: SceneDocument,
    private readonly bar: FeatureBar,
    private readonly toast: (msg: string) => void,
    private readonly changed: () => void,
  ) {
    this.mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.mesh.renderOrder = 0;
    this.mesh.visible = false;
    viewport.scene.add(this.mesh);
    viewport.onFrame(() => this.drawMarks());

    const input = document.querySelector<HTMLInputElement>('#reference-input')!;
    document.querySelector('[data-action="reference"]')!.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) void this.load(file);
    });
    // One undo step per slider drag.
    this.fields.opacity.addEventListener('input', () => {
      if (!this.data) return;
      if (!this.opacityRecorded) this.doc.checkpoint();
      this.opacityRecorded = true;
      this.data = { ...this.data, opacity: Number(this.fields.opacity.value) };
      this.mesh.material.opacity = this.data.opacity;
      this.viewport.invalidate();
      this.changed();
    });
    this.fields.opacity.addEventListener('change', () => (this.opacityRecorded = false));
    for (const key of ['x', 'y', 'angle'] as const) {
      this.fields[key].addEventListener('change', () => this.moveTo());
      this.fields[key].addEventListener('keydown', (e) => e.stopPropagation());
    }
    this.panel.querySelector('[data-action="ref-calibrate"]')!.addEventListener('click', () => this.calibrate());
    this.panel.querySelector('[data-action="ref-straighten"]')!.addEventListener('click', () => this.straighten());
    this.panel.querySelector('[data-action="ref-remove"]')!.addEventListener('click', () => this.remove());
    doc.registerUndoExtra('reference', {
      capture: () => this.data,
      restore: (v) => {
        if (v !== this.data) this.set((v as ReferenceData | null) ?? null);
      },
    });
  }

  serialize(): ReferenceData | null {
    return this.data;
  }

  restore(value: unknown): void {
    const d = value as ReferenceData | null | undefined;
    this.set(d && d.dataUrl ? d : null);
  }

  private async load(file: File): Promise<void> {
    if (!file.type.startsWith('image/')) return this.toast('Choose an image file (PNG, JPEG…)');
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    const img = await this.decode(dataUrl);
    const s = START_WIDTH / img.width;
    // Centred on the origin, picture "up" pointing along +Y (v runs down the picture).
    const h: H = [s, 0, (-img.width / 2) * s, 0, -s, (img.height / 2) * s, 0, 0, 1];
    this.doc.transact(() => this.set({ dataUrl, width: img.width, height: img.height, h, opacity: 0.6 }));
    this.toast('Picture added. Use Calibrate to set its real size.');
  }

  private decode(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read that picture'));
      img.src = dataUrl;
    });
  }

  /**
   * Remove the picture (undoable). Measurements made on the plate, which were
   * usually taken on the picture, go with it.
   */
  private remove(): void {
    this.doc.transact(() => {
      this.set(null);
      const onObjects = this.doc.measurements.filter((m) => m.points.every((p) => p.objectId !== undefined));
      if (onObjects.length !== this.doc.measurements.length) this.doc.setMeasurements(onObjects);
    });
  }

  /** Change the mapping (undoable). */
  private setMapping(h: H): void {
    if (!this.data) return;
    const data = this.data;
    this.doc.transact(() => {
      this.data = { ...data, h };
      this.rebuild();
      this.changed();
    });
  }

  private set(data: ReferenceData | null): void {
    this.data = data;
    this.panel.hidden = data === null;
    this.mesh.visible = data !== null;
    // Calibrating a picture that is gone makes no sense.
    if (!data && this.editing) this.bar.close();
    if (data && data.dataUrl === this.textureUrl && this.mesh.material.map) {
      this.mesh.material.opacity = data.opacity;
      this.rebuild();
    } else {
      this.mesh.material.map?.dispose();
      this.mesh.material.map = null;
      this.textureUrl = null;
    }
    if (data && data.dataUrl !== this.textureUrl) {
      void this.decode(data.dataUrl).then((img) => {
        if (this.data?.dataUrl !== data.dataUrl) return; // replaced meanwhile
        const texture = new THREE.Texture(img);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        this.mesh.material.map = texture;
        this.textureUrl = data.dataUrl;
        this.mesh.material.opacity = this.data.opacity;
        this.mesh.material.needsUpdate = true;
        this.rebuild();
      });
    }
    this.changed();
    this.viewport.invalidate();
  }

  /** Lay the picture's grid on the ground through the current mapping. */
  private rebuild(): void {
    const d = this.data;
    if (!d) return;
    const pos = new Float32Array((GRID + 1) * (GRID + 1) * 3);
    const uv = new Float32Array((GRID + 1) * (GRID + 1) * 2);
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        const k = j * (GRID + 1) + i;
        const [x, y] = applyH(d.h, (i / GRID) * d.width, (j / GRID) * d.height);
        pos.set([x, y, 0.03], k * 3);
        uv.set([i / GRID, 1 - j / GRID], k * 2);
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = j * (GRID + 1) + i, b = a + 1, c = a + GRID + 1, e = c + 1;
        idx.push(a, c, b, b, c, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.showFields();
    this.viewport.invalidate();
  }

  private centre(): [number, number] {
    const d = this.data!;
    return applyH(d.h, d.width / 2, d.height / 2);
  }

  /** Current angle of the picture's horizontal direction, in degrees. */
  private angle(): number {
    const d = this.data!;
    const [x0, y0] = applyH(d.h, d.width / 2, d.height / 2);
    const [x1, y1] = applyH(d.h, d.width / 2 + 1, d.height / 2);
    return THREE.MathUtils.radToDeg(Math.atan2(y1 - y0, x1 - x0));
  }

  private showFields(): void {
    const d = this.data!;
    const [cx, cy] = this.centre();
    this.fields.x.value = String(Math.round(cx * 10) / 10);
    this.fields.y.value = String(Math.round(cy * 10) / 10);
    this.fields.angle.value = String(Math.round(this.angle() * 10) / 10);
    this.fields.opacity.value = String(d.opacity);
    const [ax, ay] = applyH(d.h, 0, d.height / 2);
    const [bx, by] = applyH(d.h, d.width, d.height / 2);
    this.fields.scale.textContent = `${Math.round(Math.hypot(bx - ax, by - ay))} mm wide`;
  }

  /** Apply the X / Y / angle fields: shift and turn around the picture centre. */
  private moveTo(): void {
    const d = this.data;
    if (!d) return;
    const [cx, cy] = this.centre();
    // An empty or non-numeric field keeps the picture where it is on that axis.
    const typed = (input: HTMLInputElement, now: number) => {
      const v = parseNumber(input.value);
      return Number.isFinite(v) ? v : now;
    };
    const dx = typed(this.fields.x, cx) - cx, dy = typed(this.fields.y, cy) - cy;
    const turn = THREE.MathUtils.degToRad(typed(this.fields.angle, this.angle()) - this.angle());
    this.setMapping(multiplyH(similarityH(1, turn, cx, cy, dx, dy), d.h));
  }

  /** Point on the ground under the cursor. */
  private groundPoint(e: PointerEvent): [number, number] | null {
    const p = this.viewport.rayAt(e.clientX, e.clientY).ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
    return p ? [p.x, p.y] : null;
  }

  /** Points clicked for Calibrate or Straighten, drawn like measurements as soon as each is placed */
  private marks: { points: [number, number][]; closed: boolean } | null = null;
  private marksSvg: SVGSVGElement | null = null;

  private drawMarks(): void {
    if (!this.marksSvg) {
      this.marksSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.marksSvg.classList.add('measure');
      this.viewport.element.append(this.marksSvg);
    }
    const m = this.marks;
    if (!m) {
      this.marksSvg.innerHTML = '';
      return;
    }
    const s = m.points.map(([x, y]) => this.viewport.project(new THREE.Vector3(x, y, 0)));
    const parts: string[] = [];
    const line = (a: THREE.Vector2, b: THREE.Vector2) => parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`);
    for (let i = 1; i < s.length; i++) line(s[i - 1], s[i]);
    if (m.closed && s.length === 4) line(s[3], s[0]);
    s.forEach((p, i) => parts.push(`<circle class="point" cx="${p.x}" cy="${p.y}" r="4.5" stroke="${MARK_COLORS[i % MARK_COLORS.length]}"/>`));
    this.marksSvg.innerHTML = parts.join('');
  }

  /** Two points with a known distance between them set the picture's scale. */
  private calibrate(): void {
    const d = this.data;
    if (!d) return;
    const points: [number, number][] = [];
    this.bar.open<[number, number][]>({
      title: 'Calibrate picture',
      hint: 'Calibrate: click two points on the picture whose real distance you know, enter it, then Apply.',
      fields: [{ key: 'distance', label: 'Real distance', type: 'number', value: 100, min: 0.1, step: 1, unit: 'mm', tip: 'The true distance between the two points you click.' }],
      compute: async () => (points.length === 2 ? [...points] : null),
      show: () => [],
      apply: (pts, v) => {
        const [[x1, y1], [x2, y2]] = pts;
        const measured = Math.hypot(x2 - x1, y2 - y1);
        if (measured < 1e-6) return this.toast('Pick two different points');
        // Scale about the first point so it stays where it is.
        this.setMapping(multiplyH(similarityH(Number(v.distance) / measured, 0, x1, y1), this.data!.h));
      },
      onClose: () => {
        viewClicks.onClick = null;
        this.editing = false;
        this.marks = null;
        this.viewport.invalidate();
      },
    });
    this.editing = true;
    this.marks = { points, closed: false };
    viewClicks.onClick = (e) => {
      const p = this.groundPoint(e);
      if (!p) return;
      if (points.length === 2) points.length = 0;
      points.push(p);
      this.viewport.invalidate();
      this.bar.refresh(0);
    };
  }

  /** Four corners of a known rectangle remove perspective and skew from a photo. */
  private straighten(): void {
    const d = this.data;
    if (!d) return;
    const points: [number, number][] = [];
    this.bar.open<[number, number][]>({
      title: 'Straighten picture',
      hint: 'Straighten: click the four corners of a rectangle in the picture, in order around it, enter its real size, then Apply.',
      fields: [
        { key: 'width', label: 'Width (1st→2nd)', type: 'number', value: 100, min: 0.1, step: 1, unit: 'mm', tip: 'Real length from the first corner to the second.' },
        { key: 'height', label: 'Height (2nd→3rd)', type: 'number', value: 100, min: 0.1, step: 1, unit: 'mm', tip: 'Real length from the second corner to the third.' },
      ],
      compute: async () => (points.length === 4 ? [...points] : null),
      show: () => [],
      apply: (pts, v) => {
        try {
          // Clicked ground points → picture pixels, then pixels → the true rectangle.
          const inv = invertH(this.data!.h);
          const px = pts.map(([x, y]) => applyH(inv, x, y));
          const [p1, p2, , p4] = pts;
          const ex = new THREE.Vector2(p2[0] - p1[0], p2[1] - p1[1]).normalize();
          let ey = new THREE.Vector2(-ex.y, ex.x);
          if (ey.dot(new THREE.Vector2(p4[0] - p1[0], p4[1] - p1[1])) < 0) ey = ey.negate();
          const W = Number(v.width), Hh = Number(v.height);
          const corner = (a: number, b: number): [number, number] => [p1[0] + ex.x * a + ey.x * b, p1[1] + ex.y * a + ey.y * b];
          this.setMapping(solveH(px, [corner(0, 0), corner(W, 0), corner(W, Hh), corner(0, Hh)]));
        } catch (err) {
          this.toast(err instanceof Error ? err.message : String(err));
        }
      },
      onClose: () => {
        viewClicks.onClick = null;
        this.editing = false;
        this.marks = null;
        this.viewport.invalidate();
      },
    });
    this.editing = true;
    this.marks = { points, closed: true };
    viewClicks.onClick = (e) => {
      const p = this.groundPoint(e);
      if (!p) return;
      if (points.length === 4) points.length = 0;
      points.push(p);
      this.viewport.invalidate();
      this.bar.refresh(0);
    };
  }
}
