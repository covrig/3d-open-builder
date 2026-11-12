import { bakeMesh, type PlacedMesh } from '../geometry/meshData';
import { triangleNormal } from '../geometry/triangles';

/**
 * Binary STL: 80-byte header, uint32 triangle count, then 50 bytes per
 * triangle (normal, 3 vertices, uint16 attribute). All objects are written
 * into one file in world coordinates. STL has no standard colour support.
 */
export function exportStl(items: PlacedMesh[]): ArrayBuffer {
  const baked = items.map(bakeMesh);
  const triCount = baked.reduce((n, m) => n + m.indices.length / 3, 0);
  const buffer = new ArrayBuffer(84 + 50 * triCount);
  const view = new DataView(buffer);

  const header = 'Exported by 3D Open Builder';
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, triCount, true);

  let offset = 84;
  const n = [0, 0, 0];
  for (const { positions: p, indices } of baked) {
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
      triangleNormal(p, a, b, c, n);
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      for (const v of [n[0] / len, n[1] / len, n[2] / len]) { view.setFloat32(offset, v, true); offset += 4; }
      for (const i of [a, b, c]) {
        view.setFloat32(offset, p[i], true);
        view.setFloat32(offset + 4, p[i + 1], true);
        view.setFloat32(offset + 8, p[i + 2], true);
        offset += 12;
      }
      view.setUint16(offset, 0, true);
      offset += 2;
    }
  }
  return buffer;
}
