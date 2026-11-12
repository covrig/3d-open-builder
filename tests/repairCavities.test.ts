import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { booleanOp } from '../src/geometry/booleans';
import { hasInsideOutShell } from '../src/geometry/meshCheck';
import { bakeMesh, manifoldToMeshData, meshDataToManifold, type MeshData } from '../src/geometry/meshData';
import { recenter } from '../src/geometry/meshOps';
import { checkMesh, repairMesh } from '../src/geometry/meshTools';
import { createPrimitive, PRIMITIVE_NAMES, type PrimitiveKind } from '../src/geometry/primitives';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const T = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const cube = (s = 40) => createPrimitive(wasm, 'cube', { width: s, depth: s, height: s });
const moved = (m: MeshData, x: number, y: number, z: number) => bakeMesh({ mesh: m, matrix: T(x, y, z) });
const concat = (...ms: MeshData[]): MeshData => {
  const positions = new Float32Array(ms.reduce((n, m) => n + m.positions.length, 0));
  const indices = new Uint32Array(ms.reduce((n, m) => n + m.indices.length, 0));
  let pv = 0, pi = 0;
  for (const m of ms) {
    positions.set(m.positions, pv);
    for (let i = 0; i < m.indices.length; i++) indices[pi + i] = m.indices[i] + pv / 3;
    pv += m.positions.length;
    pi += m.indices.length;
  }
  return { positions, indices };
};
const invert = (m: MeshData): MeshData => {
  const indices = m.indices.slice();
  for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  return { positions: m.positions, indices };
};
const flipTriangle = (m: MeshData, t: number): MeshData => {
  const indices = m.indices.slice();
  [indices[t * 3 + 1], indices[t * 3 + 2]] = [indices[t * 3 + 2], indices[t * 3 + 1]];
  return { positions: m.positions, indices };
};
/** Volume and number of separate surfaces of a mesh as a solid. */
const solidInfo = (m: MeshData) => {
  const s = meshDataToManifold(wasm, m);
  const parts = s.decompose();
  const info = { volume: s.volume(), shells: parts.length };
  for (const p of parts) p.delete();
  s.delete();
  return info;
};
const lShape = () => manifoldToMeshData(wasm.Manifold.cube([40, 40, 40], true).subtract(wasm.Manifold.cube([20, 20, 50]).translate([0, 0, -25])));
const hollowCube = () => concat(cube(), invert(cube(20)));
const item = (mesh: MeshData) => ({ mesh, matrix: I });
const status = (mesh: MeshData, id: string) => checkMesh(wasm, item(mesh), 0.8).items.find((i) => i.id === id)!;

describe('repair of hollow objects', () => {
  it('keeps the cavity of a hollow cube with one outer triangle flipped', () => {
    const r = repairMesh(wasm, flipTriangle(hollowCube(), 0));
    const info = solidInfo(r.mesh);
    expect(info.volume).toBeCloseTo(56000, 0);
    expect(info.shells).toBe(2);
    expect(hasInsideOutShell(r.mesh)).toBe(false);
  });

  it('keeps the cavity of a fully inverted hollow cube', () => {
    const r = repairMesh(wasm, invert(hollowCube()));
    const info = solidInfo(r.mesh);
    expect(info.volume).toBeCloseTo(56000, 0);
    expect(info.shells).toBe(2);
  });

  it('keeps the cavity of a hollow cube with one outer triangle missing', () => {
    const hollow = hollowCube();
    const r = repairMesh(wasm, { positions: hollow.positions, indices: hollow.indices.slice(3) });
    const info = solidInfo(r.mesh);
    expect(info.volume).toBeCloseTo(56000, 0);
    expect(info.shells).toBe(2);
  });

  it('merges a cube overlapping the wall of a hollow cube without losing the cavity', () => {
    const m = concat(concat(cube(), moved(invert(cube(10)), -10, -10, -10)), moved(cube(10), 20, 0, 0));
    const r = repairMesh(wasm, m);
    expect(r.actions).toContain('Merged overlapping parts');
    const info = solidInfo(r.mesh);
    expect(info.volume).toBeCloseTo(64000 - 1000 + 500, 0);
    expect(info.shells).toBe(2);
    expect(status(r.mesh, 'overlaps').status).toBe('pass');
    // Without the cavity the same merge gives one shell.
    const plain = solidInfo(repairMesh(wasm, concat(cube(), moved(cube(10), 20, 0, 0))).mesh);
    expect(plain.volume).toBeCloseTo(64500, 0);
    expect(plain.shells).toBe(1);
  });
});

describe('a separate part that is inside out', () => {
  const layouts = {
    'far from the cube': { mesh: () => concat(cube(), invert(moved(cube(10), 100, 0, 0))), volume: 65000 },
    'in the notch of an L-shape': { mesh: () => concat(lShape(), invert(moved(cube(5), 10, 10, 0))), volume: 48125 },
  };
  for (const [name, layout] of Object.entries(layouts)) {
    it('is reported and repaired: ' + name, () => {
      const m = layout.mesh();
      const normals = status(m, 'normals');
      expect(normals.status).toBe('fail');
      expect(normals.fixable).toBe(true);
      expect(normals.detail).toBe('A separate part is inside out.');
      const r = repairMesh(wasm, m);
      expect(r.actions).toContain('Turned faces to point outward');
      const info = solidInfo(r.mesh);
      expect(info.volume).toBeCloseTo(layout.volume, 0);
      expect(info.shells).toBe(2);
      expect(hasInsideOutShell(r.mesh)).toBe(false);
      expect(status(r.mesh, 'normals').status).toBe('pass');
    });
  }
});

describe('nothing to repair', () => {
  it('returns the very same mesh for every primitive', () => {
    for (const kind of Object.keys(PRIMITIVE_NAMES) as PrimitiveKind[]) {
      const mesh = createPrimitive(wasm, kind);
      const r = repairMesh(wasm, mesh);
      expect(r.mesh, kind).toBe(mesh);
      expect(r.actions, kind).toEqual(['Nothing needed repairing']);
    }
  });

  it('returns the very same mesh after a chain of 20 random unions and differences', () => {
    let s = 7;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const kinds = Object.keys(PRIMITIVE_NAMES) as PrimitiveKind[];
    let cur = { mesh: cube(), matrix: I as ArrayLike<number> };
    for (let i = 0; i < 20; i++) {
      const tool = createPrimitive(wasm, kinds[Math.floor(rnd() * kinds.length)], 6 + rnd() * 14);
      const r = booleanOp(wasm, i % 3 === 0 ? 'union' : 'difference', [cur, { mesh: tool, matrix: T((rnd() - 0.5) * 40, (rnd() - 0.5) * 40, (rnd() - 0.5) * 40) }]);
      if (r.empty) continue;
      cur = { mesh: r.mesh, matrix: T(...r.center) };
    }
    const r = repairMesh(wasm, cur.mesh);
    expect(r.mesh).toBe(cur.mesh);
    expect(r.actions).toEqual(['Nothing needed repairing']);
  });
});

describe('meshes that cannot be checked', () => {
  const nan = () => {
    const c = cube();
    const positions = c.positions.slice();
    positions[0] = NaN;
    return { positions, indices: c.indices };
  };
  const empty = (): MeshData => ({ positions: new Float32Array(), indices: new Uint32Array() });

  it('check says so for a NaN coordinate and for an empty mesh', () => {
    for (const [mesh, text] of [[nan(), 'invalid numbers (NaN or infinity)'], [empty(), 'no usable surface (no triangles)']] as const) {
      const r = checkMesh(wasm, item(mesh), 0.8);
      expect(r.items.map((i) => i.id)).toEqual(['watertight', 'manifold', 'normals', 'overlaps', 'thickness', 'orientation']);
      expect(r.items[0]).toMatchObject({ id: 'watertight', status: 'fail', fixable: false });
      expect(r.items[0].detail).toContain(text);
      for (const other of r.items.slice(1)) expect(other).toMatchObject({ status: 'warn', detail: 'Fix the problem above first.', fixable: false });
      expect(r.suggestedDown).toBeNull();
    }
  });

  it('repair throws the same sentence', () => {
    expect(() => repairMesh(wasm, nan())).toThrow('invalid numbers (NaN or infinity)');
    expect(() => repairMesh(wasm, empty())).toThrow('no usable surface (no triangles)');
  });

  it('recentring an empty mesh gives the centre 0, 0, 0', () => {
    expect(recenter(empty()).center).toEqual([0, 0, 0]);
  });
});
