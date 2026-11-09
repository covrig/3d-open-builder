import * as THREE from 'three';

/**
 * A mirror image of the objects in the plate: each object drawn a second
 * time, flipped below the plate (sharing its geometry, no copy), see-through
 * and fading out with depth. The plate's own fill is drawn over it, so a more
 * see-through plate shows more of the reflection.
 *
 * Cost when on: every object is drawn twice, so twice the triangles per
 * frame (frames are only drawn when something changes). Off: no cost at all.
 */
export class Reflection {
  private readonly group = new THREE.Group();
  private readonly copies = new Map<THREE.Mesh, THREE.Mesh>();
  private readonly uniforms = { uStrength: { value: 0.3 }, uDepth: { value: 60 } };
  private on = false;

  constructor(scene: THREE.Scene, private readonly objectRoot: THREE.Object3D) {
    this.group.scale.z = -1; // mirror in the plate (z = 0)
    this.group.visible = false;
    scene.add(this.group);
  }

  set(on: boolean, strength: number, depth: number): void {
    this.on = on;
    this.group.visible = on;
    this.uniforms.uStrength.value = strength;
    this.uniforms.uDepth.value = Math.max(depth, 1);
    if (!on) this.clear();
  }

  /** Match the copies to the objects (call before each frame). */
  sync(): void {
    if (!this.on) return;
    const seen = new Set<THREE.Mesh>();
    for (const child of this.objectRoot.children) {
      const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
      if (!mesh.isMesh) continue;
      seen.add(mesh);
      let copy = this.copies.get(mesh) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | undefined;
      if (!copy) {
        copy = new THREE.Mesh(mesh.geometry, this.material());
        copy.matrixAutoUpdate = false;
        copy.renderOrder = -2; // before the plate, which is then drawn over it
        copy.raycast = () => {};
        this.copies.set(mesh, copy);
        this.group.add(copy);
      }
      copy.geometry = mesh.geometry;
      // The renderer only refreshes mesh.matrix while drawing, after this runs:
      // without this the copy shows the last frame's place and lags a move.
      mesh.updateMatrix();
      copy.matrix.copy(mesh.matrix);
      copy.matrixWorldNeedsUpdate = true;
      copy.visible = mesh.visible;
      copy.material.color.copy(mesh.material.color);
    }
    for (const [mesh, copy] of this.copies) {
      if (seen.has(mesh)) continue;
      this.group.remove(copy);
      (copy.material as THREE.Material).dispose();
      this.copies.delete(mesh);
    }
  }

  private clear(): void {
    for (const copy of this.copies.values()) {
      this.group.remove(copy);
      (copy.material as THREE.Material).dispose();
    }
    this.copies.clear();
  }

  /** See-through material that fades with depth below the plate and hides anything above it. */
  private material(): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.6, transparent: true, depthWrite: false });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = 'varying float vMirrorZ;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vMirrorZ = (modelMatrix * vec4(transformed, 1.0)).z;',
      );
      shader.fragmentShader = 'uniform float uStrength;\nuniform float uDepth;\nvarying float vMirrorZ;\n'
        + shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
  // Parts of objects below the plate would mirror to above it: leave them out.
  if (vMirrorZ > 0.0) discard;
  gl_FragColor.a *= uStrength * (1.0 - smoothstep(0.0, uDepth, -vMirrorZ));`,
        );
    };
    return m;
  }
}
