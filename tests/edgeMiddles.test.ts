import Module, { type ManifoldToplevel } from 'manifold-3d';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { edgeFeatures } from '../src/geometry/edgeMiddles';
import { findEdges } from '../src/geometry/edges';
import { edgeTreatment } from '../src/geometry/features';
import type { MeshData } from '../src/geometry/meshData';
import { createPrimitive } from '../src/geometry/primitives';
import { cutSegments } from '../src/geometry/sectionCut';
import { buildGeometry } from '../src/scene/document';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

/** Segments as the flat list EdgesGeometry gives: x1 y1 z1 x2 y2 z2 per segment. */
const segs = (...s: number[][]) => new Float32Array(s.flat());
const points = (m: Float32Array) => Array.from({ length: m.length / 3 }, (_, i) => [m[i * 3], m[i * 3 + 1], m[i * 3 + 2]]);
/** A closed polygon of `n` sides around the origin, as edge segments. */
const polygon = (n: number, r = 10) => segs(...Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
  return [r * Math.cos(a), r * Math.sin(a), 0, r * Math.cos(b), r * Math.sin(b), 0];
}));
/** Sharp edges of a three.js geometry, as the measuring tool finds them. */
const sharpEdges = (g: THREE.BufferGeometry) => new THREE.EdgesGeometry(g, 25).getAttribute('position').array as Float32Array;

describe('snap targets on edges for measuring', () => {
  it('joins pieces in a row into one edge, with its middle', () => {
    // A 30 mm edge stored as three pieces (as booleans often leave it).
    const f = edgeFeatures(segs([0, 0, 0, 10, 0, 0], [10, 0, 0, 22, 0, 0], [22, 0, 0, 30, 0, 0]));
    expect(points(f.mids)).toEqual([[15, 0, 0]]);
    expect(points(f.corners)).toHaveLength(2); // only the two ends
  });

  it('cuts an edge at a bend and where a third edge meets', () => {
    const l = edgeFeatures(segs([0, 0, 0, 10, 0, 0], [10, 0, 0, 10, 20, 0]));
    expect(points(l.mids)).toContainEqual([5, 0, 0]);
    expect(points(l.mids)).toContainEqual([10, 10, 0]);
    const t = edgeFeatures(segs([0, 0, 0, 10, 0, 0], [10, 0, 0, 20, 0, 0], [10, 0, 0, 10, 5, 0]));
    expect(points(t.mids)).toHaveLength(3);
    expect(points(t.mids)).toContainEqual([15, 0, 0]);
  });

  it('gives a cylinder rim no corners and no middles (only "on edge")', () => {
    const rim = edgeFeatures(polygon(48));
    expect(rim.corners).toHaveLength(0);
    expect(rim.mids).toHaveLength(0);
    // A real cylinder: its rims are its only sharp edges.
    const cyl = edgeFeatures(sharpEdges(new THREE.CylinderGeometry(10, 10, 20, 48)));
    expect(cyl.corners).toHaveLength(0);
    expect(cyl.mids).toHaveLength(0);
  });

  it('gives a sphere nothing to snap to, and a hexagon its corners and middles', () => {
    const sphere = edgeFeatures(sharpEdges(new THREE.SphereGeometry(10, 48, 24)));
    expect(sphere.corners).toHaveLength(0);
    expect(sphere.mids).toHaveLength(0);
    const hex = edgeFeatures(polygon(6));
    expect(points(hex.corners)).toHaveLength(6);
    expect(points(hex.mids)).toHaveLength(6);
  });
});

describe('no false corners (measuring snaps)', () => {
  const corners = (segs: Float32Array | { segs: Float32Array; sharp: Uint8Array }) =>
    (segs instanceof Float32Array ? edgeFeatures(segs) : edgeFeatures(segs.segs, segs.sharp)).corners.length / 3;
  const ownEdges = (m: MeshData) => new THREE.EdgesGeometry(buildGeometry(m), 25).getAttribute('position').array as Float32Array;
  const meshOf = (m: MeshData) => {
    const mesh = new THREE.Mesh(buildGeometry(m));
    mesh.updateMatrixWorld();
    return mesh;
  };
  /** Every distinct height of the mesh's points: cuts right through rings of points. */
  const pointHeights = (mesh: THREE.Mesh) => [...new Set(Array.from(mesh.geometry.getAttribute('position').array).filter((_, i) => i % 3 === 2))];

  it('cutting right through a ring of mesh points gives no corners on round shapes', () => {
    for (const kind of ['torus', 'sphere', 'tube', 'cylinder', 'dome', 'cone'] as const) {
      const mesh = meshOf(createPrimitive(wasm, kind));
      for (const z of pointHeights(mesh)) {
        expect(corners(cutSegments(mesh, new THREE.Plane(new THREE.Vector3(0, 0, -1), z))), `${kind} cut at z ${z}`).toBe(0);
      }
    }
  });

  it('keeps the real corners of a cut, even through a ring of points', () => {
    const mesh = meshOf(createPrimitive(wasm, 'cube'));
    for (const z of [0, -10, 13.7]) expect(corners(cutSegments(mesh, new THREE.Plane(new THREE.Vector3(0, 0, -1), z)))).toBe(4);
  });

  it('joins end points a hair apart (no rounding misses)', () => {
    // A 48-sided ring whose shared points differ by up to 1e-7 mm, around rounding boundaries.
    const n = 48, r = 10.00005;
    const pt = (i: number, jitter: number) => [r * Math.cos((i / n) * Math.PI * 2) + jitter, r * Math.sin((i / n) * Math.PI * 2) - jitter, 0.00005];
    const segs = new Float32Array(Array.from({ length: n }, (_, i) => [...pt(i, 1e-7), ...pt(i + 1, -1e-7)]).flat());
    expect(corners(segs)).toBe(0);
  });

  it('finds only real corners on the shapes themselves', () => {
    const expected: [MeshData, number, string][] = [
      [createPrimitive(wasm, 'cube'), 8, 'cube'],
      [createPrimitive(wasm, 'hexagon'), 12, 'hexagon'],
      [createPrimitive(wasm, 'cylinder'), 0, 'cylinder'],
      [createPrimitive(wasm, 'tube'), 0, 'tube'],
      [createPrimitive(wasm, 'sphere'), 0, 'sphere'],
      [createPrimitive(wasm, 'torus'), 0, 'torus'],
    ];
    const cube = createPrimitive(wasm, 'cube');
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const rounded = edgeTreatment(wasm, { mesh: cube, matrix: I }, findEdges(cube).segments, 'fillet', 4).mesh;
    expected.push([rounded, 0, 'cube with all edges rounded']);
    for (const [mesh, n, name] of expected) expect(corners(ownEdges(mesh)), name).toBe(n);
  }, 60_000);
});