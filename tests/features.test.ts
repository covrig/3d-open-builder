import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { findEdges } from '../src/geometry/edges';
import { centredRowMoves, edgeTreatment, gusset, shell } from '../src/geometry/features';
import { bakeMesh, meshDataToManifold, type MeshData } from '../src/geometry/meshData';
import { bounds } from '../src/geometry/meshOps';
import { countPieces } from '../src/geometry/meshCheck';
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

/** An L-shaped block: 40×40×10 floor plus a 10×40×40 wall, with an inside corner. */
function lBlock(): MeshData {
  const floor = wasm.Manifold.cube([40, 40, 10]);
  const wall = wasm.Manifold.cube([10, 40, 40]);
  const l = floor.add(wall);
  const mesh = l.getMesh();
  const out = { positions: mesh.vertProperties.slice(), indices: mesh.triVerts.slice() };
  floor.delete(); wall.delete(); l.delete();
  return out;
}

describe('findEdges', () => {
  it('finds the 12 edges of a cube, all convex, as 12 chains', () => {
    const e = findEdges(createPrimitive(wasm, 'cube'));
    expect(e.segments.length).toBe(12);
    expect(e.segments.every((s) => s.convex)).toBe(true);
    expect(e.chains.length).toBe(12);
  });

  it('groups a cylinder rim into one chain', () => {
    const e = findEdges(createPrimitive(wasm, 'cylinder'));
    const big = e.chains.filter((c) => c.length > 10);
    expect(big.length).toBe(2); // top and bottom rims
  });

  it('marks the inside corner of an L block as concave', () => {
    const e = findEdges(lBlock());
    expect(e.segments.some((s) => !s.convex)).toBe(true);
  });
});

describe('chamfer and fillet', () => {
  const cube = () => createPrimitive(wasm, 'cube');

  it('chamfers one cube edge by exactly the cut-off prism', () => {
    const edges = findEdges(cube());
    const r = edgeTreatment(wasm, { mesh: cube(), matrix: IDENTITY }, [edges.segments[0]], 'chamfer', 5);
    // Removed: right triangle with 5 mm legs along a 40 mm edge = 12.5 × 40.
    expect(volume(r.mesh)).toBeCloseTo(64000 - 500, 0);
  });

  it('fillets one cube edge by the corner minus a quarter circle', () => {
    const edges = findEdges(cube());
    const r = edgeTreatment(wasm, { mesh: cube(), matrix: IDENTITY }, [edges.segments[0]], 'fillet', 5);
    const removed = (25 - (Math.PI * 25) / 4) * 40; // (r² − πr²/4) × length
    expect(64000 - volume(r.mesh)).toBeCloseTo(removed, -1);
  });

  it('fillets all edges of a cube into a rounded box with spherical corners', () => {
    const r = 5;
    const edges = findEdges(cube());
    const out = edgeTreatment(wasm, { mesh: cube(), matrix: IDENTITY }, edges.segments, 'fillet', r);
    // Exact rounded box: core + 6 face slabs + 12 quarter-cylinders + 8 sphere octants.
    const L = 40 - 2 * r;
    const exact = L ** 3 + 6 * L * L * r + 3 * Math.PI * r * r * L + (4 / 3) * Math.PI * r ** 3;
    expect(Math.abs(volume(out.mesh) - exact) / exact).toBeLessThan(0.003);
    // Clean result: a rounded box needs no tiny leftover slivers, so far fewer than 20k triangles.
    expect(out.mesh.indices.length / 3).toBeLessThan(20000);
  });

  it('chamfers all edges of a cube without leftovers at the corners', () => {
    const d = 4;
    const edges = findEdges(cube());
    const out = edgeTreatment(wasm, { mesh: cube(), matrix: IDENTITY }, edges.segments, 'chamfer', d);
    // 12 edge prisms (d²/2 × 40) overlap at the 8 corners: each pair shares d³/3,
    // all three share d³/4, so each corner was counted d³ − d³/4 too often.
    const exact = 64000 - 12 * (d * d / 2) * 40 + 8 * (d ** 3 - d ** 3 / 4);
    expect(volume(out.mesh)).toBeCloseTo(exact, 0);
  });

  it('chamfers a curved rim without spikes or tabs', () => {
    const cyl = createPrimitive(wasm, 'cylinder');
    const top = findEdges(cyl).segments.filter((s) => s.a[2] > 19 && s.b[2] > 19);
    const out = edgeTreatment(wasm, { mesh: cyl, matrix: IDENTITY }, top, 'chamfer', 2);
    const b = bounds(out.mesh);
    // Nothing sticks out of the original 40 × 40 × 40 envelope.
    expect(b.max[0] - b.min[0]).toBeLessThanOrEqual(40.01);
    expect(b.max[2] - b.min[2]).toBeLessThanOrEqual(40.01);
    const removed = volume(cyl) - volume(out.mesh);
    expect(removed).toBeGreaterThan(0);
    expect(removed).toBeLessThan(2 * Math.PI * 20 * 2 * 1.2); // about 2 mm × 2 mm / 2 around the rim
  });

  it('leaves no loose slivers on curved and slanted shapes', () => {
    for (const kind of ['cylinder', 'cone', 'pyramid', 'wedge'] as const) {
      const mesh = createPrimitive(wasm, kind);
      for (const k of ['chamfer', 'fillet'] as const) {
        const out = edgeTreatment(wasm, { mesh, matrix: IDENTITY }, findEdges(mesh).segments, k, 2);
        expect(countPieces(out.mesh), `${kind} ${k}`).toBe(1);
      }
    }
  });

  it('leaves no fins standing at the joints of a cylinder rim', () => {
    const cyl = createPrimitive(wasm, 'cylinder'); // radius 20, z from -20 to 20
    const top = findEdges(cyl).segments.filter((s) => s.a[2] > 19.99 && s.b[2] > 19.99);
    for (const kind of ['chamfer', 'fillet'] as const) {
      const d = 2;
      const out = edgeTreatment(wasm, { mesh: cyl, matrix: IDENTITY }, top, kind, d);
      const p = out.mesh.positions;
      let worst = 0;
      for (let i = 0; i < p.length; i += 3) {
        const up = p[i + 2] + out.center[2] - (20 - d);
        if (up <= 0.01) continue;
        const r = Math.hypot(p[i] + out.center[0], p[i + 1] + out.center[1]);
        const allowed = kind === 'chamfer' ? 20 - up : 20 - d + Math.sqrt(Math.max(0, d * d - up * up));
        worst = Math.max(worst, r - allowed);
      }
      expect(worst, kind).toBeLessThan(0.05);
    }
  });

  it('fully chamfers and fillets slanted shapes without plates, dents or loose parts', () => {
    // A chamfered or filleted convex shape stays convex: its hull is no bigger than itself.
    for (const kind of ['wedge', 'hexagon', 'pyramid'] as const) {
      const mesh = createPrimitive(wasm, kind);
      for (const k of ['chamfer', 'fillet'] as const) {
        for (const size of [2, 5]) {
          const out = edgeTreatment(wasm, { mesh, matrix: IDENTITY }, findEdges(mesh).segments, k, size);
          const m = meshDataToManifold(wasm, out.mesh);
          const hull = m.hull();
          const dent = hull.volume() - m.volume();
          const pieces = m.decompose().length;
          m.delete();
          hull.delete();
          expect(dent, `${kind} ${k} ${size}`).toBeLessThan(1);
          expect(pieces, `${kind} ${k} ${size}`).toBe(1);
        }
      }
    }
  });

  it('adds material in an inside corner', () => {
    const l = lBlock();
    const inner = findEdges(l).segments.filter((s) => !s.convex);
    const before = volume(l);
    const r = edgeTreatment(wasm, { mesh: l, matrix: IDENTITY }, inner, 'chamfer', 4);
    expect(volume(r.mesh) - before).toBeCloseTo(8 * 40, 0); // 4×4/2 × 40 mm
  });
});

describe('chamfer and fillet at an inside corner of a rim', () => {
  /** 40 mm cube (x, y -20..20, z 0..40) with a notch x 7..20, y -20..3, z 11..40: the top face is L-shaped. */
  function notched(): MeshData {
    const cube = wasm.Manifold.cube([40, 40, 40]).translate([-20, -20, 0]);
    const box = wasm.Manifold.cube([13, 23, 29]).translate([7, -20, 11]);
    const m = cube.subtract(box);
    const mesh = m.getMesh();
    const out = { positions: mesh.vertProperties.slice(), indices: mesh.triVerts.slice() };
    cube.delete(); box.delete(); m.delete();
    return out;
  }
  const onTop = (s: { a: number[]; b: number[] }) => s.a[2] > 39.99 && s.b[2] > 39.99;
  const rims = (mesh: MeshData) => {
    const top = findEdges(mesh).segments.filter(onTop);
    // x = 7 rim (y -20..3) and y = 3 rim (x 7..20).
    const rimX = top.filter((s) => Math.abs(s.a[0] - 7) < 1e-3 && Math.abs(s.b[0] - 7) < 1e-3);
    const rimY = top.filter((s) => Math.abs(s.a[1] - 3) < 1e-3 && Math.abs(s.b[1] - 3) < 1e-3);
    return { rimX, rimY };
  };
  const contains = (mesh: MeshData, p: [number, number, number]) => {
    const solid = meshDataToManifold(wasm, mesh);
    const probe = wasm.Manifold.cube([0.02, 0.02, 0.02]).translate([p[0] - 0.01, p[1] - 0.01, p[2] - 0.01]);
    const hit = solid.intersect(probe);
    const v = hit.volume();
    solid.delete(); probe.delete(); hit.delete();
    return v > 0.02 ** 3 * 0.99;
  };

  it('chamfers the rim ending at the reflex corner without cutting into the top face', () => {
    const mesh = notched();
    const { rimX, rimY } = rims(mesh);
    expect(rimX.length).toBeGreaterThan(0);
    expect(rimY.length).toBeGreaterThan(0);
    const before = volume(mesh);
    const one = edgeTreatment(wasm, { mesh, matrix: IDENTITY }, rimX, 'chamfer', 2);
    expect(before - volume(one.mesh)).toBeCloseTo(2 * 2 / 2 * 23, 0);
    const both = edgeTreatment(wasm, { mesh, matrix: IDENTITY }, [...rimX, ...rimY], 'chamfer', 2);
    const removed = before - volume(both.mesh);
    expect(removed).toBeLessThanOrEqual(72 + 0.5);
    expect(removed).toBeGreaterThan(72 - 0.5);
    // The top face past the corner (x < 7, y > 3) is untouched.
    const world = (m: MeshData, c: [number, number, number]) => {
      const pm = { positions: m.positions.slice(), indices: m.indices };
      for (let i = 0; i < pm.positions.length; i += 3) for (let k = 0; k < 3; k++) pm.positions[i + k] += c[k];
      return pm;
    };
    const res = world(both.mesh, both.center);
    expect(contains(res, [5, 5, 39.9])).toBe(true);
    expect(contains(res, [-10, 10, 39.9])).toBe(true);
    expect(contains(res, [6.5, 3.5, 39.9])).toBe(true);
  });

  it('rounds both rims into a valid solid without overcutting', () => {
    const mesh = notched();
    const { rimX, rimY } = rims(mesh);
    const before = volume(mesh);
    const out = edgeTreatment(wasm, { mesh, matrix: IDENTITY }, [...rimX, ...rimY], 'fillet', 2);
    const removed = before - volume(out.mesh);
    expect(removed).toBeGreaterThan(0);
    expect(removed).toBeLessThan(72);
    expect(countPieces(out.mesh)).toBe(1);
  });
});

describe('gusset and shell', () => {
  it('adds a triangular gusset in the inside corner', () => {
    const l = lBlock();
    const edge = findEdges(l).segments.find((s) => !s.convex)!;
    const r = gusset(wasm, { mesh: l, matrix: IDENTITY }, edge, { leg1: 15, leg2: 15, thickness: 3, position: 0.5 });
    const added = volume(r.mesh) - volume(l);
    expect(added).toBeGreaterThan(15 * 15 / 2 * 3 * 0.9);
    expect(added).toBeLessThan(15 * 15 / 2 * 3 * 1.1);
  });

  it('refuses a gusset on an outside edge', () => {
    const edge = findEdges(createPrimitive(wasm, 'cube')).segments[0];
    expect(() => gusset(wasm, { mesh: createPrimitive(wasm, 'cube'), matrix: IDENTITY }, edge,
      { leg1: 5, leg2: 5, thickness: 2, position: 0.5 })).toThrow(/inside corner/);
  });

  it('hollows a cube leaving walls of the given thickness', () => {
    const r = shell(wasm, { mesh: createPrimitive(wasm, 'cube'), matrix: IDENTITY }, 2);
    // Shrinking a box by a sphere keeps its corners sharp: the cavity is exactly a 36 mm cube.
    expect(volume(r.mesh)).toBeCloseTo(64000 - 36 ** 3, 0);
  });

});

// Keep the import used even if a test above is skipped.
void bakeMesh;

describe('centredRowMoves', () => {
  it('centres a row of items on a point, spacing apart', () => {
    const moves = centredRowMoves(4, 10, [1, 0, 0], [100, 5, 0], [0, 5, 0]);
    expect(moves.map((m) => m[0])).toEqual([85, 95, 105, 115]);
    expect(moves.every((m) => m[1] === 0 && m[2] === 0)).toBe(true);
  });
  it('puts an odd count symmetrically about the point', () => {
    const moves = centredRowMoves(3, 4, [0, 0, 1], [0, 0, 0], [0, 0, 0]);
    expect(moves.map((m) => m[2])).toEqual([-4, 0, 4]);
  });
});
