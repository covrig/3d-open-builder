import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MeshData } from '../geometry/meshData';

export interface ImportedPart {
  name: string;
  /** World-space geometry, welded so shared corners are one vertex. */
  data: MeshData;
  /** #rrggbb, when the file says */
  color?: string;
}

export const IMPORT_EXTENSIONS = ['.3mf', '.stl', '.obj'];

/**
 * Turn a Three.js geometry into indexed MeshData in world space. STL and
 * most loaders give one separate vertex per triangle corner; Manifold needs
 * shared vertices to see a closed solid, so positions are merged.
 */
export function geometryToMeshData(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): MeshData {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', geometry.getAttribute('position').clone());
  if (geometry.index) g.setIndex(geometry.index.clone());
  g.applyMatrix4(matrix);
  const welded = mergeVertices(g, 1e-4);
  g.dispose();

  const positions = new Float32Array(welded.getAttribute('position').array);
  const indices = new Uint32Array(welded.index!.array);
  welded.dispose();
  // A mirroring transform turns faces inside out; flip them back.
  if (matrix.determinant() < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = t;
    }
  }
  return { positions, indices };
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

function colorOf(material: THREE.Material | THREE.Material[]): string | undefined {
  const m = Array.isArray(material) ? material[0] : material;
  const color = (m as THREE.MeshStandardMaterial | undefined)?.color;
  return color ? `#${color.getHexString()}` : undefined;
}

function partsFromGroup(root: THREE.Object3D, fallbackName: string): ImportedPart[] {
  root.updateMatrixWorld(true);
  const parts: ImportedPart[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry.getAttribute('position')) return;
    parts.push({
      name: mesh.name || node.parent?.name || fallbackName,
      data: geometryToMeshData(mesh.geometry, mesh.matrixWorld),
      color: colorOf(mesh.material),
    });
  });
  return parts;
}

export async function importFile(file: File): Promise<ImportedPart[]> {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  const baseName = file.name.slice(0, file.name.lastIndexOf('.')) || file.name;
  switch (ext) {
    case '.stl': {
      const geometry = new STLLoader().parse(await file.arrayBuffer());
      return [{ name: baseName, data: geometryToMeshData(geometry, new THREE.Matrix4()) }];
    }
    case '.3mf':
      return partsFromGroup(new ThreeMFLoader().parse(await file.arrayBuffer()), baseName);
    case '.obj':
      return partsFromGroup(new OBJLoader().parse(await file.text()), baseName);
    default:
      throw new Error(`Unsupported file type "${ext}". Open a 3MF, STL or OBJ file.`);
  }
}
