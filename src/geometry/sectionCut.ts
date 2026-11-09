import * as THREE from 'three';

/** Distance (mm) under which a mesh point counts as lying on the cutting plane. */
const ON_PLANE = 1e-6;
/** Faces meeting at more than this angle make a sharp edge (same rule as the Edges view). */
const SHARP_DEG = 25;

export interface Cut {
  /** Line segments, 6 numbers (two points) each, world space */
  segs: Float32Array;
  /** Per segment end: does it lie on a sharp edge of the mesh? Only there can the cut have a real corner. */
  sharp: Uint8Array;
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** For each mesh edge (by its two points) and each point: does a sharp edge run there? Cached per geometry. */
const sharpCache = new WeakMap<THREE.BufferGeometry, { edges: Set<string>; points: Set<string> }>();
function sharpParts(geometry: THREE.BufferGeometry): { edges: Set<string>; points: Set<string> } {
  let parts = sharpCache.get(geometry);
  if (parts) return parts;
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = index ? index.count : pos.count;
  const normals = new Map<string, THREE.Vector3[]>();
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const k = ['', '', ''];
  for (let t = 0; t + 2 < count; t += 3) {
    for (let i = 0; i < 3; i++) {
      p[i].fromBufferAttribute(pos, index ? index.getX(t + i) : t + i);
      k[i] = key(p[i].x, p[i].y, p[i].z);
    }
    const n = new THREE.Triangle(p[0], p[1], p[2]).getNormal(new THREE.Vector3());
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const e = k[a] < k[b] ? `${k[a]}|${k[b]}` : `${k[b]}|${k[a]}`;
      if (!normals.has(e)) normals.set(e, []);
      normals.get(e)!.push(n);
    }
  }
  const edges = new Set<string>(), points = new Set<string>();
  const limit = THREE.MathUtils.degToRad(SHARP_DEG);
  for (const [e, list] of normals) {
    if (list.length === 2 && list[0].angleTo(list[1]) <= limit) continue;
    edges.add(e);
    for (const end of e.split('|')) points.add(end);
  }
  parts = { edges, points };
  sharpCache.set(geometry, parts);
  return parts;
}

/**
 * Where a mesh's triangles cross a plane: the outline of the cut, in world
 * space, and for each segment end whether it lies on a sharp mesh edge.
 *
 * A mesh point lying exactly on the plane (a ring of points at the cut
 * height) counts as just on the kept side when deciding which triangles are
 * cut, and is then used as it is: each edge crossing is found once, at one
 * exact position, and a triangle that only touches the plane gives nothing.
 */
export function cutSegments(mesh: THREE.Mesh, plane: THREE.Plane): Cut {
  const geometry = mesh.geometry;
  const sharpOf = sharpParts(geometry);
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = index ? index.count : pos.count;
  const m = mesh.matrixWorld;
  const local = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const k = ['', '', ''];
  const d = [0, 0, 0];
  const onPlane = [false, false, false];
  const segs: number[] = [];
  const sharp: number[] = [];
  for (let t = 0; t + 2 < count; t += 3) {
    for (let i = 0; i < 3; i++) {
      local[i].fromBufferAttribute(pos, index ? index.getX(t + i) : t + i);
      k[i] = key(local[i].x, local[i].y, local[i].z);
      p[i].copy(local[i]).applyMatrix4(m);
      d[i] = plane.distanceToPoint(p[i]);
      onPlane[i] = Math.abs(d[i]) < ON_PLANE;
      if (onPlane[i]) d[i] = ON_PLANE;
    }
    const side = d.map((v) => v > 0);
    if (side[0] === side[1] && side[1] === side[2]) continue;
    const ends: { at: THREE.Vector3; sharp: boolean }[] = [];
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      if (side[a] === side[b]) continue;
      // From the kept end, so the two triangles sharing this edge compute exactly the same point.
      const [i, j] = d[a] > 0 ? [a, b] : [b, a];
      if (onPlane[i]) {
        ends.push({ at: p[i].clone(), sharp: sharpOf.points.has(k[i]) });
      } else {
        const e = k[i] < k[j] ? `${k[i]}|${k[j]}` : `${k[j]}|${k[i]}`;
        ends.push({ at: p[i].clone().lerp(p[j], d[i] / (d[i] - d[j])), sharp: sharpOf.edges.has(e) });
      }
    }
    if (ends.length !== 2 || ends[0].at.distanceToSquared(ends[1].at) < 1e-14) continue;
    segs.push(...ends[0].at.toArray(), ...ends[1].at.toArray());
    sharp.push(ends[0].sharp ? 1 : 0, ends[1].sharp ? 1 : 0);
  }
  return { segs: new Float32Array(segs), sharp: new Uint8Array(sharp) };
}
