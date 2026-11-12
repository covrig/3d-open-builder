import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MeshData } from '../geometry/meshData';

/**
 * Reading STL and OBJ files into mesh data. Kept apart from importFile.ts so
 * the geometry worker can run it: these readers need no page (3MF does: its
 * reader uses the page's XML parser, so 3MF stays on the page).
 */

export interface ImportedPart {
  name: string;
  /** World-space geometry, welded so shared corners are one vertex. */
  data: MeshData;
  /** #rrggbb, when the file says */
  color?: string;
}

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

function colorOf(material: THREE.Material | THREE.Material[]): string | undefined {
  const m = Array.isArray(material) ? material[0] : material;
  const color = (m as THREE.MeshStandardMaterial | undefined)?.color;
  return color ? `#${color.getHexString()}` : undefined;
}

/** Colours are only read from 3MF; the OBJ reader gives every part its default white. */
export function partsFromGroup(root: THREE.Object3D, fallbackName: string, readColors = true): ImportedPart[] {
  root.updateMatrixWorld(true);
  const parts: ImportedPart[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry.getAttribute('position')) return;
    parts.push({
      name: mesh.name || node.parent?.name || fallbackName,
      data: geometryToMeshData(mesh.geometry, mesh.matrixWorld),
      color: readColors ? colorOf(mesh.material) : undefined,
    });
  });
  return parts;
}

/**
 * Drop parts with no triangles; refuse a file with no usable geometry or with
 * NaN / infinite coordinates (those would break every later step).
 */
export function checkParts(parts: ImportedPart[]): ImportedPart[] {
  const usable = parts.filter((p) => p.data.indices.length > 0);
  if (usable.length === 0) throw new Error('This file has no usable geometry.');
  for (const p of usable) {
    const pos = p.data.positions;
    for (let i = 0; i < pos.length; i++) {
      if (!Number.isFinite(pos[i])) throw new Error('This file contains invalid numbers (NaN or infinity) and cannot be opened.');
    }
  }
  return usable;
}

/** An STL or OBJ file's parts (STL: the file's bytes; OBJ: its text). */
export function parseMeshFile(a: { format: 'stl'; buffer: ArrayBuffer; name: string } | { format: 'obj'; text: string; name: string }): ImportedPart[] {
  if (a.format === 'stl') return checkParts([{ name: a.name, data: geometryToMeshData(new STLLoader().parse(a.buffer), new THREE.Matrix4()) }]);
  return checkParts(partsFromGroup(new OBJLoader().parse(a.text), a.name, false));
}
