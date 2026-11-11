import * as THREE from 'three';

/** Text textures are reused by text + colour, so rulers can be rebuilt while dragging. */
const cache = new Map<string, { texture: THREE.CanvasTexture; aspect: number }>();

function textTexture(text: string, color: string) {
  const key = `${color}|${text}`;
  let entry = cache.get(key);
  if (!entry) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const font = '600 48px "Segoe UI", system-ui, sans-serif';
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 16;
    canvas.width = w;
    canvas.height = 64;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 8, 34);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    entry = { texture, aspect: w / 64 };
    cache.set(key, entry);
  }
  return entry;
}

/** Text that always faces the camera (for axis names), `height` mm tall. */
export function makeSprite(text: string, color: string, height: number): THREE.Sprite {
  const { texture, aspect } = textTexture(text, color);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false }));
  sprite.scale.set(height * aspect, height, 1);
  return sprite;
}

/**
 * Geometry (1 mm tall; the mesh's scale sizes it) and material per text and
 * colour, shared by every label showing that text: a ruler rebuilt while
 * dragging adds no new GPU objects, and three.js keeps its shaders.
 */
const labelCache = new Map<string, { geometry: THREE.PlaneGeometry; material: THREE.MeshBasicMaterial; aspect: number }>();
const MAX_LABELS = 500;

/**
 * Flat text lying on the plate, centred on its position, `height` mm tall.
 * The geometry and material are shared: don't dispose them. A label that
 * changes its material (e.g. fades) asks for `own: true` and gets a material
 * of its own, which its owner disposes (only the material, not the geometry).
 * The label's width in mm is `labelWidth(label)`.
 */
export function makeLabel(text: string, color: string, height: number, options: { own?: boolean } = {}): THREE.Mesh {
  const key = `${color}|${text}`;
  let entry = labelCache.get(key);
  if (!entry) {
    // Very many different texts (a long session): start the cache over. Labels
    // still showing old entries keep working (three.js uploads them again).
    if (labelCache.size >= MAX_LABELS) labelCache.clear();
    const { texture, aspect } = textTexture(text, color);
    entry = {
      geometry: new THREE.PlaneGeometry(aspect, 1),
      material: new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
      aspect,
    };
    labelCache.set(key, entry);
  }
  const mesh = new THREE.Mesh(entry.geometry, options.own ? entry.material.clone() : entry.material);
  mesh.scale.set(height, height, 1);
  mesh.renderOrder = 1;
  mesh.userData.labelWidth = entry.aspect * height;
  return mesh;
}

/** A label's width in mm (see makeLabel). */
export const labelWidth = (label: THREE.Object3D): number => label.userData.labelWidth as number;

/** Height of the numbers along the plate's axis lines (the rulers use the same), in the home view. */
export const GRID_NUMBER_HEIGHT = 3.5;
/** Height of the "0" at the origin, in the home view. */
export const ORIGIN_HEIGHT = 5;

/** About the Home view's distance from what it looks at (mm), so labels there keep their designed size. */
const HOME_DISTANCE = 470;

/**
 * How much bigger than in the home view labels on the plate are drawn, for a
 * camera this far (mm) from what it looks at: in proportion, so they keep the
 * same size on screen at any zoom (a model imported in cm or inches is shown
 * from much further away). Rounded to steps of about 9%, so labels are only
 * rebuilt when the zoom really changed.
 */
export function labelScale(distance: number): number {
  const octaves = Math.log2(Math.max(distance, 1e-3) / HOME_DISTANCE);
  return 2 ** (Math.round(octaves * 8) / 8);
}
