import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyH, invertH, solveH } from '../src/geometry/homography';
import { analyze, fillHoles, orient, weld } from '../src/geometry/meshCheck';
import { meshDataToManifold, type MeshData } from '../src/geometry/meshData';
import { checkMesh, repairMesh } from '../src/geometry/meshTools';
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

/** Every triangle with its own three vertices, as STL stores them. */
function unwelded(mesh: MeshData): MeshData {
  const pos: number[] = [];
  for (const i of mesh.indices) pos.push(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
  return { positions: new Float32Array(pos), indices: Uint32Array.from({ length: mesh.indices.length }, (_, i) => i) };
}

const withoutTriangles = (mesh: MeshData, drop: number[]): MeshData => ({
  positions: mesh.positions,
  indices: Uint32Array.from([...mesh.indices].filter((_, i) => !drop.includes(Math.floor(i / 3)))),
});

const flipTriangles = (mesh: MeshData, which: number[]): MeshData => {
  const idx = mesh.indices.slice();
  for (const t of which) [idx[t * 3 + 1], idx[t * 3 + 2]] = [idx[t * 3 + 2], idx[t * 3 + 1]];
  return { positions: mesh.positions, indices: idx };
};

describe('mesh checks', () => {
  it('reports a clean cube as closed, manifold and outward', () => {
    const r = analyze(weld(createPrimitive(wasm, 'cube')));
    expect(r).toMatchObject({ openEdges: 0, nonManifoldEdges: 0, flippedEdges: 0 });
    expect(r.signedVolume).toBeCloseTo(64000, 0);
  });

  it('welds STL-style triangle soup back together', () => {
    const soup = unwelded(createPrimitive(wasm, 'cube'));
    expect(analyze(soup).openEdges).toBe(36);
    expect(analyze(weld(soup)).openEdges).toBe(0);
  });

  it('finds a hole and closes it', () => {
    const holed = withoutTriangles(createPrimitive(wasm, 'cube'), [0]);
    expect(analyze(holed).openEdges).toBe(3);
    const { mesh, holes } = fillHoles(holed);
    expect(holes).toBe(1);
    expect(analyze(mesh).openEdges).toBe(0);
    expect(volume(mesh)).toBeCloseTo(64000, 0);
  });

  it('turns flipped faces back outward', () => {
    const bad = flipTriangles(createPrimitive(wasm, 'cube'), [0, 3, 7]);
    expect(analyze(bad).flippedEdges).toBeGreaterThan(0);
    const fixed = orient(bad);
    expect(analyze(fixed).flippedEdges).toBe(0);
    expect(analyze(fixed).signedVolume).toBeCloseTo(64000, 0);
  });

  it('turns an inside-out object right way out', () => {
    const all = Array.from({ length: 12 }, (_, i) => i);
    const fixed = orient(flipTriangles(createPrimitive(wasm, 'cube'), all));
    expect(analyze(fixed).signedVolume).toBeCloseTo(64000, 0);
  });

  it('repairs a broken STL-like mesh into a valid solid', () => {
    const broken = unwelded(flipTriangles(withoutTriangles(createPrimitive(wasm, 'cube'), [5]), [2]));
    const { mesh, actions } = repairMesh(wasm, broken);
    expect(volume(mesh)).toBeCloseTo(64000, 0);
    expect(actions.join(' ')).toMatch(/hole/i);
  });

  it('runs the print check: passes a cube, flags thin walls', () => {
    const ok = checkMesh(wasm, { mesh: createPrimitive(wasm, 'cube'), matrix: IDENTITY }, 0.8);
    expect(ok.items.every((i) => i.status === 'pass')).toBe(true);
    // A 0.5 mm thick plate is thinner than the 0.8 mm minimum.
    const plate = wasm.Manifold.cube([30, 30, 0.5], true);
    const m = plate.getMesh();
    const thin = checkMesh(wasm, { mesh: { positions: m.vertProperties.slice(), indices: m.triVerts.slice() }, matrix: IDENTITY }, 0.8);
    plate.delete();
    expect(thin.items.find((i) => i.id === 'thickness')?.status).not.toBe('pass');
  });

  it('suggests turning an upside-down cone onto its base', () => {
    const cone = createPrimitive(wasm, 'cone');
    const upsideDown = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]; // 180° about X
    const r = checkMesh(wasm, { mesh: cone, matrix: upsideDown }, 0.8);
    expect(r.suggestedDown).not.toBeNull();
    expect(r.suggestedDown![2]).toBeGreaterThan(0.99); // the base, now facing up, should go down
  });
});

describe('homography', () => {
  it('maps four corners exactly and inverts back', () => {
    const src: [number, number][] = [[0, 0], [100, 10], [110, 90], [-5, 80]];
    const dst: [number, number][] = [[0, 0], [50, 0], [50, 30], [0, 30]];
    const h = solveH(src, dst);
    src.forEach((p, i) => {
      const [x, y] = applyH(h, ...p);
      expect(x).toBeCloseTo(dst[i][0], 6);
      expect(y).toBeCloseTo(dst[i][1], 6);
    });
    const [u, v] = applyH(invertH(h), 50, 30);
    expect(u).toBeCloseTo(110, 6);
    expect(v).toBeCloseTo(90, 6);
  });
});
