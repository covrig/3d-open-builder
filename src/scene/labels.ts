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

/** Geometry and material per text, colour and height: a ruler rebuilt while dragging adds no new GPU objects. */
const labelCache = new Map<string, { geometry: THREE.PlaneGeometry; material: THREE.MeshBasicMaterial }>();
const MAX_LABELS = 200;

/** Flat text lying on the plate, centred on its position, `height` mm tall. The geometry and material are shared: don't dispose them. */
export function makeLabel(text: string, color: string, height: number): THREE.Mesh {
  const key = `${color}|${height}|${text}`;
  let entry = labelCache.get(key);
  if (!entry) {
    if (labelCache.size >= MAX_LABELS) {
      for (const e of labelCache.values()) {
        e.geometry.dispose();
        e.material.dispose(); // the texture is shared through textTexture's cache and stays
      }
      labelCache.clear();
    }
    const { texture, aspect } = textTexture(text, color);
    entry = {
      geometry: new THREE.PlaneGeometry(height * aspect, height),
      material: new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
    };
    labelCache.set(key, entry);
  }
  const mesh = new THREE.Mesh(entry.geometry, entry.material);
  mesh.renderOrder = 1;
  return mesh;
}

/** Height (mm) of the numbers along the plate's axis lines; the rulers use the same size. */
export const GRID_NUMBER_HEIGHT = 3.5;
