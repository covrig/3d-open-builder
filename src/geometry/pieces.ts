import type { Manifold, Mesh } from 'manifold-3d';
import { nestShells, shellsOf } from './meshCheck';
import { manifoldToMeshData, type MeshData } from './meshData';

/**
 * One manifold from the surfaces `members` (indices into `parts`), or null if Manifold refuses it.
 * Nothing is computed: the triangles are just put side by side, so hollows stay exactly as they are.
 * The constructors are reached through the instances, so no `wasm` is needed.
 */
function join(m: Manifold, parts: Manifold[], meshes: MeshData[], members: number[]): Manifold | null {
  const positions = new Float32Array(members.reduce((n, k) => n + meshes[k].positions.length, 0));
  const triVerts = new Uint32Array(members.reduce((n, k) => n + meshes[k].indices.length, 0));
  let pv = 0, pi = 0;
  for (const k of members) {
    positions.set(meshes[k].positions, pv * 3);
    for (let i = 0; i < meshes[k].indices.length; i++) triVerts[pi + i] = meshes[k].indices[i] + pv;
    pv += meshes[k].positions.length / 3;
    pi += meshes[k].indices.length;
  }
  const MeshClass = parts[members[0]].getMesh().constructor as typeof Mesh;
  const joined = new (m.constructor as new (mesh: Mesh) => Manifold)(new MeshClass({ numProp: 3, vertProperties: positions, triVerts }));
  if (joined.status() === 'NoError') return joined;
  joined.delete();
  return null;
}

/**
 * The separate solid pieces of a manifold, largest first; the caller deletes them.
 *
 * Manifold's decompose() splits by surfaces, so a hollow inside a solid (a
 * sphere subtracted from inside a cube, the inside of a shelled object) comes
 * out as a "part" of its own: an inside-out surface with negative volume, and
 * the solid around it comes out filled. Here the surfaces are sorted by how
 * they sit inside each other (see nestShells): each piece is an outside
 * surface together with the hollows whose parent it is, joined without any
 * boolean operation (the surfaces are put into one mesh; Manifold's own
 * compose drops an inside-out surface). A part floating inside a hollow is a piece of its own. A
 * surface that faces the wrong way for where it sits (an inside-out part with
 * nothing around it) is kept as a piece with its negative volume, so callers
 * can still tell a truly inside-out object.
 */
export function solidPieces(m: Manifold): Manifold[] {
  const parts = m.decompose();
  if (parts.length <= 1) return parts;

  // One mesh of all the parts, to work out how they nest.
  const meshes: MeshData[] = parts.map(manifoldToMeshData);
  const positions = new Float32Array(meshes.reduce((n, d) => n + d.positions.length, 0));
  const indices = new Uint32Array(meshes.reduce((n, d) => n + d.indices.length, 0));
  const firstTri: number[] = [];
  let pv = 0, pi = 0;
  for (const d of meshes) {
    firstTri.push(pi / 3);
    positions.set(d.positions, pv * 3);
    for (let i = 0; i < d.indices.length; i++) indices[pi + i] = d.indices[i] + pv;
    pv += d.positions.length / 3;
    pi += d.indices.length;
  }
  const all: MeshData = { positions, indices };
  const shells = shellsOf(all);
  const { depth, parent } = nestShells(all, shells);
  /** The part a shell was made from (parts own consecutive triangle ranges). */
  const partOf = (shell: number) => {
    const t = shells[shell].tris[0];
    let k = firstTri.length - 1;
    while (firstTri[k] > t) k--;
    return k;
  };

  // Each outside surface (even depth) gathers the hollows directly inside it.
  const groups = new Map<number, number[]>();
  for (let s = 0; s < shells.length; s++) if (depth[s] % 2 === 0) groups.set(partOf(s), [partOf(s)]);
  for (let s = 0; s < shells.length; s++) {
    if (depth[s] % 2 === 1) groups.get(partOf(parent[s]))?.push(partOf(s));
  }

  const pieces: Manifold[] = [];
  const used = new Set<number>();
  for (const members of groups.values()) {
    for (const k of members) used.add(k);
    const joined = members.length > 1 ? join(m, parts, meshes, members) : null;
    if (joined) {
      pieces.push(joined);
      for (const k of members) parts[k].delete();
    } else {
      for (const k of members) pieces.push(parts[k]);
    }
  }
  // A surface that found no place in any group (only odd meshes) is kept as a piece of its own.
  parts.forEach((part, k) => { if (!used.has(k)) pieces.push(part); });
  return pieces.map((p) => ({ p, v: p.volume() })).sort((a, b) => b.v - a.v).map((s) => s.p);
}
