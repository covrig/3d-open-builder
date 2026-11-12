import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { EdgeSegment, EdgeSet } from '../geometry/edges';
import type { Viewport } from '../scene/viewport';
import { viewClicks } from './interaction';

const PICK_PX = 10;
/** Only this many of the nearest candidates get the (costly) hidden-behind-a-surface test. */
const OCCLUSION_TESTS = 6;
const IDLE = 0x8a9bb0;
const UNAVAILABLE = 0x4a5563;
/** Picked edges: blue, which stands out on the orange preview of the result. */
const PICKED = 0x4aa8ff;
/** The edge under the pointer: white on the dark theme, near-black on the light one, so it never blends in. */
const HOVER = { dark: 0xffffff, light: 0x14181e };

/**
 * Shows an object's sharp edges and lets the user click whole edge runs
 * (a cube edge, a hole rim) to select them. All pickable edges are thin
 * lines; the edge under the pointer and the picked ones are drawn thick on
 * top (a WebGL line is always 1 px, so those are "fat" lines), above the
 * orange preview of the result.
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
  private readonly picked: LineSegments2;
  private readonly hovered: LineSegments2;

  constructor(private readonly viewport: Viewport) {
    this.lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      // Always on top: the object itself is hidden while picking, and the
      // result's preview must not cover the edges after the first pick.
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false }),
    );
    this.lines.renderOrder = 10;
    this.lines.visible = false;
    const fat = (width: number, order: number) => {
      const line = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({ linewidth: width, depthTest: false, transparent: true }));
      line.renderOrder = order;
      line.visible = false;
      return line;
    };
    this.picked = fat(3.5, 11);
    this.hovered = fat(5, 12);
    viewport.scene.add(this.lines, this.picked, this.hovered);
    // Fat lines need the view's size in pixels for their width.
    viewport.beforeFrame(() => {
      for (const l of [this.picked, this.hovered]) l.material.resolution.set(viewport.width, viewport.height);
    });
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
    this.lines.visible = this.picked.visible = this.hovered.visible = false;
    viewClicks.onClick = null;
    viewClicks.onMove = null;
    this.viewport.invalidate();
  }

  /** Chain whose projected segment is nearest the cursor (within a few pixels), or -1. */
  private nearestChain(e: PointerEvent): number {
    if (!this.set) return -1;
    const r = this.viewport.element.getBoundingClientRect();
    const p = new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
    const found: { d: number; chain: number; at: THREE.Vector3 }[] = [];
    const a3 = new THREE.Vector3(), b3 = new THREE.Vector3();
    this.set.segments.forEach((s, i) => {
      if (!this.filter(s)) return;
      a3.set(...s.a);
      b3.set(...s.b);
      const a = this.viewport.project(a3);
      const b = this.viewport.project(b3);
      const ab = b.clone().sub(a);
      const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
      const d = a.clone().addScaledVector(ab, t).distanceTo(p);
      // The 3D point is only worked out for candidates in range.
      if (d < PICK_PX) found.push({ d, chain: this.chainOf[i], at: a3.clone().lerp(b3, t) });
    });
    found.sort((x, y) => x.d - y.d);
    // The edges are drawn through the object, but one seen through it must not be picked.
    for (const f of found.slice(0, OCCLUSION_TESTS)) if (this.visible(f.at)) return f.chain;
    return -1;
  }

  /** Is this point seen from the camera, with no surface in front of it? */
  private visible(point: THREE.Vector3): boolean {
    const origin = this.viewport.camera.position;
    const dist = origin.distanceTo(point);
    const ray = new THREE.Raycaster(origin, point.clone().sub(origin).normalize());
    const hit = this.viewport.hitsOn(ray, true)[0];
    // An edge lies on the surface itself, so a hit at its own depth doesn't hide it.
    return !hit || hit.distance >= dist - Math.max(0.05, dist * 0.002);
  }

  /** Put these chains' segments into a fat line (hidden when there are none). */
  private fill(line: LineSegments2, chains: number[], color: number): void {
    const pos: number[] = [];
    for (const c of chains) for (const i of this.set!.chains[c]) pos.push(...this.set!.segments[i].a, ...this.set!.segments[i].b);
    line.visible = pos.length > 0;
    if (!line.visible) return;
    line.geometry.dispose();
    line.geometry = new LineSegmentsGeometry().setPositions(pos);
    line.material.color.setHex(color);
  }

  private paint(): void {
    if (!this.set) return;
    const tint = new THREE.Color();
    this.set.segments.forEach((s, i) => {
      tint.setHex(this.filter(s) ? IDLE : UNAVAILABLE);
      this.colors.set([tint.r, tint.g, tint.b, tint.r, tint.g, tint.b], i * 6);
    });
    (this.lines.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.fill(this.picked, [...this.selected], PICKED);
    this.fill(this.hovered, this.hover >= 0 ? [this.hover] : [], this.viewport.palette.dark ? HOVER.dark : HOVER.light);
    this.viewport.invalidate();
  }
}
