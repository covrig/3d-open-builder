import { unzipSync } from 'fflate';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { nestShells, shellsOf } from '../geometry/meshCheck';
import type { MeshData } from '../geometry/meshData';
import { runOp } from '../geometry/workerClient';
import { checkParts, parseMeshFile, partsFromGroup, type ImportedPart } from './meshParse';

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
 * (inside-out, so negative volume) goes with the piece that really contains it
 * (see nestShells); an inside-out surface with nothing around it stays a piece
 * of its own. Works on plain triangle data, so it also copes with meshes that
 * are not a valid solid. A mesh in one piece comes back as it is.
 */
export function splitPieces(mesh: MeshData): MeshData[] {
  const idx = mesh.indices;
  const p = mesh.positions;
  const shells = shellsOf(mesh);
  if (shells.length <= 1) return [mesh];
  const { depth, parent } = nestShells(mesh, shells);
  // Each outside surface (even depth) is a piece; the hollows directly inside it join it.
  const pieces = new Map<number, { shells: number[]; volume: number }>();
  shells.forEach((s, i) => { if (depth[i] % 2 === 0) pieces.set(i, { shells: [i], volume: s.volume }); });
  shells.forEach((s, i) => {
    if (depth[i] % 2 === 0) return;
    const owner = pieces.get(parent[i]);
    if (owner) {
      owner.shells.push(i);
      owner.volume += s.volume;
    } else {
      pieces.set(i, { shells: [i], volume: s.volume }); // nothing around it: a piece of its own
    }
  });
  return [...pieces.values()].sort((a, b) => b.volume - a.volume).map(({ shells: members }) => {
    const remap = new Map<number, number>();
    const positions: number[] = [];
    const indices: number[] = [];
    for (const s of members) {
      for (const t of shells[s].tris) {
        for (let k = 0; k < 3; k++) {
          const v = idx[t * 3 + k];
          let m = remap.get(v);
          if (m === undefined) {
            m = positions.length / 3;
            remap.set(v, m);
            positions.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
          }
          indices.push(m);
        }
      }
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  });
}

/** Millimetres per 3MF unit name. */
const THREE_MF_UNITS: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

/**
 * The factor that turns a 3MF file's own numbers into millimetres, from the
 * unit named on its root model (millimetre when it names none or an unknown one).
 */
export function threeMfUnitScale(bytes: Uint8Array): number {
  const files = unzipSync(bytes, { filter: (f) => f.name.toLowerCase().endsWith('.model') });
  const names = Object.keys(files);
  const root = names.find((n) => n.toLowerCase().endsWith('3dmodel.model')) ?? names[0];
  if (!root) return 1;
  const head = new TextDecoder().decode(files[root].subarray(0, 2048));
  const tag = /<(?:\w+:)?model\b[^>]*>/.exec(head)?.[0] ?? '';
  const unit = /\bunit\s*=\s*["']([^"']*)["']/.exec(tag)?.[1].toLowerCase();
  return (unit && THREE_MF_UNITS[unit]) || 1;
}

async function import3mf(buffer: ArrayBuffer, name: string): Promise<ImportedPart[]> {
  const scale = threeMfUnitScale(new Uint8Array(buffer));
  const parts = checkParts(partsFromGroup(new ThreeMFLoader().parse(buffer), name));
  if (scale !== 1) {
    for (const p of parts) {
      const pos = p.data.positions;
      for (let i = 0; i < pos.length; i++) pos[i] *= scale;
    }
  }
  return parts;
}

export async function importFile(file: File): Promise<ImportedPart[]> {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  const baseName = file.name.slice(0, file.name.lastIndexOf('.')) || file.name;
  switch (ext) {
    case '.stl':
      return readMeshFile({ format: 'stl', buffer: await file.arrayBuffer(), name: baseName });
    case '.3mf':
      return import3mf(await file.arrayBuffer(), baseName);
    case '.obj':
      return readMeshFile({ format: 'obj', text: await file.text(), name: baseName });
    default:
      throw new Error(`Unsupported file type "${ext}". Open a 3MF, STL or OBJ file.`);
  }
}
