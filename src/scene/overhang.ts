import * as THREE from 'three';

/**
 * Overhang view: surfaces that tilt down more than a set angle from vertical
 * (the ones a 3D printer needs supports for) are drawn in a warning colour.
 * Done per pixel in each object's own shader, so it follows every move and
 * turn at no extra cost. Surfaces resting on the plate are not overhangs.
 */
export const overhangUniforms = {
  uOverhangOn: { value: 0 },
  /** sin(angle from vertical): a surface whose normal points down more than this is an overhang */
  uOverhangSin: { value: Math.sin(THREE.MathUtils.degToRad(45)) },
  uOverhangColor: { value: new THREE.Color('#e5484d') },
};

export function setOverhangs(on: boolean, angleFromVertical: number, color: string): void {
  overhangUniforms.uOverhangOn.value = on ? 1 : 0;
  overhangUniforms.uOverhangSin.value = Math.sin(THREE.MathUtils.degToRad(angleFromVertical));
  overhangUniforms.uOverhangColor.value.set(color);
}

/** Add the overhang colouring to an object's material (it stays off until switched on). */
export function addOverhangShading(material: THREE.MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, overhangUniforms);
    shader.vertexShader = 'varying float vOverhangZ;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vOverhangZ = (modelMatrix * vec4(transformed, 1.0)).z;',
    );
    shader.fragmentShader = [
      'uniform float uOverhangOn;',
      'uniform float uOverhangSin;',
      'uniform vec3 uOverhangColor;',
      'varying float vOverhangZ;',
    ].join('\n') + '\n' + shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
  if (uOverhangOn > 0.5 && vOverhangZ > 0.05) {
    // The normal here is in camera space; turn it back into the world (Z up).
    vec3 worldNormal = inverseTransformDirection(normal, viewMatrix);
    if (-worldNormal.z > uOverhangSin) diffuseColor.rgb = uOverhangColor;
  }`,
    );
  };
}
