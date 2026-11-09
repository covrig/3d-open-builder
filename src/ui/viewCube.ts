import * as THREE from 'three';
import type { Viewport } from '../scene/viewport';

/** Half the cube's size in pixels. */
const HALF = 26;

/** Each side: its name, the direction it faces (world, Z up) and which way is "up" on its label. */
const FACES: { name: string; n: [number, number, number]; up: [number, number, number] }[] = [
  { name: 'Top', n: [0, 0, 1], up: [0, 1, 0] },
  { name: 'Bottom', n: [0, 0, -1], up: [0, -1, 0] },
  { name: 'Front', n: [0, -1, 0], up: [0, 0, 1] },
  { name: 'Back', n: [0, 1, 0], up: [0, 0, 1] },
  { name: 'Right', n: [1, 0, 0], up: [0, 0, 1] },
  { name: 'Left', n: [-1, 0, 0], up: [0, 0, 1] },
];

/** CSS matrix3d placing an element with its own x right, y down and z out along these world directions. */
function cssMatrix(right: THREE.Vector3, down: THREE.Vector3, out: THREE.Vector3, at: THREE.Vector3): string {
  const m = [right.x, right.y, right.z, 0, down.x, down.y, down.z, 0, out.x, out.y, out.z, 0, at.x, at.y, at.z, 1];
  return `matrix3d(${m.map((v) => +v.toFixed(6)).join(',')})`;
}

/**
 * The view cube under the app name: a small cube that turns with the camera.
 * Clicking a side turns the view to look at that side. Built from page
 * elements with 3D CSS transforms, so it costs next to nothing and its labels
 * stay sharp.
 */
export function setupViewCube(viewport: Viewport): void {
  const root = document.querySelector<HTMLElement>('#view-cube')!;
  const cube = root.querySelector<HTMLElement>('.vc-cube')!;
  for (const f of FACES) {
    const n = new THREE.Vector3(...f.n), up = new THREE.Vector3(...f.up);
    const face = document.createElement('button');
    face.type = 'button';
    face.className = 'vc-face';
    face.textContent = f.name.toUpperCase();
    face.setAttribute('aria-label', `${f.name} view`);
    // Label reads left to right and upright when that side faces the viewer.
    face.style.transform = cssMatrix(up.clone().cross(n), up.clone().negate(), n, n.clone().multiplyScalar(HALF));
    face.addEventListener('click', () => viewport.viewFrom(n));
    cube.append(face);
  }
  // The dashed ring under the cube, lying flat below it.
  const ring = root.querySelector<HTMLElement>('.vc-ring')!;
  cube.append(ring);
  ring.style.transform = cssMatrix(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -HALF * 1.05));

  // The cube turns with the camera: world → camera rotation, then CSS's y points down.
  const rotation = new THREE.Matrix4();
  const flipY = new THREE.Matrix4().makeScale(1, -1, 1);
  const update = () => {
    rotation.extractRotation(viewport.camera.matrixWorldInverse).premultiply(flipY);
    cube.style.transform = `matrix3d(${rotation.elements.map((v) => +v.toFixed(6)).join(',')})`;
  };
  viewport.onFrame(update);
  update();
}
