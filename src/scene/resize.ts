import * as THREE from 'three';
import { bakeMesh, type MeshData } from '../geometry/meshData';
import { recenter } from '../geometry/meshOps';

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

/** What places an object: its shape and its position, turn and size. */
export interface Placement {
  data: MeshData;
  position: V3;
  quaternion: Q4;
  scale: V3;
}

const EPS = 1e-6;
const nearZeroOrOne = (v: number) => Math.abs(v) < EPS || Math.abs(Math.abs(v) - 1) < EPS;

/** True when the turn only swaps or flips the world axes (multiples of 90 degrees). */
export function isAxisAligned(quaternion: ArrayLike<number> | THREE.Quaternion): boolean {
  const q = quaternion instanceof THREE.Quaternion ? quaternion : new THREE.Quaternion(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
  for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) if (!nearZeroOrOne(m[i])) return false;
  return true;
}

/**
 * Stretch an object by factors along the WORLD axes, about a world point.
 * An object lined up with the axes (or a stretch that is the same everywhere)
 * only changes its position and size numbers. A turned object is stretched
 * along the world axes by changing its mesh: the shape is baked, centred
 * again, and the turn and size go back to neutral.
 */
export function stretchWorld(state: Placement, f: V3, anchor: V3): Placement {
  const position: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) position[k] = anchor[k] + (state.position[k] - anchor[k]) * f[k];
  const uniform = f[0] === f[1] && f[1] === f[2];
  if (uniform) {
    return { data: state.data, position, quaternion: [...state.quaternion], scale: state.scale.map((s) => s * f[0]) as V3 };
  }
  if (isAxisAligned(state.quaternion)) {
    const rot = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...state.quaternion)).elements;
    const scale: V3 = [...state.scale];
    for (let a = 0; a < 3; a++) {
      // The object's own axis (column) that runs along world axis a.
      const k = [0, 1, 2].find((c) => Math.abs(rot[c * 4 + a]) > 0.5)!;
      scale[k] *= f[a];
    }
    return { data: state.data, position, quaternion: [...state.quaternion], scale };
  }
  const rs = new THREE.Matrix4()
    .makeRotationFromQuaternion(new THREE.Quaternion(...state.quaternion))
    .multiply(new THREE.Matrix4().makeScale(...state.scale));
  const stretched = new THREE.Matrix4().makeScale(...f).multiply(rs);
  const { mesh, center } = recenter(bakeMesh({ mesh: state.data, matrix: stretched.elements }));
  return {
    data: mesh,
    position: [position[0] + center[0], position[1] + center[1], position[2] + center[2]],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

/** The matrix that stretches world points by f about the anchor (for previews). */
export function stretchMatrix(f: V3, anchor: V3): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeTranslation(anchor[0], anchor[1], anchor[2])
    .multiply(new THREE.Matrix4().makeScale(f[0], f[1], f[2]))
    .multiply(new THREE.Matrix4().makeTranslation(-anchor[0], -anchor[1], -anchor[2]));
}
