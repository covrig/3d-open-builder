import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { toPiece, type Piece } from './cut';
import { manifoldToMeshData, meshDataToManifold, type MeshData, type PlacedMesh } from './meshData';

/** union = Merge, difference = Subtract, intersection = Intersect */
export type BooleanOp = 'union' | 'difference' | 'intersection';

export type BooleanResult =
  | { empty: true }
  | {
      empty: false;
      /** mesh centred on its own bounding box */
      mesh: MeshData;
      /** world position of that centre */
      center: [number, number, number];
      volume: number;
    };

/**
 * Combine meshes in world space. For 'difference', the first item is kept and
 * all following items are cut away from it.
 */
export function booleanOp(
  wasm: ManifoldToplevel,
  op: BooleanOp,
  items: PlacedMesh[],
): BooleanResult {
  if (items.length < 2) throw new Error('Select at least two objects');
  const inputs: Manifold[] = [];
  let result: Manifold | undefined;
  let centered: Manifold | undefined;
  try {
    for (const item of items) inputs.push(meshDataToManifold(wasm, item.mesh, item.matrix));
    const { Manifold } = wasm;
    switch (op) {
      case 'union':
        result = Manifold.union(inputs);
        break;
      case 'difference':
        result = Manifold.difference(inputs);
        break;
      case 'intersection':
        result = Manifold.intersection(inputs);
        break;
    }
    const status = result.status();
    if (status !== 'NoError') throw new Error(`Operation failed (${status})`);
    if (result.isEmpty()) return { empty: true };

    const { min, max } = result.boundingBox();
    const center: [number, number, number] = [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ];
    centered = result.translate([-center[0], -center[1], -center[2]]);
    return { empty: false, mesh: manifoldToMeshData(centered), center, volume: centered.volume() };
  } finally {
    // WASM memory is not garbage-collected.
    for (const m of inputs) m.delete();
    result?.delete();
    centered?.delete();
  }
}

export type RoleOp = 'subtract' | 'intersect';

/**
 * Subtract or intersect with roles: each target is cut by all the tools at
 * once (their union). Subtract removes the tools from every target; intersect
 * keeps only the part of every target inside the tools. One result per
 * target, null where nothing is left.
 */
export function combineWithTools(
  wasm: ManifoldToplevel,
  op: RoleOp,
  targets: PlacedMesh[],
  tools: PlacedMesh[],
): (Piece | null)[] {
  if (targets.length === 0 || tools.length === 0) throw new Error('Mark at least one object of each kind');
  const owned: Manifold[] = [];
  const keep = (m: Manifold) => (owned.push(m), m);
  try {
    const cutter = keep(wasm.Manifold.union(tools.map((t) => keep(meshDataToManifold(wasm, t.mesh, t.matrix)))));
    return targets.map((t) => {
      const solid = keep(meshDataToManifold(wasm, t.mesh, t.matrix));
      const result = keep(op === 'subtract' ? solid.subtract(cutter) : solid.intersect(cutter));
      const status = result.status();
      if (status !== 'NoError') throw new Error(`Operation failed (${status})`);
      return toPiece(result);
    });
  } finally {
    for (const m of owned) m.delete();
  }
}