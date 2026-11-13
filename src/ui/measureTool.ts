import * as THREE from 'three';
import type { MeasureKind, MeasurePoint, SceneDocument } from '../scene/document';
import type { Viewport } from '../scene/viewport';
import { settings, toUnit, updateUi } from '../settings';
import { hideHint, showHint } from './hint';
import { beginTool, endTool } from './toolLock';
import { hoverMarker, SNAP_PX, SnapPicker, type Picked, type SnapKind } from './snapPicker';

const POINTS_NEEDED: Record<MeasureKind, number> = { distance: 2, angle: 3, circle: 3 };
const HINTS: Record<MeasureKind, string> = {
  distance: 'Distance: click two points on the model. With X-ray on, hidden corners and edges can be picked too. Click Distance again to stop.',
  angle: 'Angle: click the start, the corner, then the end, all on the model. With X-ray on, hidden corners and edges can be picked too. Click Angle again to stop.',
  circle: 'Circle: click three points on the model, on the edge of a circle or hole. With X-ray on, hidden corners and edges can be picked too. Click Circle again to stop.',
};
/** Colours of the 1st, 2nd and 3rd point. */
const POINT_COLORS = ['#4cb8ff', '#7ed321', '#c77dff'];
/**
 * Touch: the point being aimed at is the one under the finger, and a loupe
 * (a zoomed copy of the view around the finger) floats above it so the finger
 * doesn't hide what it aims at.
 */
const LOUPE_PX = 104;
const LOUPE_ZOOM = 2.5;
/** Distance from the finger to the loupe's centre (px) */
const LOUPE_GAP = 88;
/** A finger is less exact than a mouse: snaps reach this much further (factor on the mouse's radius). */
const TOUCH_SNAP_FACTOR = 1.5;
/** Gap kept between two labels (px). */
const LABEL_GAP = 3;
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

/** One measurement label waiting to be placed so that it doesn't cover another. */
interface LabelSpec {
  x: number;
  y: number;
  main: string;
  sub?: string;
  /** Unit direction (screen) the label may slide along, and how far (px) */
  dir: THREE.Vector2;
  slide: number;
}

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Measuring on the model: distances, angles and circle diameters. Points are
 * picked on objects only and drawn over the view. While a tool is
 * active, clicks in the view place points instead of selecting.
 */
export class MeasureTool {
  private kind: MeasureKind | null = null;
  private pending: MeasurePoint[] = [];
  private hover: MeasurePoint | null = null;
  /** What the point under the cursor snapped to (null: not snapped) */
  private hoverSnap: SnapKind | null = null;
  /** The hovered point lies behind a surface (X-ray) */
  private hoverHidden = false;
  /** Snapping to the model, shared with other tools that pick points */
  private readonly picker: SnapPicker;
  /** Remembered between visits (saved with the other UI choices). */
  private readonly options = settings.ui.measure;
  private readonly svg: SVGSVGElement;
  private readonly labels: HTMLElement;
  /**
   * The point under the cursor (marker, its dot and tag) lives in layers of its own: a mouse
   * move redraws only these, without the 3D scene and without rebuilding the measurements.
   */
  private readonly hoverSvg: SVGSVGElement;
  private readonly hoverTag: HTMLElement;
  /** What the layers hold now, so unchanged content is not written (and laid out) again */
  private svgHtml = '';
  private hoverHtml = '';
  private tagHtml = '';
  private labelKey = '';
  /** Mouse: the latest position, picked once per animation frame (a mouse reports faster than the screen refreshes) */
  private moveAt: { x: number; y: number } | null = null;
  private moveFrame = 0;
  /** Floating "Place / discard" chip next to the candidate point of a touch */
  private readonly chip: HTMLElement;
  /** True while the last pointer over the view was a finger */
  private touchPointer = false;
  /** Touch: the aimed point waiting for the tick (the finger has lifted) */
  private candidate: Picked | null = null;
  /** The loupe shown above a finger that is aiming, and the canvas inside it that gets the zoomed copy of the view */
  private readonly loupe: HTMLElement;
  private readonly loupeCanvas: HTMLCanvasElement;
  private readonly loupeSnap: HTMLElement;
  /** Where the aiming finger is (client coordinates), null when no finger is down */
  private finger: { x: number; y: number } | null = null;
  /** Fingers now on the view; with two or more it is a camera gesture, not aiming */
  private readonly fingers = new Set<number>();
  private gesture = false;
  /** The orbit controls' touch settings, put back when measuring stops */
  private savedTouches: { ONE?: THREE.TOUCH | null; TWO?: THREE.TOUCH | null } | null = null;

  constructor(
    private readonly viewport: Viewport,
    private readonly doc: SceneDocument,
    private readonly toast: (msg: string) => void,
  ) {
    this.picker = new SnapPicker(viewport, doc);
    this.picker.snapOn = () => this.options.snap;
    this.picker.known = () => [...this.doc.measurements.flatMap((m) => m.points), ...this.pending];
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('measure');
    this.svg.classList.toggle('dotted', this.options.dotted);
    this.labels = document.createElement('div');
    this.labels.className = 'measure-labels';
    this.hoverSvg = document.createElementNS(SVG_NS, 'svg');
    this.hoverSvg.classList.add('measure');
    this.hoverTag = document.createElement('div');
    this.hoverTag.className = 'measure-labels';
    this.chip = document.createElement('div');
    this.chip.className = 'm-chip';
    this.chip.hidden = true;
    this.chip.innerHTML =
      '<button type="button" data-ok aria-label="Place the point">✓ Place</button><button type="button" data-no aria-label="Discard the point">✕</button>';
    this.chip.querySelector('[data-ok]')!.addEventListener('click', () => {
      const c = this.candidate;
      this.candidate = null;
      if (c) this.place(c.point);
    });
    this.chip.querySelector('[data-no]')!.addEventListener('click', () => {
      this.candidate = null;
      this.viewport.invalidate();
    });
    this.loupe = document.createElement('div');
    this.loupe.className = 'measure-loupe';
    this.loupe.hidden = true;
    this.loupeCanvas = document.createElement('canvas');
    // What the aimed point snapped to, along the bubble's bottom: a tag next to the point would sit under the finger.
    this.loupeSnap = document.createElement('div');
    this.loupeSnap.className = 'loupe-snap';
    this.loupeSnap.hidden = true;
    this.loupe.append(this.loupeCanvas, this.loupeSnap);
    viewport.element.append(this.svg, this.labels, this.hoverSvg, this.hoverTag, this.chip, this.loupe);
    viewport.onFrame(() => this.draw());

    // Which kind of pointer is over the view (main.ts passes plain coordinates), so a
    // finger can aim above itself. These run before main.ts's own handlers.
    const canvas = viewport.renderer.domElement;
    const track = (e: PointerEvent) => {
      this.touchPointer = e.pointerType === 'touch';
      if (this.touchPointer) this.finger = { x: e.clientX, y: e.clientY };
    };
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        track(e);
        if (!this.touchPointer || !this.kind) return;
        this.fingers.add(e.pointerId);
        if (this.fingers.size > 1) {
          // A second finger: pinch or two-finger pan of the camera, nothing is aimed.
          this.gesture = true;
          this.cancelMove();
          this.hover = null;
          this.hoverSnap = null;
          this.finger = null;
          this.viewport.invalidate();
          return;
        }
        this.move(e.clientX, e.clientY);
      },
      { passive: true },
    );
    canvas.addEventListener('pointermove', track, { passive: true });
    for (const type of ['pointerup', 'pointercancel'] as const) {
      canvas.addEventListener(
        type,
        (e) => {
          if (e.pointerType !== 'touch') return;
          // The finger is up: the point under it becomes the candidate (the chip asks to
          // place it). Done here, not in click(), because aiming is a drag, which click ignores.
          this.fingers.delete(e.pointerId);
          const aimed = this.kind && !this.gesture && type === 'pointerup';
          if (this.fingers.size === 0) this.gesture = false;
          this.finger = null;
          this.hover = null;
          this.hoverSnap = null;
          if (aimed) {
            const picked = this.pickPoint(e.clientX, e.clientY);
            if (picked) this.candidate = picked;
          }
          this.viewport.invalidate();
        },
        { passive: true },
      );
    }

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
    // Touch screens: icon buttons under the hint change the measuring type or stop it while the panel is closed (see the stylesheet).
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-measure-quick]')) {
      b.addEventListener('click', () => {
        const what = b.dataset.measureQuick!;
        if (what !== 'stop' && this.kind === what) return;
        this.setKind(what === 'stop' ? null : (what as MeasureKind));
      });
    }
  }

  get active(): boolean {
    return this.kind !== null;
  }

  setKind(kind: MeasureKind | null): void {
    // Light tool: measuring locks nothing else (it even works with the cross-section on).
    if (kind) beginTool('measure', () => this.setKind(null), false);
    else endTool('measure');
    this.kind = kind;
    // A finger on the view aims the point instead of turning the camera (two fingers still
    // zoom and pan); put back when measuring stops. The mouse buttons are not affected.
    const touches = this.viewport.orbit.touches;
    if (kind && !this.savedTouches) {
      this.savedTouches = { ...touches };
      touches.ONE = null;
    } else if (!kind && this.savedTouches) {
      Object.assign(touches, this.savedTouches);
      this.savedTouches = null;
    }
    this.cancelMove();
    this.fingers.clear();
    this.gesture = false;
    this.finger = null;
    this.pending = [];
    this.hover = null;
    this.hoverSnap = null;
    this.candidate = null;
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-measure]')) {
      b.classList.toggle('active', b.dataset.measure === kind);
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-measure-quick]')) {
      b.classList.toggle('active', b.dataset.measureQuick === kind);
    }
    this.viewport.element.classList.toggle('measuring', kind !== null);
    if (kind) showHint('measure', HINTS[kind]);
    else hideHint('measure');
    this.viewport.invalidate();
  }

  /** Remove all measurements (undoable). */
  clear(): void {
    this.pending = [];
    this.candidate = null;
    if (this.doc.measurements.length === 0) return this.viewport.invalidate();
    this.doc.transact(() => this.doc.setMeasurements([]));
  }

  /** A click in the view while measuring. A finger is handled when it lifts (see the constructor): it only proposes the point (see the chip). */
  click(clientX: number, clientY: number): void {
    if (!this.kind || this.touchPointer) return;
    const picked = this.pickPoint(clientX, clientY);
    if (!picked) return;
    this.place(picked.point);
  }

  /** Put a point down: the next point of the measurement being made, which completes when it has enough. */
  private place(p: MeasurePoint): void {
    if (!this.kind) return;
    this.candidate = null;
    this.cancelMove();
    this.pending.push(p);
    // Placed: the point goes back to its normal look until the mouse moves again.
    this.hover = null;
    this.hoverSnap = null;
    if (this.pending.length === POINTS_NEEDED[this.kind]) {
      const w = this.pending.map((q) => this.world(q)!);
      if (this.kind === 'circle' && !circleThrough(w[0], w[1], w[2])) {
        this.toast('Those three points are in a line; pick points around the circle');
      } else {
        const kind = this.kind;
        const points = this.pending;
        this.doc.transact(() => this.doc.setMeasurements([...this.doc.measurements, { kind, points }]));
      }
      this.pending = [];
    }
    this.viewport.invalidate();
  }

  move(clientX: number, clientY: number): void {
    if (!this.kind || this.gesture) return;
    if (this.touchPointer) {
      // The loupe copies the WebGL canvas, which needs a fresh 3D frame (see drawLoupe).
      this.cancelMove();
      this.setHover(this.pickPoint(clientX, clientY));
      this.viewport.invalidate();
      return;
    }
    // A mouse reports more often than the screen refreshes: pick once per frame, at the latest position.
    this.moveAt = { x: clientX, y: clientY };
    if (this.moveFrame) return;
    this.moveFrame = requestAnimationFrame(() => {
      this.moveFrame = 0;
      const at = this.moveAt;
      this.moveAt = null;
      if (!at || !this.kind || this.gesture) return;
      this.setHover(this.pickPoint(at.x, at.y));
      // Nothing in the 3D view changes when the cursor moves, so no new frame is drawn:
      // only the overlay. With points pending, the line to the cursor (and its label) must follow too.
      if (this.pending.length === 0 && !this.candidate) this.drawHover();
      else this.draw();
    });
  }

  private setHover(picked: Picked | null): void {
    this.hover = picked?.point ?? null;
    this.hoverSnap = picked?.snap ?? null;
    this.hoverHidden = picked?.hidden ?? false;
  }

  /** Forget a mouse move that is waiting for its frame (the state it would apply to has changed). */
  private cancelMove(): void {
    if (this.moveFrame) cancelAnimationFrame(this.moveFrame);
    this.moveFrame = 0;
    this.moveAt = null;
  }

  /** What the cursor (or, for touch, the waiting candidate) points at, if anything. */
  private aimed(): { point: MeasurePoint; snap: SnapKind | null; hidden: boolean } | null {
    if (!this.kind) return null;
    if (this.hover) return { point: this.hover, snap: this.hoverSnap, hidden: this.hoverHidden };
    const c = this.candidate;
    return c ? { point: c.point, snap: c.snap, hidden: c.hidden } : null;
  }

  /** World position of a point, or null if its object no longer exists. Older files may hold points on the plate (no object). */
  private world(p: MeasurePoint): THREE.Vector3 | null {
    return this.picker.world(p);
  }

  /** The cross-section, when on: measuring then works on what is still shown and on the cut. */
  set section(value: SnapPicker['section']) {
    this.picker.section = value;
  }
  /** Lines where overlapping objects cross (world space), also snap targets. */
  set overlaps(value: SnapPicker['overlaps']) {
    this.picker.overlaps = value;
  }

  private pickPoint(clientX: number, clientY: number): Picked | null {
    this.picker.snapPx = SNAP_PX * (this.touchPointer ? TOUCH_SNAP_FACTOR : 1);
    return this.picker.pick(clientX, clientY);
  }

  // --- Drawing ------------------------------------------------------------

  private draw(): void {
    const svg: string[] = [];
    const specs: LabelSpec[] = [];
    const P = (v: THREE.Vector3) => this.viewport.project(v);
    const num = (mm: number) => (Math.round(toUnit(mm) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const unit = settings.unit;
    const line = (a: THREE.Vector3, b: THREE.Vector3) => {
      const pa = P(a), pb = P(b);
      svg.push(`<line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}"/>`);
    };
    const dot = (v: THREE.Vector3, i: number) => {
      const p = P(v);
      svg.push(`<circle class="point" cx="${p.x}" cy="${p.y}" r="4.5" stroke="${POINT_COLORS[i % 3]}"/>`);
    };
    /** A label at a screen point; `dir` and `slide` say where it may move to if it would cover another label. */
    const label = (at: THREE.Vector2, dir: THREE.Vector2, slide: number, main: string, sub?: string) => {
      specs.push({ x: at.x, y: at.y, main, sub, dir, slide });
    };

    const render = (kind: MeasureKind, pts: THREE.Vector3[]) => {
      if (kind === 'distance' && pts.length === 2) {
        line(pts[0], pts[1]);
        const d = pts[1].clone().sub(pts[0]);
        const pa = P(pts[0]), pb = P(pts[1]);
        const len = pa.distanceTo(pb);
        label(
          pa.clone().lerp(pb, 0.5),
          // Slides along its own line, up to 40% of its length on screen.
          len > 1 ? pb.clone().sub(pa).divideScalar(len) : new THREE.Vector2(1, 0),
          len * 0.4,
          `${num(d.length())} ${unit}`,
          // Sizes along each axis: always positive, whichever point was picked first.
          this.options.deltas ? `ΔX ${num(Math.abs(d.x))}   ΔY ${num(Math.abs(d.y))}   ΔZ ${num(Math.abs(d.z))}` : undefined,
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
            const at = P(pts[1].clone().addScaledVector(bisector, r * 1.6));
            // Moves out along the line from the corner through its anchor.
            const out = at.clone().sub(P(pts[1]));
            label(
              at,
              out.length() > 1 ? out.normalize() : new THREE.Vector2(0, -1),
              60,
              `${(Math.round(THREE.MathUtils.radToDeg(angle) * 10) / 10).toLocaleString()}°`,
            );
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
          // The radius is exactly half the diameter shown (both rounded the same way would
          // disagree, e.g. Ø 10.01 with R 5.01): up to one more decimal.
          const d = Math.round(toUnit(c.radius * 2) * 100) / 100;
          const half = (d / 2).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 3 });
          label(P(c.center), new THREE.Vector2(0, -1), 60, `Ø ${num(c.radius * 2)} ${unit}  ·  R ${half} ${unit}`);
        }
      }
      pts.forEach(dot);
    };

    // Measurements on a deleted object are hidden (undo brings both back).
    for (const m of this.doc.measurements) {
      const pts = m.points.map((p) => this.world(p));
      if (pts.every((p) => p !== null)) render(m.kind, pts);
    }
    // A touch candidate whose object is gone is dropped.
    if (this.candidate && !this.world(this.candidate.point)) this.candidate = null;
    let chipAt: THREE.Vector2 | null = null;
    if (this.kind) {
      // The aimed point with no points pending is drawn by drawHover (it is all that changes while the mouse moves).
      const aimed = this.aimed();
      const pending = [...this.pending, ...(aimed && this.pending.length ? [aimed.point] : [])]
        .map((p) => this.world(p))
        .filter((p) => p !== null);
      render(this.kind, pending);
      const h = aimed && !this.hover ? this.world(aimed.point) : null;
      if (h) chipAt = P(h);
    }
    const html = svg.join('');
    if (html !== this.svgHtml) {
      this.svgHtml = html;
      this.svg.innerHTML = html;
    }
    this.drawHover();
    this.drawLoupe();

    // Labels: put them in, measure them, then move any that would cover another. Only when
    // they changed: this reads sizes back, which makes the browser lay out the page.
    const key = specs.map((s) => `${s.x}|${s.y}|${s.main}|${s.sub ?? ''}|${s.dir.x}|${s.dir.y}|${s.slide}`).join('\n');
    if (key !== this.labelKey) {
      this.labelKey = key;
      this.labels.innerHTML = specs
        .map(
          (s, i) =>
            `<div class="m-label" data-i="${i}"><div class="m-main">${escapeHtml(s.main)}</div>${
              s.sub ? `<div class="m-sub">${escapeHtml(s.sub)}</div>` : ''
            }</div>`,
        )
        .join('');
      if (specs.length) this.placeLabels(specs);
    }

    // The place / discard chip above the candidate (above, because the finger is below it).
    this.chip.hidden = !chipAt;
    if (chipAt) {
      const w = this.chip.offsetWidth, h = this.chip.offsetHeight;
      const x = Math.min(Math.max(chipAt.x, w / 2 + 4), Math.max(w / 2 + 4, this.viewport.element.clientWidth - w / 2 - 4));
      this.chip.style.left = `${x}px`;
      this.chip.style.top = `${Math.max(chipAt.y - 34, h + 4)}px`;
    }
  }

  /**
   * The marker of the point under the cursor with its tag, in their own layers. The snap
   * marker takes the cursor's place, so the crosshair is hidden only while the point under it snapped.
   * Set here, which every reset of the hover (and stopping) redraws through, so it can't get stuck.
   */
  private drawHover(): void {
    this.viewport.element.classList.toggle('snapped', this.kind !== null && this.hoverSnap !== null);
    let marker = '';
    let tag = '';
    let loupeText = '';
    const aimed = this.aimed();
    const at = aimed ? this.world(aimed.point) : null;
    if (aimed && at) {
      const p = this.viewport.project(at);
      // A snapped point lights up and says what it caught, so a point that only
      // looks right from this angle isn't placed by mistake.
      const m = hoverMarker(p, aimed.snap, aimed.hidden);
      // With points pending the aimed point is one of them, drawn with them by draw().
      const dot = this.pending.length ? '' : `<circle class="point" cx="${p.x}" cy="${p.y}" r="4.5" stroke="${POINT_COLORS[0]}"/>`;
      marker = dot + m.svg;
      // While a finger is aiming, the words go in the loupe instead (the finger covers the point).
      if (this.touchPointer && this.finger) loupeText = m.tag.replace(/<[^>]*>/g, '');
      else tag = m.tag;
    }
    this.loupeSnap.textContent = loupeText;
    this.loupeSnap.hidden = !loupeText;
    if (marker !== this.hoverHtml) {
      this.hoverHtml = marker;
      this.hoverSvg.innerHTML = marker;
    }
    if (tag !== this.tagHtml) {
      this.tagHtml = tag;
      this.hoverTag.innerHTML = tag;
    }
  }

  /**
   * The loupe above the aiming finger: a zoomed copy of the view around it, with a
   * crosshair on the aimed point. Copied from the WebGL canvas, which only keeps its
   * picture until the frame is composited, so this must run in the same task as the
   * render: draw() is called right after it.
   */
  private drawLoupe(): void {
    const finger = this.finger;
    this.loupe.hidden = !this.kind || !finger;
    if (!this.kind || !finger) return;
    const view = this.viewport.element.getBoundingClientRect();
    const fx = finger.x - view.left, fy = finger.y - view.top;
    // Above the finger; below it when that would leave the view; kept inside the view.
    const half = LOUPE_PX / 2;
    const cx = Math.min(Math.max(fx, half + 2), Math.max(half + 2, view.width - half - 2));
    let cy = fy - LOUPE_GAP;
    if (cy - half < 0) cy = fy + LOUPE_GAP;
    cy = Math.min(Math.max(cy, half + 2), Math.max(half + 2, view.height - half - 2));
    this.loupe.style.left = `${cx}px`;
    this.loupe.style.top = `${cy}px`;

    const gl = this.viewport.renderer.domElement;
    const ratio = gl.width / Math.max(1, view.width);
    const size = Math.round(LOUPE_PX * Math.min(window.devicePixelRatio, 2));
    if (this.loupeCanvas.width !== size) this.loupeCanvas.width = this.loupeCanvas.height = size;
    const ctx = this.loupeCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    // The area LOUPE_PX / zoom wide around the finger, in the WebGL canvas's own pixels.
    const src = (LOUPE_PX / LOUPE_ZOOM) * ratio;
    ctx.drawImage(gl, fx * ratio - src / 2, fy * ratio - src / 2, src, src, 0, 0, size, size);
    // Crosshair on the aimed point: dark under light so it shows on any background.
    const mid = size / 2, arm = size * 0.14;
    for (const [colour, extra] of [['rgba(0,0,0,0.85)', 1.5], ['#fff', 0]] as const) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = Math.max(1, size / 100) + extra;
      ctx.beginPath();
      ctx.moveTo(mid - arm, mid); ctx.lineTo(mid + arm, mid);
      ctx.moveTo(mid, mid - arm); ctx.lineTo(mid, mid + arm);
      ctx.stroke();
    }
  }

  /**
   * Position the labels in the layer so that no two overlap, each as close to its
   * anchor as it can be: first the anchor itself, then sliding along its own
   * line (both ways), then stepping aside from that line (both sides, further
   * and further). The order of the labels is stable, so they don't jump around.
   */
  private placeLabels(specs: LabelSpec[]): void {
    const els = this.labels.querySelectorAll<HTMLElement>('.m-label');
    const sizes = Array.from(els, (el) => [el.offsetWidth, el.offsetHeight] as const);
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const STEP = 8;
    specs.forEach((s, i) => {
      const [w, h] = sizes[i];
      const free = (x: number, y: number) =>
        placed.every((b) => Math.abs(x - b.x) >= (w + b.w) / 2 + LABEL_GAP || Math.abs(y - b.y) >= (h + b.h) / 2 + LABEL_GAP);
      const slides = [0];
      for (let t = STEP; t <= s.slide; t += STEP) slides.push(t, -t);
      const sides = [0];
      for (let k = 1; k <= 6; k++) sides.push(k * (h * 0.8 + LABEL_GAP), -k * (h * 0.8 + LABEL_GAP));
      let spot = { x: s.x, y: s.y };
      search: for (const side of sides) {
        for (const t of slides) {
          const x = s.x + s.dir.x * t - s.dir.y * side;
          const y = s.y + s.dir.y * t + s.dir.x * side;
          if (free(x, y)) {
            spot = { x, y };
            break search;
          }
        }
      }
      placed.push({ ...spot, w, h });
      els[i].style.left = `${spot.x}px`;
      els[i].style.top = `${spot.y}px`;
    });
  }
}
