import * as THREE from 'three';

/**
 * Overhang view: surfaces that tilt down more than a set angle from vertical
 * (the ones a 3D printer needs supports for) are drawn in a warning colour.
 * Surfaces resting on the plate are not overhangs.
 *
 * Every object carries a thin layer that shares its geometry and draws only
 * its overhangs (worked out per pixel, so it follows every move and turn). The
 * layer is always solid and two-sided, whatever the object looks like: in
 * Wireframe it stays filled, and in X-ray it is drawn before the see-through
 * object, so overhangs show through the object (from above, an overhang is
 * the back of a face). Switched off, the layer isn't drawn at all.
 */
const uniforms = {
  /** sin(angle from vertical): a surface whose normal points down more than this is an overhang */
  uOverhangSin: { value: Math.sin(THREE.MathUtils.degToRad(45)) },
};

export const overhangMaterial = new THREE.MeshStandardMaterial({
  color: '#e5484d',
  roughness: 0.55,
  side: THREE.DoubleSide,
  // Just in front of the object's own surface (objects are pushed back, see SceneDocument).
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
  visible: false,
});
overhangMaterial.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = 'varying float vOverhangZ;\nvarying vec3 vOverhangNormal;\n' + shader.vertexShader
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vOverhangZ = (modelMatrix * vec4(transformed, 1.0)).z;')
    // The surface's own normal in the world (Z up), before any flipping for back faces.
    .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\n  vOverhangNormal = inverseTransformDirection(transformedNormal, viewMatrix);');
  shader.fragmentShader = 'uniform float uOverhangSin;\nvarying float vOverhangZ;\nvarying vec3 vOverhangNormal;\n' + shader.fragmentShader
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  if (vOverhangZ <= 0.05 || -normalize(vOverhangNormal).z <= uOverhangSin) discard;`);
};

export function setOverhangs(on: boolean, angleFromVertical: number, color: string): void {
  overhangMaterial.visible = on;
  overhangMaterial.color.set(color);
  uniforms.uOverhangSin.value = Math.sin(THREE.MathUtils.degToRad(angleFromVertical));
}

/** The overhang layer for an object's mesh (add it as a child; it never takes clicks). */
export function overhangLayer(geometry: THREE.BufferGeometry): THREE.Mesh {
  const layer = new THREE.Mesh(geometry, overhangMaterial);
  layer.raycast = () => {};
  layer.userData.overhangLayer = true;
  return layer;
}
