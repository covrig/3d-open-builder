import * as THREE from 'three';
import { edgeFeatures, type EdgeFeatures } from '../geometry/edgeMiddles';
import { runOp } from '../geometry/workerClient';
import { overlapMaterial, type SceneDocument } from '../scene/document';
import type { Viewport } from '../scene/viewport';

/** Overlap lines in world space, for measuring: segments, plus their corners and middles. */
export interface OverlapFeatures extends EdgeFeatures {
  segs: Float32Array;
}

/**
 * Faint lines where the surfaces of overlapping objects cross (two cubes
 * pushed into each other). Drawn in the Edges view whatever the look (X-ray,
 * wireframe), very faint in X-ray without Edges, and used as measuring snap
 * targets. They are worked out in the geometry worker once objects stop
 * changing; while they move, the old lines are hidden instead of hanging in
 * the air.
 */
export class OverlapLines {
  private readonly lines = new THREE.LineSegments(new THREE.BufferGeometry(), overlapMaterial);
  private found: OverlapFeatures | null = null;
  private timer: number | undefined;
  /** Bumped on every change, so a calculation that is out of date is dropped. */
  private run = 0;

  constructor(
    private readonly viewport: Viewport,
    private readonly doc: SceneDocument,
    /** How strongly to draw them (0: not at all), and whether to offer them to measuring. */
    private readonly wanted: () => { opacity: number; snap: boolean },
    /** True while a tool with Apply/Cancel is open: its previews come first. */
    private readonly paused: () => boolean,
  ) {
    this.lines.raycast = () => {};
    this.lines.renderOrder = 1; // after the objects, so X-ray doesn't wash them out
    this.lines.visible = false;
    viewport.scene.add(this.lines);
    for (const type of ['change', 'transform', 'history'] as const) doc.addEventListener(type, () => this.refresh());
  }

  /** The current lines for measuring snaps (null while they are being worked out). */
  get features(): OverlapFeatures | null {
    return this.wanted().snap ? this.found : null;
  }

  /** Work the lines out again soon (objects changed, the Edges view or a tool switched). */
  refresh(): void {
    this.run++;
    this.found = null;
    this.lines.visible = false;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.compute(), 350);
    this.viewport.invalidate();
  }

  private async compute(): Promise<void> {
    const want = this.wanted();
    const objs = this.doc.objects.filter((o) => !o.hidden);
    if ((!want.opacity && !want.snap) || objs.length < 2 || this.paused()) return;
    const run = this.run;
    let segs: Float32Array;
    try {
      segs = await runOp('overlaps', { items: objs.map((o) => this.doc.placed(o)) }, true);
    } catch {
      return; // stopped (Cancel stops every calculation) or failed: no lines until the next change
    }
    if (run !== this.run) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(segs, 3));
    this.lines.geometry.dispose();
    this.lines.geometry = g;
    this.lines.computeLineDistances(); // the dashes need the length along each segment
    this.found = { segs, ...edgeFeatures(segs) };
    const { opacity } = this.wanted();
    overlapMaterial.opacity = opacity;
    this.lines.visible = opacity > 0 && segs.length > 0;
    this.viewport.invalidate();
  }
}
