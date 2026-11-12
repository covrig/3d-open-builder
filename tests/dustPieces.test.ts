import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { booleanOp, combineWithTools } from '../src/geometry/booleans';
import { shellsOf } from '../src/geometry/meshCheck';
import { meshDataToManifold, type MeshData } from '../src/geometry/meshData';
import { createPrimitive } from '../src/geometry/primitives';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const turnedAboutZ = (a: number) => [Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const cube = (s = 40) => createPrimitive(wasm, 'cube', { width: s, depth: s, height: s });
const volume = (m: MeshData) => {
  const s = meshDataToManifold(wasm, m);
  const v = s.volume();
  s.delete();
  return v;
};

describe('dust left by cuts that are a hair off', () => {
  for (const angle of [1e-8, 1e-7, 1e-6, 1e-5]) {
    it('subtracting a cube from itself turned ' + angle + ' rad leaves no object', () => {
      const [r] = combineWithTools(wasm, 'subtract', [{ mesh: cube(), matrix: I }], [{ mesh: cube(), matrix: turnedAboutZ(angle) }]);
      expect(r === null || r.length === 0).toBe(true);
    });
  }

  it('still gives the real slivers when the cutter is turned 0.1 rad', () => {
    const [r] = combineWithTools(wasm, 'subtract', [{ mesh: cube(), matrix: I }], [{ mesh: cube(), matrix: turnedAboutZ(0.1) }]);
    expect(r).not.toBeNull();
    expect(r!.length).toBeGreaterThan(0);
    for (const piece of r!) expect(volume(piece.mesh)).toBeGreaterThan(0.1);
  });

  it('leaves a target alone when the tool only grazes it by a film', () => {
    // The tool is the same cube, shifted so that only a 1e-4 mm slab overlaps.
    const [r] = combineWithTools(wasm, 'subtract', [{ mesh: cube(), matrix: I }], [{ mesh: cube(), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 40 - 1e-4, 0, 0, 1] }]);
    expect(r).toBeNull();
  });

  it('booleanOp: a difference that leaves only dust is empty', () => {
    const r = booleanOp(wasm, 'difference', [{ mesh: cube(), matrix: I }, { mesh: cube(), matrix: turnedAboutZ(1e-7) }]);
    expect(r).toEqual({ empty: true });
  });

  it('booleanOp: a tiny real object survives a union', () => {
    // 0.01 mm cube: mean thickness 0.0033 mm, well above the dust limit.
    const r = booleanOp(wasm, 'union', [{ mesh: cube(), matrix: I }, { mesh: cube(0.01), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, 0, 0, 1] }]);
    expect(r.empty).toBe(false);
    if (r.empty) return;
    const volumes = shellsOf(r.mesh).map((s) => s.volume).sort((a, b) => a - b);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toBeCloseTo(1e-6, 7);
    expect(volumes[0]).toBeGreaterThan(0.9e-6);
    expect(volumes[0]).toBeLessThan(1.1e-6);
  });
});
