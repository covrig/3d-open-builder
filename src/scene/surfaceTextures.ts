import * as THREE from 'three';

/** A look (wood, metal ...) an object can be given instead of a plain colour. It is only drawn on screen: exported files keep the object's colour. */
export interface ObjectTexture {
  id: string;
  /** Length of one tile of the picture on the object, in mm */
  size: number;
}

export interface SurfaceTextureInfo {
  id: string;
  name: string;
  /** Picture, relative to the app (public/textures) */
  file: string;
  /** Tile size that looks natural, in mm */
  size: number;
  /** Multiplies the surface's roughness: metals and polished stone shine more, wood and concrete less */
  roughness: number;
  /** 0 for non-metals; metals reflect the room and take their colour from the picture */
  metalness: number;
}

/** How strongly a metal texture reflects the room. */
const METAL_REFLECTION = 1.3;

// Two rows of six in the colour popover.
export const SURFACE_TEXTURES: SurfaceTextureInfo[] = [
  { id: 'wood', name: 'Wood', file: 'textures/wood.jpg', size: 60, roughness: 1.1, metalness: 0 },
  { id: 'concrete', name: 'Concrete', file: 'textures/concrete.jpg', size: 60, roughness: 1.3, metalness: 0 },
  { id: 'brick', name: 'Brick', file: 'textures/brick.jpg', size: 80, roughness: 1.3, metalness: 0 },
  { id: 'steel', name: 'Steel', file: 'textures/steel.jpg', size: 40, roughness: 0.9, metalness: 0.9 },
  { id: 'copper', name: 'Copper', file: 'textures/copper.jpg', size: 40, roughness: 0.6, metalness: 1 },
  { id: 'gold', name: 'Gold', file: 'textures/gold.jpg', size: 40, roughness: 0.55, metalness: 1 },
  { id: 'silver', name: 'Silver', file: 'textures/silver.jpg', size: 40, roughness: 0.5, metalness: 1 },
  { id: 'aluminium', name: 'Brushed aluminium', file: 'textures/aluminium.jpg', size: 40, roughness: 0.8, metalness: 1 },
  { id: 'carbon', name: 'Carbon fibre', file: 'textures/carbon.jpg', size: 20, roughness: 0.7, metalness: 0 },
  { id: 'granite', name: 'Granite', file: 'textures/granite.jpg', size: 40, roughness: 0.9, metalness: 0 },
  { id: 'marble', name: 'Marble', file: 'textures/marble.jpg', size: 60, roughness: 0.6, metalness: 0 },
  { id: 'cork', name: 'Cork', file: 'textures/cork.jpg', size: 40, roughness: 1.5, metalness: 0 },
];

let environmentProvider: (() => THREE.Texture) | null = null;
/** The viewport hands over its room reflection (built when first asked for), so metal textures can shine. */
export function setEnvironmentProvider(provider: () => THREE.Texture): void {
  environmentProvider = provider;
}

export const MIN_TEXTURE_SIZE = 2;
export const MAX_TEXTURE_SIZE = 500;

export const textureInfo = (id: string): SurfaceTextureInfo | undefined => SURFACE_TEXTURES.find((t) => t.id === id);

/** A saved or typed value made usable (unknown picture, bad size: no texture or the natural size). */
export function cleanTexture(v: unknown): ObjectTexture | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const t = v as { id?: unknown; size?: unknown };
  if (typeof t.id !== 'string') return undefined;
  const info = textureInfo(t.id);
  if (!info) return undefined;
  const size = typeof t.size === 'number' && Number.isFinite(t.size) ? Math.min(MAX_TEXTURE_SIZE, Math.max(MIN_TEXTURE_SIZE, t.size)) : info.size;
  return { id: info.id, size };
}

const loaded = new Map<string, Promise<THREE.Texture | null>>();

/** Each picture is fetched once, from the app's own files, and kept. */
function load(info: SurfaceTextureInfo): Promise<THREE.Texture | null> {
  let p = loaded.get(info.id);
  if (!p) {
    p = new THREE.TextureLoader().loadAsync(info.file).then(
      (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8; // sharp at a slant (the graphics card limits it if it supports less)
        return t;
      },
      () => null,
    );
    loaded.set(info.id, p);
  }
  return p;
}

interface SurfaceUniforms {
  uSurfaceMap: { value: THREE.Texture | null };
  uSurfaceSize: { value: number };
  uSurfaceRough: { value: number };
  uSurfaceOn: { value: number };
}

/** What the material needs to draw the texture; kept on the material so it can be changed without a recompile. */
const UNIFORMS = 'surfaceUniforms';
const uniformsOf = (m: THREE.Material): SurfaceUniforms | undefined => m.userData[UNIFORMS] as SurfaceUniforms | undefined;

function patch(material: THREE.MeshStandardMaterial, u: SurfaceUniforms): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    // The picture is laid on in the object's own coordinates (so it moves, turns and resizes with the object), from the three
    // directions at once, each weighted by how much the surface faces it: no stretching and no seams, with no UV coordinates needed.
    shader.vertexShader = 'varying vec3 vSurfacePos;\nvarying vec3 vSurfaceNormal;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
  vec3 surfaceScale = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));
  vSurfacePos = position * surfaceScale;
  vSurfaceNormal = normal / surfaceScale;`,
    );
    shader.fragmentShader = 'uniform sampler2D uSurfaceMap;\nuniform float uSurfaceSize;\nuniform float uSurfaceRough;\nuniform float uSurfaceOn;\nvarying vec3 vSurfacePos;\nvarying vec3 vSurfaceNormal;\n'
      + shader.fragmentShader
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
  if (uSurfaceOn > 0.5) {
    vec3 w = pow(abs(normalize(vSurfaceNormal)), vec3(4.0));
    w /= (w.x + w.y + w.z);
    vec3 look = texture2D(uSurfaceMap, vSurfacePos.yz / uSurfaceSize).rgb * w.x
      + texture2D(uSurfaceMap, vSurfacePos.xz / uSurfaceSize).rgb * w.y
      + texture2D(uSurfaceMap, vSurfacePos.xy / uSurfaceSize).rgb * w.z;
    diffuseColor.rgb = look;
  }`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
  if (uSurfaceOn > 0.5) roughnessFactor = clamp(roughnessFactor * uSurfaceRough, 0.05, 1.0);`,
        );
  };
  material.customProgramCacheKey = () => 'surface';
  material.needsUpdate = true;
}

/**
 * Give an object's material a texture (or take it off with undefined).
 * `ready` is called when a picture that had to be fetched has arrived.
 */
export function applyTexture(material: THREE.MeshStandardMaterial, texture: ObjectTexture | undefined, ready: () => void): void {
  const info = texture ? textureInfo(texture.id) : undefined;
  if (!texture || !info) {
    // Taking the texture off only switches it off. The material keeps its patched shader: going back to a shader
    // program the renderer built earlier would use the uniforms of the program built last (which has none of ours).
    delete material.userData.surfaceWanted;
    delete material.userData.surfaceMetal;
    const off = uniformsOf(material);
    if (off) {
      off.uSurfaceOn.value = 0;
      material.metalness = 0;
      material.envMapIntensity = 0;
    }
    return;
  }
  let u = uniformsOf(material);
  if (!u) {
    u = { uSurfaceMap: { value: null }, uSurfaceSize: { value: texture.size }, uSurfaceRough: { value: info.roughness }, uSurfaceOn: { value: 0 } };
    material.userData[UNIFORMS] = u;
    patch(material, u);
  }
  u.uSurfaceSize.value = texture.size;
  u.uSurfaceRough.value = info.roughness;
  material.userData.surfaceWanted = info.id;
  // Metals take their colour from the picture and reflect the room; the others stay plain.
  material.userData.surfaceMetal = info.metalness;
  material.metalness = material.userData.surfaceHidden ? 0 : info.metalness;
  const env = info.metalness > 0 ? environmentProvider?.() ?? null : null;
  if (material.envMap !== env) {
    material.envMap = env;
    material.needsUpdate = true;
  }
  material.envMapIntensity = material.userData.surfaceHidden ? 0 : METAL_REFLECTION;
  const mine = u;
  void load(info).then((t) => {
    if (material.userData.surfaceWanted !== info.id || !t) return; // taken off or changed meanwhile, or the picture is missing: stays a plain colour
    mine.uSurfaceMap.value = t;
    mine.uSurfaceOn.value = material.userData.surfaceHidden ? 0 : 1;
    ready();
  });
}

/** Show or hide the texture without forgetting it (faded bystanders are plain grey). */
export function showTexture(material: THREE.MeshStandardMaterial, shown: boolean): void {
  const u = uniformsOf(material);
  material.userData.surfaceHidden = !shown;
  const wanted = material.userData.surfaceWanted !== undefined;
  if (u && u.uSurfaceMap.value) u.uSurfaceOn.value = shown && wanted ? 1 : 0;
  if (u) {
    material.metalness = shown && wanted ? (material.userData.surfaceMetal as number) ?? 0 : 0;
    material.envMapIntensity = shown && wanted ? METAL_REFLECTION : 0;
  }
}
