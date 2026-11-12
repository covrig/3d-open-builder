import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { findEdges } from '../src/geometry/edges';
import { edgeTreatment } from '../src/geometry/features';
import { meshDataToManifold, type MeshData } from '../src/geometry/meshData';
import { bounds } from '../src/geometry/meshOps';
import { createPrimitive } from '../src/geometry/primitives';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const volume = (mesh: MeshData) => {
  const m = meshDataToManifold(wasm, mesh);
  const v = m.volume();
  m.delete();
  return v;
};
const TOO_LARGE = /too large for the faces/;

describe('sizes the faces cannot take are refused', () => {
  // 40 x 40 x 2 plate (z -1..1); its +x top edge has a side face only 2 mm tall.
  const plate = () => createPrimitive(wasm, 'cube', { width: 40, depth: 40, height: 2 });
  const plateEdge = () => findEdges(plate()).segments.filter((s) => s.a[2] > 0 && s.b[2] > 0 && s.a[0] > 19 && s.b[0] > 19);
  const cube = () => createPrimitive(wasm, 'cube');

  it('refuses a chamfer taller than the side face of a plate', () => {
    expect(plateEdge().length).toBe(1);
    for (const size of [3, 10]) {
      expect(() => edgeTreatment(wasm, { mesh: plate(), matrix: IDENTITY }, plateEdge(), 'chamfer', size), `chamfer ${size}`).toThrow(TOO_LARGE);
    }
  });

  it('still chamfers a plate edge by the whole side face (2 mm) or less', () => {
    // A size x size right-triangle prism along the 40 mm edge: size² / 2 x 40.
    for (const size of [1, 2]) {
      const r = edgeTreatment(wasm, { mesh: plate(), matrix: IDENTITY }, plateEdge(), 'chamfer', size);
      expect(3200 - volume(r.mesh), `chamfer ${size}`).toBeCloseTo((size * size / 2) * 40, 0);
    }
  });

  it('refuses a round or bevel whose tools overlap on all edges of a cube', () => {
    const all = findEdges(cube()).segments;
    expect(all.length).toBe(12);
    expect(() => edgeTreatment(wasm, { mesh: cube(), matrix: IDENTITY }, all, 'fillet', 25)).toThrow(TOO_LARGE);
    expect(() => edgeTreatment(wasm, { mesh: cube(), matrix: IDENTITY }, all, 'chamfer', 25)).toThrow(TOO_LARGE);
  });

  it('still rounds all edges of a cube up to half its width, where the tools just meet', () => {
    const all = findEdges(cube()).segments;
    // r = 10: rounded box with 20 mm core; r = 20: a ball of radius 20 (about 33,175 mm³ as a polyhedron).
    for (const r of [10, 20]) {
      const out = edgeTreatment(wasm, { mesh: cube(), matrix: IDENTITY }, all, 'fillet', r);
      const b = bounds(out.mesh);
      expect(b.max[0] - b.min[0], `fillet ${r}`).toBeCloseTo(40, 2);
      if (r === 20) expect(volume(out.mesh)).toBeGreaterThan(33_000);
      if (r === 20) expect(volume(out.mesh)).toBeLessThan(33_510);
    }
  });

  it('still chamfers one cube edge by exactly the prism', () => {
    const edge = findEdges(cube()).segments[0];
    const r = edgeTreatment(wasm, { mesh: cube(), matrix: IDENTITY }, [edge], 'chamfer', 2);
    expect(64000 - volume(r.mesh)).toBeCloseTo(80, 3); // 2 x 2 / 2 x 40
  });
});

describe('a chamfer on a curved rim cuts what a true circle would', () => {
  const cylinder = () => createPrimitive(wasm, 'cylinder', { diameter: 40, height: 40 });
  const topRim = () => findEdges(cylinder()).segments.filter((s) => s.a[2] > 19 && s.b[2] > 19);

  it('removes 2π(R - c/3)·c²/2 for a chamfer of c = 2 (within 2 %)', () => {
    const exact = 2 * Math.PI * (20 - 2 / 3) * 2; // 242.95
    const r = edgeTreatment(wasm, { mesh: cylinder(), matrix: IDENTITY }, topRim(), 'chamfer', 2);
    const removed = volume(cylinder()) - volume(r.mesh);
    expect(Math.abs(removed / exact - 1)).toBeLessThan(0.02);
    // A faceted cylinder is a little smaller than a true one, so it never removes more.
    expect(removed).toBeLessThan(exact * 1.001);
  });

  it('keeps the fillet within 1 % of the exact ring', () => {
    const exact = 105.46;
    const r = edgeTreatment(wasm, { mesh: cylinder(), matrix: IDENTITY }, topRim(), 'fillet', 2);
    const removed = volume(cylinder()) - volume(r.mesh);
    expect(Math.abs(removed / exact - 1)).toBeLessThan(0.01);
  });
});
