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
