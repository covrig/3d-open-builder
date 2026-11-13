import * as THREE from 'three';
import { thicknessClass, type ThicknessClass } from '../geometry/thickness';

/**
 * Wall thickness view: every object carries a layer painted per triangle by how
 * thick the wall is there (red below the minimum wall, orange below 1.5 times
 * it, green above, grey where nothing could be measured). Like the overhang
 * layer it shares the object's shape and sits just in front of its surface, is
 * never picked, and moves with the object; its colours are its own, so the
 * object keeps its look underneath and a new minimum wall only repaints.
 */
export const thicknessMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.55,
  // The object's own look shows through a little.
  transparent: true,
  opacity: 0.88,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});

/** Colours of the classes (also the legend's swatches): below the minimum, below 1.5 times it, fine, not measured. */
export const THICKNESS_COLORS: Record<ThicknessClass, string> = {
  0: '#e5484d',
  1: '#f5a524',
  2: '#3fb950',
  3: '#8b8f98',
};
const RGB = (Object.keys(THICKNESS_COLORS) as unknown as ThicknessClass[]).map((k) => {
  const c = new THREE.Color(THICKNESS_COLORS[k]);
  return [c.r, c.g, c.b] as const;
});

/**
 * The layer for an object. `geometry` must be the object's own (one triangle per
 * three vertices, in the mesh's triangle order, as the scene builds it); null
 * when `thickness` does not fit it. The layer shares the vertex positions and
 * owns only its colours: dispose it with disposeThicknessLayer.
 */
export function thicknessLayer(geometry: THREE.BufferGeometry, thickness: Float32Array, minWall: number): THREE.Mesh | null {
  const position = geometry.getAttribute('position');
  if (geometry.index || !position || position.count !== thickness.length * 3) return null;
  const own = new THREE.BufferGeometry();
  own.setAttribute('position', position);
  const normal = geometry.getAttribute('normal');
  if (normal) own.setAttribute('normal', normal);
  own.setAttribute('color', new THREE.BufferAttribute(new Float32Array(position.count * 3), 3));
  own.boundingBox = geometry.boundingBox;
  own.boundingSphere = geometry.boundingSphere;
  const layer = new THREE.Mesh(own, thicknessMaterial);
  layer.raycast = () => {};
  layer.userData.thicknessLayer = true;
  paintThickness(layer, thickness, minWall);
  return layer;
}

/** Colour the layer again from the stored thickness (a new minimum wall; nothing is measured again). */
export function paintThickness(layer: THREE.Mesh, thickness: Float32Array, minWall: number): void {
  const color = layer.geometry.getAttribute('color') as THREE.BufferAttribute;
  const out = color.array as Float32Array;
  for (let t = 0; t < thickness.length; t++) {
    const [r, g, b] = RGB[thicknessClass(thickness[t], minWall)];
    for (let v = 0; v < 3; v++) {
      const o = (t * 3 + v) * 3;
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
    }
  }
  color.needsUpdate = true;
}

/** Take the layer off its object and free its colours (the shared positions stay with the object). */
export function disposeThicknessLayer(layer: THREE.Mesh): void {
  layer.removeFromParent();
  // Let go of the shared attributes first, or disposing would drop the object's own buffers too.
  layer.geometry.deleteAttribute('position');
  layer.geometry.deleteAttribute('normal');
  layer.geometry.dispose();
}
