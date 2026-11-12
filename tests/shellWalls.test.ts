import Module, { type Manifold, type ManifoldToplevel, type Mat4 } from 'manifold-3d';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { shell } from '../src/geometry/features';
import { meshDataToManifold, type MeshData } from '../src/geometry/meshData';
import { createPrimitive } from '../src/geometry/primitives';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const turned = (axis: [number, number, number], angle: number) =>
  new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(...axis).normalize(), angle).elements;

/**
 * The hollow left by Shell (original minus result) and the thinnest wall around it.
 * The original is convex here, so a point inside is at least `min over its face planes` of
 * (distance to that plane) from the surface, and that distance is smallest at a corner of
 * the cavity (it is a concave function over each flat cavity face). So the exact thinnest
 * wall is the least such distance over the cavity's vertices.
 */
function hollow(mesh: MeshData, matrix: ArrayLike<number>, wall: number) {
  const r = shell(wasm, { mesh, matrix }, wall);
  const original = meshDataToManifold(wasm, mesh, matrix);
  const result = meshDataToManifold(wasm, r.mesh, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, r.center[0], r.center[1], r.center[2], 1] as Mat4);
  const rough = original.subtract(result);
  // A turned cube's corners are rounded to float32 in the result, which leaves paper-thin slivers on
  // the outside of the subtraction; the hollow itself is the biggest piece.
  const parts = rough.decompose().sort((a, b) => b.volume() - a.volume());
  const cavity = parts[0];
  const planes = convexPlanes(original);
  const g = cavity.getMesh();
  let thinnest = Infinity;
  for (let v = 0; v < g.vertProperties.length; v += g.numProp) {
    const x = g.vertProperties[v], y = g.vertProperties[v + 1], z = g.vertProperties[v + 2];
    let nearest = Infinity;
    for (const [nx, ny, nz, d] of planes) nearest = Math.min(nearest, d - (nx * x + ny * y + nz * z));
    thinnest = Math.min(thinnest, nearest);
  }
  const volume = cavity.volume();
  for (const m of [original, result, rough, ...parts]) m.delete();
  return { thinnest, volume };
}

/** Outward unit normal and offset of every face plane of a convex solid. */
function convexPlanes(m: Manifold): [number, number, number, number][] {
  const g = m.getMesh();
  const p = g.vertProperties, s = g.numProp, ix = g.triVerts;
  const out: [number, number, number, number][] = [];
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [ix[t] * s, ix[t + 1] * s, ix[t + 2] * s];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    out.push([nx / len, ny / len, nz / len, (nx * p[a] + ny * p[a + 1] + nz * p[a + 2]) / len]);
  }
  return out;
}

describe('shell walls are never thinner than asked', () => {
  const cube = () => createPrimitive(wasm, 'cube');

  it('cube turned 30 degrees about (1,1,1), walls of 2 mm', () => {
    const { thinnest } = hollow(cube(), turned([1, 1, 1], Math.PI / 6), 2);
    expect(thinnest).toBeGreaterThanOrEqual(2 * 0.995);
    expect(thinnest).toBeLessThan(2 * 1.1); // a little thicker in places, not far off
  });

  it('sphere of 40 mm, walls of 2 mm', () => {
    const { thinnest } = hollow(createPrimitive(wasm, 'sphere', { diameter: 40 }), IDENTITY, 2);
    expect(thinnest).toBeGreaterThanOrEqual(2 * 0.995);
    expect(thinnest).toBeLessThan(2 * 1.1);
  }, 120_000); // heavy: hollowing a sphere took 10 s on the CI machine

  it('axis-aligned cube: walls at least 2 mm, cavity within 2 % of the exact 36 mm cube', () => {
    // The ball is made bigger than the sphere it must hold, so the 6 flat walls come out a
    // few percent thicker than 2 mm (cavity 45,915 mm³ against 46,656), never thinner.
    const { thinnest, volume } = hollow(cube(), IDENTITY, 2);
    expect(thinnest).toBeGreaterThanOrEqual(2 * 0.995);
    expect(volume).toBeLessThanOrEqual(36 ** 3);
    expect(Math.abs(volume / 36 ** 3 - 1)).toBeLessThan(0.02);
  });
});
