import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { manifoldToMeshData, type MeshData } from './meshData';
import { recenter } from './meshOps';

export type PrimitiveKind =
  | 'cube' | 'cylinder' | 'sphere' | 'cone' | 'pyramid' | 'wedge'
  | 'tube' | 'torus' | 'hexagon' | 'dome' | 'tetrahedron';

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
  tetrahedron: 'Tetrahedron',
};

/** Default size of new shapes, in mm. */
export const DEFAULT_SIZE = 40;
const SEGMENTS = 64;

/** The measurements of a shape, in mm. Each shape reads only the ones it has; the rest keep their defaults. */
export interface PrimitiveDims {
  /** X */
  width: number;
  /** Y */
  depth: number;
  /** Z */
  height: number;
  /** Cylinder, sphere and dome; the cone's bottom; the tube's outside; the torus overall */
  diameter: number;
  /** Cone: 0 is a point, more is a truncated cone */
  topDiameter: number;
  /** Tube */
  innerDiameter: number;
  /** Torus: width of the ring's body */
  thickness: number;
  /** Wedge: the triangle's base (along X), the side from the base's start to the apex, and the side from its end */
  sideA: number;
  sideB: number;
  sideC: number;
  /** Tetrahedron */
  edge: number;
}

/** The measurements of the standard shapes, all scaled from 40 mm. */
export function defaultDims(size = DEFAULT_SIZE): PrimitiveDims {
  return {
    width: size, depth: size, height: size, diameter: size, topDiameter: 0, innerDiameter: size * 0.75,
    thickness: size * 0.3, sideA: size, sideB: size, sideC: size * Math.SQRT2, edge: size,
  };
}

function positive(name: string, v: number): void {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be more than 0.`);
}

/**
 * Primitives are built by Manifold rather than Three.js: Manifold's shapes are
 * guaranteed watertight, while Three.js primitives have seams and degenerate
 * pole triangles that make booleans fail. Every shape is centred on the
 * origin. With no measurements each fits a 40 mm box (a number scales them all);
 * impossible measurements throw an error that says what to change.
 */
export function createPrimitive(
  wasm: ManifoldToplevel,
  kind: PrimitiveKind,
  dimensions: number | Partial<PrimitiveDims> = {},
): MeshData {
  const { Manifold, CrossSection } = wasm;
  const d: PrimitiveDims = typeof dimensions === 'number'
    ? defaultDims(dimensions)
    : { ...defaultDims(), ...dimensions };
  const owned: Manifold[] = [];
  const keep = (m: Manifold) => (owned.push(m), m);
  let m: Manifold;
  switch (kind) {
    case 'cube':
      positive('Width', d.width);
      positive('Depth', d.depth);
      positive('Height', d.height);
      m = keep(Manifold.cube([d.width, d.depth, d.height], true));
      break;
    case 'cylinder':
      positive('Diameter', d.diameter);
      positive('Height', d.height);
      m = keep(Manifold.cylinder(d.height, d.diameter / 2, d.diameter / 2, SEGMENTS, true));
      break;
    case 'sphere':
      positive('Diameter', d.diameter);
      m = keep(Manifold.sphere(d.diameter / 2, SEGMENTS));
      break;
    case 'cone':
      positive('Bottom diameter', d.diameter);
      positive('Height', d.height);
      if (!Number.isFinite(d.topDiameter) || d.topDiameter < 0) throw new Error('Top diameter cannot be negative.');
      m = keep(Manifold.cylinder(d.height, d.diameter / 2, d.topDiameter / 2, SEGMENTS));
      break;
    case 'pyramid': {
      positive('Width', d.width);
      positive('Depth', d.depth);
      positive('Height', d.height);
      // A 4-sided cone, turned 45° so its base lines up with the axes: first a square of side 1, then stretched to the box.
      const cone = keep(Manifold.cylinder(d.height, Math.SQRT1_2, 0, 4));
      m = keep(keep(cone.rotate([0, 0, 45])).scale([d.width, d.depth, 1]));
      break;
    }
    case 'wedge': {
      positive('Side a', d.sideA);
      positive('Side b', d.sideB);
      positive('Side c', d.sideC);
      positive('Depth', d.depth);
      const { sideA: a, sideB: b, sideC: c } = d;
      // The apex from the three sides (law of cosines). Each side must be shorter than the other two together.
      const x = (a * a + b * b - c * c) / (2 * a);
      const h2 = b * b - x * x;
      if (a + b <= c || a + c <= b || b + c <= a || h2 <= 1e-9) {
        throw new Error("These three sides can't form a triangle: each side must be shorter than the other two together.");
      }
      // The triangle in the XZ plane, extruded along Y.
      m = keep(keep(Manifold.extrude([[0, 0], [a, 0], [x, Math.sqrt(h2)]], d.depth)).rotate([90, 0, 0]));
      break;
    }
    case 'tube': {
      positive('Outer diameter', d.diameter);
      positive('Inner diameter', d.innerDiameter);
      positive('Height', d.height);
      if (d.innerDiameter >= d.diameter) throw new Error('The inner diameter must be smaller than the outer diameter.');
      const ro = d.diameter / 2;
      const ri = d.innerDiameter / 2;
      const outer = keep(Manifold.cylinder(d.height, ro, ro, SEGMENTS, true));
      const inner = keep(Manifold.cylinder(d.height + 2, ri, ri, SEGMENTS, true));
      m = keep(outer.subtract(inner));
      break;
    }
    case 'torus': {
      positive('Diameter', d.diameter);
      positive('Thickness', d.thickness);
      if (d.thickness >= d.diameter / 2) throw new Error('The thickness must be less than half the diameter, or the ring has no hole.');
      // A circle swept around the Z axis.
      const tube = d.thickness / 2;
      const circle = CrossSection.circle(tube, 32);
      const moved = circle.translate([d.diameter / 2 - tube, 0]);
      m = keep(Manifold.revolve(moved, SEGMENTS));
      circle.delete();
      moved.delete();
      break;
    }
    case 'hexagon': {
      positive('Width', d.width);
      positive('Height', d.height);
      // Width is measured across the flats; the corners are further out.
      const corner = d.width / Math.sqrt(3);
      m = keep(Manifold.cylinder(d.height, corner, corner, 6, true));
      break;
    }
    case 'dome':
      positive('Diameter', d.diameter);
      m = keep(keep(Manifold.sphere(d.diameter / 2, SEGMENTS)).trimByPlane([0, 0, 1], 0));
      break;
    case 'tetrahedron': {
      positive('Edge', d.edge);
      // Resting on a face: an equilateral base and the apex above its middle.
      const rb = d.edge / Math.sqrt(3);
      const base = [0, 1, 2].map((i): [number, number, number] => [rb * Math.cos((i * 2 * Math.PI) / 3), rb * Math.sin((i * 2 * Math.PI) / 3), 0]);
      m = keep(Manifold.hull([...base, [0, 0, d.edge * Math.sqrt(2 / 3)]]));
      break;
    }
  }
  try {
    return recenter(manifoldToMeshData(m)).mesh;
  } finally {
    for (const o of owned) o.delete();
  }
}
