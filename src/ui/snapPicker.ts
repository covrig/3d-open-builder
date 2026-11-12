import * as THREE from 'three';
import type { MeasurePoint, SceneDocument, SceneObject } from '../scene/document';
import type { SectionCut } from './crossSection';
import type { Viewport } from '../scene/viewport';
import { edgeFeatures } from '../geometry/edgeMiddles';
import { flatFaceRegion } from '../geometry/faceRegion';
import { meshId, type MeshData } from '../geometry/meshData';
import { runOp } from '../geometry/workerClient';
import { viewClicks } from './interaction';

export const SNAP_PX = 14;
const EDGE_ANGLE = 25;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** What a picked point snapped to (shown while hovering, so a point isn't misplaced). */
export type SnapKind = 'corner' | 'measure' | 'middle' | 'face' | 'edge';
export const SNAP_NAMES: Record<SnapKind, string> = {
  corner: 'Corner',
  measure: 'Measurement point',
  middle: 'Middle of edge',
  face: 'Centre of face',
  edge: 'On edge',
};
/** Order of preference when several objects offer a snap (X-ray): lower wins, then the nearer on screen. */
const RANK: Record<SnapKind, number> = { corner: 0, measure: 1, middle: 2, face: 3, edge: 4 };

/** A point picked on the model, what it snapped to, and whether it lies behind the surface in front (X-ray). */
export interface Picked {
  point: MeasurePoint;
  snap: SnapKind | null;
  hidden: boolean;
}

/** Centres of flat faces per geometry and triangle (null: not a flat face, e.g. a curved surface), found once. */
const faceCentreCache = new WeakMap<THREE.BufferGeometry, Map<number, THREE.Vector3 | null>>();
function faceCentre(geometry: THREE.BufferGeometry, data: MeshData, tri: number): THREE.Vector3 | null {
  let cache = faceCentreCache.get(geometry);
  if (!cache) faceCentreCache.set(geometry, (cache = new Map()));
  if (cache.has(tri)) return cache.get(tri)!;
  // The geometry is the object's mesh made non-indexed in the same triangle order; if not, the triangle numbers don't match.
  if (geometry.getAttribute('position').count !== data.indices.length) return null;
  const region = flatFaceRegion(data, tri);
  const centre = region.flat ? new THREE.Vector3(...region.centre) : null;
  // Every triangle of the face has the same centre.
  for (const t of region.triangles) cache.set(t, centre);
  return centre;
}

interface FeatureEdges {
  /** Sharp-edge segments, 6 numbers (two points) each, local space */
  segs: Float32Array;
  /** Real corners and the middles of straight edges, 3 numbers each (see edgeFeatures) */
  corners: Float32Array;
  mids: Float32Array;
}

/** Sharp edges of a geometry, its real corners and the middles of its straight edges, computed once per geometry. */
const edgeCache = new WeakMap<THREE.BufferGeometry, FeatureEdges>();
/** Big geometries whose edges the worker is working out */
const edgesAsked = new WeakSet<THREE.BufferGeometry>();
/** Above this many triangles, finding the edges here would hold up the page (as for the Edges view). */
const BIG_MESH = 50_000;
const NO_EDGES: FeatureEdges = { segs: new Float32Array(0), corners: new Float32Array(0), mids: new Float32Array(0) };

function featureEdges(mesh: THREE.Mesh, data: MeshData): FeatureEdges {
  const geometry = mesh.geometry;
  const known = edgeCache.get(geometry);
  if (known) return known;
  const keep = (segs: Float32Array) => {
    const edges = { segs, ...edgeFeatures(segs) };
    edgeCache.set(geometry, edges);
    return edges;
  };
  // The Edges view's lines, when drawn, are these same edges (same angle, the object's own coordinates).
  const drawn = (mesh.userData.edges as THREE.LineSegments | undefined)?.geometry.getAttribute('position');
  if (drawn) return keep(drawn.array as Float32Array);
  // A big mesh: the worker finds them; until then this object offers no edge snaps.
  if (data.indices.length / 3 > BIG_MESH) {
    if (!edgesAsked.has(geometry)) {
      edgesAsked.add(geometry);
      runOp('edgeLines', { mesh: { ...data, id: meshId(data) }, angle: EDGE_ANGLE }, true).then(
        (segs) => void keep(segs),
        () => edgesAsked.delete(geometry), // stopped or failed: ask again next time
      );
    }
    return NO_EDGES;
  }
  const g = new THREE.EdgesGeometry(geometry, EDGE_ANGLE);
  const segs = g.getAttribute('position').array as Float32Array;
  g.dispose();
  return keep(segs);
}

/** The marker of a snapped (or plain) hover point as SVG, plus its tag as HTML. Hidden points are dashed. */
export function hoverMarker(p: THREE.Vector2, snap: SnapKind | null, hidden: boolean): { svg: string; tag: string } {
  const dash = hidden ? ' stroke-dasharray="3 3"' : '';
  if (!snap) return { svg: `<circle class="hover" cx="${p.x}" cy="${p.y}" r="8"${dash}/>`, tag: '' };
  return {
    svg:
      `<circle class="hover snapped" cx="${p.x}" cy="${p.y}" r="9"${dash}/>` +
      `<circle class="snap-dot" cx="${p.x}" cy="${p.y}" r="4.5"${hidden ? ' fill-opacity="0.45"' : ''}/>`,
    tag: `<div class="m-snap" style="left:${p.x}px;top:${p.y}px">${SNAP_NAMES[snap]}${hidden ? ' (hidden)' : ''}</div>`,
  };
}

interface Candidate {
  point: MeasurePoint;
  snap: SnapKind | null;
  /** Distance from the cursor on screen (px) */
  px: number;
}

export interface PickOptions {
  onPick(point: THREE.Vector3): void;
  onCancel?(): void;
  /** Extra world points that can be snapped to (shown as "Measurement point") */
  extraPoints?: () => THREE.Vector3[];
}

/**
 * Picking points on the model with snapping: to corners, existing measuring
 * points, middles of straight edges, centres of flat faces and edges, in that
 * order. With X-ray on, hidden objects and what lies behind a surface count
 * too. Used by measuring, and (with start/stop) by any tool that wants a
 * point: it shows the hover marker and the snap tag, a click picks, Esc
 * cancels.
 */
export class SnapPicker {
  /** The cross-section, when on: cut-away parts are ignored, the filled cut face can be picked on and its outline counts as edges. */
  section: { active: boolean; plane: THREE.Plane; cutOf(obj: SceneObject): SectionCut | null } | null = null;
  /** Lines where overlapping objects cross (world space), also snap targets. */
  overlaps: { readonly features: { segs: Float32Array; corners: Float32Array; mids: Float32Array } | null } | null = null;
  /** How close (px) to a corner, edge or face centre a pick snaps; a finger is less exact than a mouse, so callers can raise it. */
  snapPx = SNAP_PX;
  /** Whether snapping is on at all */
  snapOn: () => boolean = () => true;
  /** Existing measuring points that can be snapped to */
  known: () => MeasurePoint[] = () => this.doc.measurements.flatMap((m) => m.points);

  private opts: PickOptions | null = null;
  private svg: SVGSVGElement | null = null;
  private tags: HTMLElement | null = null;
  private hover: Picked | null = null;
  private saved: { onClick: typeof viewClicks.onClick; onMove: typeof viewClicks.onMove } | null = null;
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation(); // before the app-wide Esc handler, which would close the tool's bar
    this.cancel();
  };
  private readonly frame = () => this.draw();

  constructor(
    private readonly viewport: Viewport,
    private readonly doc: SceneDocument,
  ) {}

  get picking(): boolean {
    return this.opts !== null;
  }

  /** World position of a point, or null if its object no longer exists. Older files may hold points on the plate (no object). */
  world(p: MeasurePoint): THREE.Vector3 | null {
    if (p.objectId === undefined) return p.local.clone();
    const obj = this.doc.objects.find((o) => o.id === p.objectId);
    if (!obj) return null;
    obj.mesh.updateMatrixWorld();
    return obj.mesh.localToWorld(p.local.clone());
  }

  // --- Using it as a tool ----------------------------------------------------

  start(opts: PickOptions): void {
    this.stop();
    this.opts = opts;
    if (!this.svg) {
      this.svg = document.createElementNS(SVG_NS, 'svg');
      this.svg.classList.add('measure');
      this.tags = document.createElement('div');
      this.tags.className = 'measure-labels';
      this.viewport.element.append(this.svg, this.tags);
      this.viewport.onFrame(this.frame);
    }
    this.saved = { onClick: viewClicks.onClick, onMove: viewClicks.onMove };
    viewClicks.onMove = (e) => {
      this.hover = this.pick(e.clientX, e.clientY);
      this.viewport.invalidate();
    };
    viewClicks.onClick = (e) => {
      const picked = this.pick(e.clientX, e.clientY);
      const at = picked && this.world(picked.point);
      if (!at) return;
      const done = this.opts;
      this.stop();
      done?.onPick(at);
    };
    window.addEventListener('keydown', this.onKey, true);
    this.viewport.element.classList.add('measuring');
    this.viewport.invalidate();
  }

  /** Stop picking (no callback). */
  stop(): void {
    if (!this.opts) return;
    this.opts = null;
    this.hover = null;
    if (this.saved) {
      viewClicks.onClick = this.saved.onClick;
      viewClicks.onMove = this.saved.onMove;
      this.saved = null;
    }
    window.removeEventListener('keydown', this.onKey, true);
    this.viewport.element.classList.remove('measuring');
    this.draw();
    this.viewport.invalidate();
  }

  private cancel(): void {
    const done = this.opts;
    this.stop();
    done?.onCancel?.();
  }

  private draw(): void {
    if (!this.svg || !this.tags) return;
    const at = this.opts && this.hover ? this.world(this.hover.point) : null;
    if (!at) {
      this.svg.innerHTML = '';
      this.tags.innerHTML = '';
      return;
    }
    const m = hoverMarker(this.viewport.project(at), this.hover!.snap, this.hover!.hidden);
    this.svg.innerHTML = m.svg;
    this.tags.innerHTML = m.tag;
  }

  // --- Picking -----------------------------------------------------------------

  /**
   * Point under the cursor: on an object only (nothing on the plate or in empty
   * space), snapped, when close, to a corner, an existing measurement point, the
   * middle of a straight edge, the centre of a flat face or an edge, in that
   * order. Also says what it snapped to. With the cross-section on, cut-away
   * parts are ignored, the filled cut face can be picked on, and its outline
   * counts as edges. With X-ray on, every object along the ray offers snaps.
   */
  pick(clientX: number, clientY: number): Picked | null {
    // hitsOn skips objects hidden with the eye button and cut-away parts.
    const raycaster = this.viewport.rayAt(clientX, clientY);
    const xray = this.doc.view.xray;
    const hits = this.viewport.hitsOn(raycaster, xray);
    const found = this.pickFromHits(hits, raycaster, clientX, clientY);
    if (found) return this.withHidden(found);
    if (hits.length) return null;
    // Just past an object's outline, where its corners and edges are: the ray
    // misses by a pixel. Look a little around the cursor for the object and
    // take the point only if it snaps to something there.
    let best: Candidate | null = null;
    for (const radius of [5, 10]) {
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        const nearHits = this.viewport.hitsOn(this.viewport.rayAt(clientX + radius * Math.cos(a), clientY + radius * Math.sin(a)), xray);
        if (!nearHits.length) continue;
        const picked = this.pickFromHits(nearHits, raycaster, clientX, clientY);
        if (picked?.snap && (!best || this.betterThan(picked, best))) best = picked;
      }
    }
    return best ? this.withHidden(best) : null;
  }

  /** Whether a snapped point lies behind the surface in front of it (only possible to pick with X-ray on). */
  private withHidden(c: Candidate): Picked {
    const out: Picked = { point: c.point, snap: c.snap, hidden: false };
    if (!c.snap || !this.doc.view.xray) return out;
    const at = this.world(c.point);
    if (!at) return out;
    const r = this.viewport.element.getBoundingClientRect();
    const s = this.viewport.project(at);
    const ray = this.viewport.rayAt(r.left + s.x, r.top + s.y);
    const front = this.viewport.hitsOn(ray)[0];
    const depth = at.clone().sub(ray.ray.origin).dot(ray.ray.direction);
    out.hidden = !!front && front.distance < depth - Math.max(0.2, depth * 0.005);
    return out;
  }

  /** The best candidate of the hits: the front one, or with X-ray every one (the highest-priority snap, then the nearest to the cursor). */
  private pickFromHits(hits: THREE.Intersection[], raycaster: THREE.Raycaster, clientX: number, clientY: number): Candidate | null {
    const list = this.doc.view.xray ? hits : hits.slice(0, 1);
    const found = list.map((h) => this.pickFrom(h, raycaster, clientX, clientY)).filter((c): c is Candidate => c !== null);
    const snapped = found.filter((c) => c.snap);
    if (snapped.length === 0) return found[0] ?? null;
    return snapped.reduce((best, c) => (this.betterThan(c, best) ? c : best));
  }

  /** Same ranking as pickFromHits: the higher-priority snap, then the nearer to the cursor. */
  private betterThan(c: Candidate, best: Candidate): boolean {
    const rank = RANK[c.snap!] - RANK[best.snap!];
    return rank < 0 || (rank === 0 && c.px < best.px);
  }

  /** The candidate for a hit on an object, snapped from where the cursor (`raycaster`) is. */
  private pickFrom(hit: THREE.Intersection, raycaster: THREE.Raycaster, clientX: number, clientY: number): Candidate | null {
    const section = this.section?.active ? this.section : null;
    const shown = (world: THREE.Vector3) => !section || section.plane.distanceToPoint(world) >= -1e-4;
    const mesh = hit.object as THREE.Mesh;
    const obj = this.doc.byMesh(mesh);
    if (!obj) return null;
    // Looking into the cut: the first surface still shown faces away, so what
    // is seen is the filled cut face, where the ray meets the plane.
    let worldHit = hit.point;
    let intoCut = false;
    if (section && hit.face && hit.face.normal.clone().transformDirection(mesh.matrixWorld).dot(raycaster.ray.direction) > 0) {
      const onPlane = raycaster.ray.intersectPlane(section.plane, new THREE.Vector3());
      if (onPlane) {
        worldHit = onPlane;
        intoCut = true;
      }
    }
    const toLocal = (w: THREE.Vector3) => mesh.worldToLocal(w.clone());
    const snapped = (local: THREE.Vector3, snap: SnapKind | null, px = 0, objectId: number | undefined = obj.id): Candidate => ({
      point: { objectId, local },
      snap,
      px,
    });
    if (!this.snapOn() || !hit.face) return snapped(toLocal(worldHit), null);

    const r = this.viewport.element.getBoundingClientRect();
    const cursor = new THREE.Vector2(clientX - r.left, clientY - r.top);
    const toWorld = (localPoint: THREE.Vector3) => localPoint.clone().applyMatrix4(mesh.matrixWorld);
    const screenDist = (localPoint: THREE.Vector3) => this.viewport.project(toWorld(localPoint)).distanceTo(cursor);
    const localHit = toLocal(worldHit);
    // Cheap filter for edges and middles: only those near the hit point.
    const near = (mesh.geometry.boundingSphere?.radius ?? 20) * 0.2;

    // Snap targets: the object's sharp edges, plus the outline of the cut (in the object's own coordinates).
    const own = featureEdges(mesh, obj.data);
    const cut = section ? section.cutOf(obj) : null;
    const inverse = mesh.matrixWorld.clone().invert();
    const toLocalList = (list: Float32Array) => {
      const out = new Float32Array(list.length);
      const v = new THREE.Vector3();
      for (let i = 0; i < list.length; i += 3) {
        v.set(list[i], list[i + 1], list[i + 2]).applyMatrix4(inverse);
        out.set([v.x, v.y, v.z], i);
      }
      return out;
    };
    const cutLocal = cut ? { corners: toLocalList(cut.corners), mids: toLocalList(cut.mids), segs: toLocalList(cut.segs) } : null;
    // And the lines where this object crosses others it overlaps.
    const seam = this.overlaps?.features;
    const seamLocal = seam?.segs.length ? { corners: toLocalList(seam.corners), mids: toLocalList(seam.mids), segs: toLocalList(seam.segs) } : null;

    // In order: 1. real corners, 2. existing measurement points, 3. middles of
    // straight edges, 4. centres of flat faces, 5. the nearest sharp edge. (Not
    // the points of the triangles: on a sphere or a cylinder's rim those are
    // only where the smooth surface was divided up.)
    let best: THREE.Vector3 | null = null;
    let bestPx = this.snapPx;
    /**
     * The one corner (or middle) within snapping distance of the cursor. Where
     * several crowd together, as along a thread whose crests zigzag across the
     * triangles, none of them is a real corner: no snap of this kind (zooming
     * in spreads a small part's real corners apart again).
     */
    const single = (...lists: (Float32Array | undefined)[]): { at: THREE.Vector3; px: number } | null => {
      const found: { at: THREE.Vector3; px: number; screen: THREE.Vector2 }[] = [];
      const v = new THREE.Vector3();
      for (const list of lists) {
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          v.set(list[i], list[i + 1], list[i + 2]);
          if (v.distanceTo(localHit) > near || !shown(toWorld(v))) continue;
          const screen = this.viewport.project(toWorld(v));
          const px = screen.distanceTo(cursor);
          if (px >= this.snapPx) continue;
          // The same point listed twice (an own corner the cut passes through) counts once.
          if (found.some((f) => f.screen.distanceTo(screen) < 2)) continue;
          found.push({ at: v.clone(), px, screen });
        }
      }
      return found.length === 1 ? found[0] : null;
    };
    const corner = single(own.corners, cutLocal?.corners, seamLocal?.corners);
    if (corner) return snapped(corner.at, 'corner', corner.px);

    // An existing measurement point (placed or being placed) close to the cursor and near the surface under it.
    let known: MeasurePoint | null = null;
    let knownPx = this.snapPx;
    const extra = (this.opts?.extraPoints?.() ?? []).map((v): MeasurePoint => ({ local: v.clone() }));
    for (const q of [...this.known(), ...extra]) {
      const w = this.world(q);
      if (!w || !shown(w)) continue;
      const px = this.viewport.project(w).distanceTo(cursor);
      if (px >= knownPx || mesh.worldToLocal(w.clone()).distanceTo(localHit) > near) continue;
      knownPx = px;
      known = q;
    }
    if (known) return snapped(known.local.clone(), 'measure', knownPx, known.objectId);

    const middle = single(own.mids, cutLocal?.mids, seamLocal?.mids);
    if (middle) return snapped(middle.at, 'middle', middle.px);

    // The centre of the flat face under the cursor (not on curved surfaces, and not when looking at the cut face).
    if (!intoCut && hit.faceIndex !== undefined && hit.faceIndex !== null) {
      const centre = faceCentre(mesh.geometry, obj.data, hit.faceIndex);
      if (centre && shown(toWorld(centre))) {
        const px = screenDist(centre);
        if (px < this.snapPx) return snapped(centre.clone(), 'face', px);
      }
    }

    // 5. The nearest sharp edge (cube edges, hole rims, the cut's outline, overlap lines...), never a flat face's diagonal.
    const localRay = raycaster.ray.clone().applyMatrix4(inverse);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), onSeg = new THREE.Vector3();
    const seg = new THREE.Line3();
    for (const segs of [own.segs, cutLocal?.segs, seamLocal?.segs]) {
      if (!segs) continue;
      for (let i = 0; i < segs.length; i += 6) {
        a.set(segs[i], segs[i + 1], segs[i + 2]);
        b.set(segs[i + 3], segs[i + 4], segs[i + 5]);
        seg.set(a, b);
        if (seg.closestPointToPoint(localHit, true, onSeg).distanceTo(localHit) > near) continue;
        localRay.distanceSqToSegment(a, b, undefined, onSeg);
        if (!shown(toWorld(onSeg))) continue;
        const px = screenDist(onSeg);
        if (px < bestPx) {
          bestPx = px;
          best = onSeg.clone();
        }
      }
    }
    return best ? snapped(best, 'edge', bestPx) : snapped(localHit, null);
  }
}
