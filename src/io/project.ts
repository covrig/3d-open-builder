import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { validateSaved, type SavedScene } from '../app/autosave';
import type { MeshData } from '../geometry/meshData';

/**
 * The project file: a zip with scene.json (everything except the meshes) and
 * the meshes as raw bytes, one pair of files per distinct mesh. No DOM here,
 * so it can be tested in Node.
 */
export const PROJECT_EXTENSION = '.3dob';
const FORMAT = '3d-open-builder-project';

const NOT_A_PROJECT = 'This is not a 3D Open Builder project file, or it was made by a newer version.';
const DAMAGED = 'This project file is damaged and cannot be opened.';

const bytesOf = (a: Float32Array | Uint32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** Copy bytes into a fresh, aligned buffer and read them as numbers. */
function floats(u8: Uint8Array): Float32Array {
  if (u8.length % 4 !== 0) throw new Error(DAMAGED);
  return new Float32Array(u8.slice().buffer);
}
function uints(u8: Uint8Array): Uint32Array {
  if (u8.length % 4 !== 0) throw new Error(DAMAGED);
  return new Uint32Array(u8.slice().buffer);
}

export function writeProject(saved: SavedScene): Uint8Array {
  const files: Zippable = {};
  const numbers = new Map<MeshData, number>(); // objects sharing a mesh share its entry
  const objects = saved.objects.map((o) => {
    const { data, ...rest } = o;
    let n = numbers.get(data);
    if (n === undefined) {
      n = numbers.size;
      numbers.set(data, n);
      files[`meshes/${n}.pos`] = [bytesOf(data.positions), { level: 1 }];
      files[`meshes/${n}.idx`] = [bytesOf(data.indices), { level: 1 }];
    }
    return { ...rest, mesh: n };
  });
  const json = JSON.stringify({
    format: FORMAT,
    version: 1,
    savedAt: saved.savedAt,
    name: saved.name,
    objects,
    measurements: saved.measurements,
    extras: saved.extras ?? {},
  });
  files['scene.json'] = strToU8(json);
  return zipSync(files);
}

export function readProject(bytes: Uint8Array): SavedScene {
  let raw: Record<string, unknown>;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
    const scene = entries['scene.json'];
    if (!scene) throw new Error(DAMAGED);
    raw = JSON.parse(strFromU8(scene));
  } catch {
    throw new Error(DAMAGED);
  }
  if (!raw || typeof raw !== 'object' || raw.format !== FORMAT || raw.version !== 1) throw new Error(NOT_A_PROJECT);
  try {
    if (!Array.isArray(raw.objects)) throw new Error(DAMAGED);
    const meshes = new Map<number, MeshData>();
    const objects = (raw.objects as Record<string, unknown>[]).map((o) => {
      const { mesh, ...rest } = o;
      if (typeof mesh !== 'number') throw new Error(DAMAGED);
      let data = meshes.get(mesh);
      if (!data) {
        const pos = entries[`meshes/${mesh}.pos`];
        const idx = entries[`meshes/${mesh}.idx`];
        if (!pos || !idx) throw new Error(DAMAGED);
        data = { positions: floats(pos), indices: uints(idx) };
        meshes.set(mesh, data);
      }
      return { ...rest, data };
    });
    return validateSaved({
      version: 1,
      savedAt: raw.savedAt,
      name: raw.name,
      objects,
      measurements: raw.measurements,
      extras: raw.extras,
    });
  } catch {
    throw new Error(DAMAGED);
  }
}
