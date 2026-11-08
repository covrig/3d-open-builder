import * as THREE from 'three';
import type { EdgeSegment, EdgeSet } from '../geometry/edges';
import type { Viewport } from '../scene/viewport';
import { viewClicks } from './interaction';

const PICK_PX = 10;
const COLORS = { idle: 0x8a9bb0, hover: 0xffd166, selected: 0xf2a33a };

/**
 * Shows an object's sharp edges and lets the user click whole edge runs
 * (a cube edge, a hole rim) to select them.
 */
export class EdgePicker {
  private set: EdgeSet | null = null;
  private selected = new Set<number>(); // chain indices
  private hover = -1;
  private chainOf: number[] = [];
  private filter: (s: EdgeSegment) => boolean = () => true;
  private single = false;
  private onChange: () => void = () => {};
  private readonly lines: THREE.LineSegments;
  private colors = new Float32Array(0);

  constructor(private readonly viewport: Viewport) {
    this.lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: true }),
    );
    this.lines.renderOrder = 2;
    this.lines.visible = false;
    viewport.scene.add(this.lines);
  }

  get active(): boolean {
    return this.set !== null;
  }

  /** Selected segments (all segments of every selected chain). */
  get segments(): EdgeSegment[] {
    if (!this.set) return [];
    return [...this.selected].flatMap((c) => this.set!.chains[c].map((i) => this.set!.segments[i]));
  }

  start(set: EdgeSet, opts: { single?: boolean; filter?: (s: EdgeSegment) => boolean; onChange: () => void }): void {
    this.set = set;
    this.selected.clear();
    this.hover = -1;
    this.single = opts.single ?? false;
    this.filter = opts.filter ?? (() => true);
    this.onChange = opts.onChange;
    this.chainOf = [];
    set.chains.forEach((chain, c) => chain.forEach((i) => (this.chainOf[i] = c)));

    const pos = new Float32Array(set.segments.length * 6);
    set.segments.forEach((s, i) => pos.set([...s.a, ...s.b], i * 6));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.colors = new Float32Array(pos.length);
    g.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.lines.geometry.dispose();
    this.lines.geometry = g;
    this.lines.visible = true;
    this.paint();

    viewClicks.onMove = (e) => {
      const h = this.nearestChain(e);
      if (h !== this.hover) {
        this.hover = h;
        this.paint();
      }
    };
    viewClicks.onClick = (e) => {
      const c = this.nearestChain(e);
      if (c < 0) return;
      if (this.selected.has(c)) this.selected.delete(c);
      else {
        if (this.single) this.selected.clear();
        this.selected.add(c);
      }
      this.paint();
      this.onChange();
    };
  }

  stop(): void {
    if (!this.set) return;
    this.set = null;
    this.selected.clear();
    this.lines.visible = false;
    viewClicks.onClick = null;
    viewClicks.onMove = null;
    this.viewport.invalidate();
  }

  /** Chain whose projected segment is nearest the cursor (within a few pixels), or -1. */
  private nearestChain(e: PointerEvent): number {
    if (!this.set) return -1;
    const r = this.viewport.element.getBoundingClientRect();
    const p = new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
    let best = -1;
    let bestD = PICK_PX;
    const a3 = new THREE.Vector3(), b3 = new THREE.Vector3();
    this.set.segments.forEach((s, i) => {
      if (!this.filter(s)) return;
      const a = this.viewport.project(a3.set(...s.a));
      const b = this.viewport.project(b3.set(...s.b));
      const ab = b.clone().sub(a);
      const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
      const d = a.clone().addScaledVector(ab, t).distanceTo(p);
      if (d < bestD) {
        bestD = d;
        best = this.chainOf[i];
      }
    });
    return best;
  }

  private paint(): void {
    if (!this.set) return;
    const set = (i: number, hex: number) => {
      const c = new THREE.Color(hex);
      this.colors.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
    };
    this.set.segments.forEach((s, i) => {
      const c = this.chainOf[i];
      set(i, this.selected.has(c) ? COLORS.selected : c === this.hover ? COLORS.hover : this.filter(s) ? COLORS.idle : 0x4a5563);
    });
    (this.lines.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.viewport.invalidate();
  }
}
