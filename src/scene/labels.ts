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

/** Flat text lying on the plate, centred on its position, `height` mm tall. */
export function makeLabel(text: string, color: string, height: number): THREE.Mesh {
  const { texture, aspect } = textTexture(text, color);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(height * aspect, height),
    // The texture is shared through the cache, so disposing this material leaves it alone.
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  mesh.renderOrder = 1;
  return mesh;
}

/** Height (mm) of the numbers along the plate's axis lines; the rulers use the same size. */
export const GRID_NUMBER_HEIGHT = 3.5;
