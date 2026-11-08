import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { manifoldToMeshData, type MeshData } from './meshData';
import { recenter } from './meshOps';

export type PrimitiveKind =
  | 'cube' | 'cylinder' | 'sphere' | 'cone' | 'pyramid' | 'wedge'
  | 'tube' | 'torus' | 'hexagon' | 'dome';

export const PRIMITIVE_NAMES: Record<PrimitiveKind, string> = {
  cube: 'Cube',
  cylinder: 'Cylinder',
  sphere: 'Sphere',
  cone: 'Cone',
  pyramid: 'Pyramid',
  wedge: 'Wedge',
  tube: 'Tube',
  torus: 'Torus',
  hexagon: 'Hexagon',
  dome: 'Dome',
};

/** Default size of new shapes, in mm. */
export const DEFAULT_SIZE = 40;
const SEGMENTS = 64;

/**
 * Primitives are built by Manifold rather than Three.js: Manifold's shapes are
 * guaranteed watertight, while Three.js primitives have seams and degenerate
 * pole triangles that make booleans fail. Each shape fits a 40 mm box and is
 * centred on the origin.
 */
export function createPrimitive(wasm: ManifoldToplevel, kind: PrimitiveKind, size = DEFAULT_SIZE): MeshData {
  const { Manifold, CrossSection } = wasm;
  const r = size / 2;
  const owned: Manifold[] = [];
  const keep = (m: Manifold) => (owned.push(m), m);
  let m: Manifold;
  switch (kind) {
    case 'cube':
      m = keep(Manifold.cube([size, size, size], true));
      break;
    case 'cylinder':
      m = keep(Manifold.cylinder(size, r, r, SEGMENTS, true));
      break;
    case 'sphere':
      m = keep(Manifold.sphere(r, SEGMENTS));
      break;
    case 'cone':
      m = keep(Manifold.cylinder(size, r, 0, SEGMENTS));
      break;
    case 'pyramid':
      // A 4-sided cone, turned 45° so its square base lines up with the axes.
      m = keep(keep(Manifold.cylinder(size, r * Math.SQRT2, 0, 4)).rotate([0, 0, 45]));
      break;
    case 'wedge':
      // Right triangle in the XZ plane, extruded along Y.
      m = keep(keep(Manifold.extrude([[0, 0], [size, 0], [0, size]], size)).rotate([90, 0, 0]));
      break;
    case 'tube': {
      const outer = keep(Manifold.cylinder(size, r, r, SEGMENTS, true));
      const inner = keep(Manifold.cylinder(size + 2, r * 0.75, r * 0.75, SEGMENTS, true));
      m = keep(outer.subtract(inner));
      break;
    }
    case 'torus': {
      // A circle swept around the Z axis: 40 mm across, 12 mm thick.
      const tube = size * 0.15;
      const circle = CrossSection.circle(tube, 32);
      const moved = circle.translate([r - tube, 0]);
      m = keep(Manifold.revolve(moved, SEGMENTS));
      circle.delete();
      moved.delete();
      break;
    }
    case 'hexagon':
      m = keep(Manifold.cylinder(size, r, r, 6, true));
      break;
    case 'dome':
      m = keep(keep(Manifold.sphere(r, SEGMENTS)).trimByPlane([0, 0, 1], 0));
      break;
  }
  try {
    return recenter(manifoldToMeshData(m)).mesh;
  } finally {
    for (const o of owned) o.delete();
  }
}
