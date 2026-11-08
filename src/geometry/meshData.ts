import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';

/**
 * Plain triangle mesh, independent of Three.js and Manifold, so it can be
 * stored in the scene, saved, exported and tested in Node.
 * Units are millimetres; Z is up.
 */
export interface MeshData {
  /** x, y, z per vertex */
  positions: Float32Array;
  /** three vertex indices per triangle, counter-clockwise seen from outside */
  indices: Uint32Array;
}

/** A mesh plus the column-major 4x4 world matrix that places it in the scene. */
export interface PlacedMesh {
  mesh: MeshData;
  matrix: ArrayLike<number>;
}

export function manifoldToMeshData(m: Manifold): MeshData {
  const mesh = m.getMesh();
  const numProp = mesh.numProp;
  const vertCount = mesh.vertProperties.length / numProp;
  let positions: Float32Array;
  if (numProp === 3) {
    positions = mesh.vertProperties.slice();
  } else {
    positions = new Float32Array(vertCount * 3);
    for (let i = 0; i < vertCount; i++) {
      positions[i * 3] = mesh.vertProperties[i * numProp];
      positions[i * 3 + 1] = mesh.vertProperties[i * numProp + 1];
      positions[i * 3 + 2] = mesh.vertProperties[i * numProp + 2];
    }
  }
  // getMesh() splits vertices along the seams between the solids a result was
  // made from, and lists which copies belong together; join them again so the
  // mesh stays one closed, watertight surface.
  const indices = mesh.triVerts.slice();
  const from = mesh.mergeFromVert, to = mesh.mergeToVert;
  if (from && to && from.length) {
    const map = new Map<number, number>();
    for (let i = 0; i < from.length; i++) map.set(from[i], to[i]);
    for (let i = 0; i < indices.length; i++) {
      const j = map.get(indices[i]);
      if (j !== undefined) indices[i] = j;
    }
  }
  return { positions, indices };
}

/**
 * Build a Manifold from mesh data, optionally transformed by a world matrix.
 * Throws if the mesh is not a closed, watertight solid.
 */
export function meshDataToManifold(
  wasm: ManifoldToplevel,
  data: MeshData,
  matrix?: ArrayLike<number>,
): Manifold {
  const mesh = new wasm.Mesh({
    numProp: 3,
    vertProperties: data.positions,
    triVerts: data.indices,
  });
  // Welds vertices that share a position, in case the mesh came from a file
  // format that duplicates them (STL does this for every triangle).
  mesh.merge();
  let m = new wasm.Manifold(mesh);
  const status = m.status();
  if (status !== 'NoError') {
    m.delete();
    throw new Error(`Mesh is not a valid solid (${status})`);
  }
  if (matrix) {
    const t = m.transform(Array.from(matrix) as Mat4);
    m.delete();
    m = t;
  }
  return m;
}

/**
 * Apply a column-major 4x4 matrix to the vertices. If the matrix mirrors the
 * mesh (negative determinant), triangle winding is flipped so faces keep
 * pointing outward.
 */
export function bakeMesh({ mesh, matrix: e }: PlacedMesh): MeshData {
  const p = mesh.positions;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  const det =
    e[0] * (e[5] * e[10] - e[9] * e[6]) -
    e[4] * (e[1] * e[10] - e[9] * e[2]) +
    e[8] * (e[1] * e[6] - e[5] * e[2]);
  let indices = mesh.indices;
  if (det < 0) {
    indices = indices.slice();
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = t;
    }
  }
  return { positions: out, indices };
}
