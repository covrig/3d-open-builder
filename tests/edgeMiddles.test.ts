import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { edgeFeatures } from '../src/geometry/edgeMiddles';

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
