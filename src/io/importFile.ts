import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import type { MeshData } from '../geometry/meshData';
import { runOp } from '../geometry/workerClient';
import { parseMeshFile, partsFromGroup, type ImportedPart } from './meshParse';

export { geometryToMeshData, type ImportedPart } from './meshParse';

export const IMPORT_EXTENSIONS = ['.3mf', '.stl', '.obj'];

/**
 * Read an STL or OBJ file in the geometry worker, so a big file doesn't hold
 * up the page (welding a large STL's corners takes a while). Without workers
 * (the tests run that way) it is read right here.
 */
function readMeshFile(a: Parameters<typeof parseMeshFile>[0]): Promise<ImportedPart[]> {
  if (typeof Worker === 'undefined') return Promise.resolve(parseMeshFile(a));
  return runOp('parseMesh', a);
}

/**
 * Split a welded mesh into its separate solid pieces: groups of triangles
 * connected through shared vertices, largest first. A hollow's inside surface
 * (inside-out, so negative volume) stays with the smallest piece around it.
 * Works on plain triangle data, so it also copes with meshes that are not a
 * valid solid. A mesh in one piece comes back as it is.
 */
export function splitPieces(mesh: MeshData): MeshData[] {
  const idx = mesh.indices;
  const p = mesh.positions;
  const n = p.length / 3;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(idx[t]);
    parent[find(idx[t + 1])] = a;
    parent[find(idx[t + 2])] = a;
  }
  const groups = new Map<number, { tris: number[]; volume: number; min: number[]; max: number[] }>();
  for (let t = 0; t < idx.length; t += 3) {
    const root = find(idx[t]);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = { tris: [], volume: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    g.tris.push(t);
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    g.volume += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    for (const o of [a, b, c]) for (let k = 0; k < 3; k++) {
      g.min[k] = Math.min(g.min[k], p[o + k]);
      g.max[k] = Math.max(g.max[k], p[o + k]);
    }
  }
  if (groups.size <= 1) return [mesh];
  const all = [...groups.values()];
  const solids = all.filter((g) => g.volume > 0).sort((a, b) => b.volume - a.volume);
  if (solids.length === 0) return [mesh];
  const within = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) =>
    [0, 1, 2].every((k) => a.min[k] >= b.min[k] - 1e-6 && a.max[k] <= b.max[k] + 1e-6);
  for (const h of all.filter((g) => g.volume <= 0)) {
    const owner = [...solids].reverse().find((s) => within(h, s));
    if (owner) owner.tris.push(...h.tris);
    else solids.push(h); // an inside-out surface with nothing around it stays a piece of its own
  }
  return solids.map(({ tris }) => {
    const remap = new Map<number, number>();
    const positions: number[] = [];
    const indices: number[] = [];
    for (const t of tris) for (let k = 0; k < 3; k++) {
      const v = idx[t + k];
      let m = remap.get(v);
      if (m === undefined) {
        m = positions.length / 3;
        remap.set(v, m);
        positions.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
      }
      indices.push(m);
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  });
}

export async function importFile(file: File): Promise<ImportedPart[]> {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  const baseName = file.name.slice(0, file.name.lastIndexOf('.')) || file.name;
  switch (ext) {
    case '.stl':
      return readMeshFile({ format: 'stl', buffer: await file.arrayBuffer(), name: baseName });
    case '.3mf':
      return partsFromGroup(new ThreeMFLoader().parse(await file.arrayBuffer()), baseName);
    case '.obj':
      return readMeshFile({ format: 'obj', text: await file.text(), name: baseName });
    default:
      throw new Error(`Unsupported file type "${ext}". Open a 3MF, STL or OBJ file.`);
  }
}
