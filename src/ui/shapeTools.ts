import type { ManifoldToplevel } from 'manifold-3d';
import type { MeshData } from '../geometry/meshData';
import { bounds } from '../geometry/meshOps';
import { createPrimitive, defaultDims, PRIMITIVE_NAMES, type PrimitiveDims, type PrimitiveKind } from '../geometry/primitives';
import type { SceneDocument } from '../scene/document';
import { previewMesh, type Field, type FeatureBar } from './featureBar';

/** A length field in mm. */
const mm = (key: string, label: string, value: number, tip: string, min = 0.1): Field => ({
  key, label, type: 'number', value, min, step: 1, unit: 'mm', tip,
});

const D = defaultDims();

/** The fields each shape asks for (defaults are the standard 40 mm shapes), and a line telling what to do. */
const SHAPES: Record<PrimitiveKind, { hint: string; fields: Field[] }> = {
  cube: {
    hint: 'Cube: set the size, then Apply.',
    fields: [
      mm('width', 'Width', D.width, 'Size from left to right (X).'),
      mm('depth', 'Depth', D.depth, 'Size from front to back (Y).'),
      mm('height', 'Height', D.height, 'Size from bottom to top (Z).'),
    ],
  },
  cylinder: {
    hint: 'Cylinder: set the size, then Apply.',
    fields: [mm('diameter', 'Diameter', D.diameter, 'Width of the round part.'), mm('height', 'Height', D.height, 'Size from bottom to top.')],
  },
  sphere: {
    hint: 'Sphere: set the size, then Apply.',
    fields: [mm('diameter', 'Diameter', D.diameter, 'Width of the ball.')],
  },
  cone: {
    hint: 'Cone: set the size, then Apply. A top diameter above 0 cuts the point off.',
    fields: [
      mm('diameter', 'Bottom diameter', D.diameter, 'Width at the bottom.'),
      mm('topDiameter', 'Top diameter', D.topDiameter, '0 makes a point; more makes a truncated cone with a flat top.', 0),
      mm('height', 'Height', D.height, 'Size from bottom to top.'),
    ],
  },
  pyramid: {
    hint: 'Pyramid: set the size, then Apply.',
    fields: [
      mm('width', 'Width', D.width, 'Size of the base from left to right (X).'),
      mm('depth', 'Depth', D.depth, 'Size of the base from front to back (Y).'),
      mm('height', 'Height', D.height, 'Size from the base to the tip.'),
    ],
  },
  wedge: {
    hint: 'Wedge: give the three sides of the triangle, and how deep to make it, then Apply.',
    fields: [
      mm('sideA', 'Side a', D.sideA, 'The base, along the left-right direction (X).'),
      mm('sideB', 'Side b', D.sideB, 'From the start of the base up to the top corner.'),
      { ...mm('sideC', 'Side c', 56.57, 'From the end of the base up to the top corner.'), step: 0.01 },
      mm('depth', 'Depth', D.depth, 'How far the triangle is extended front to back (Y).'),
    ],
  },
  tube: {
    hint: 'Tube: set the size, then Apply.',
    fields: [
      mm('diameter', 'Outer diameter', D.diameter, 'Width across the outside.'),
      mm('innerDiameter', 'Inner diameter', D.innerDiameter, 'Width of the hole. Must be smaller than the outer diameter.'),
      mm('height', 'Height', D.height, 'Size from bottom to top.'),
    ],
  },
  torus: {
    hint: 'Torus: set the size, then Apply.',
    fields: [
      mm('diameter', 'Diameter', D.diameter, 'Width across the whole ring, outside.'),
      mm('thickness', 'Thickness', D.thickness, 'Width of the ring itself. Must be less than half the diameter.'),
    ],
  },
  hexagon: {
    hint: 'Hexagon: set the size, then Apply.',
    fields: [
      mm('width', 'Width', 40, 'Width across the flat sides.'),
      mm('height', 'Height', D.height, 'Size from bottom to top.'),
    ],
  },
  dome: {
    hint: 'Dome: set the size, then Apply.',
    fields: [mm('diameter', 'Diameter', D.diameter, 'Width across the flat bottom. The dome is half a ball.')],
  },
  tetrahedron: {
    hint: 'Tetrahedron: set the edge length, then Apply.',
    fields: [mm('edge', 'Edge', D.edge, 'Length of every edge. It rests on one of its four triangular faces.')],
  },
};

/**
 * The shapes of the Add object menu. Each opens a bar for its measurements
 * with a live preview at the origin; Apply adds it.
 */
export class ShapeTools {
  constructor(
    private readonly wasm: ManifoldToplevel,
    private readonly doc: SceneDocument,
    private readonly bar: FeatureBar,
  ) {
    for (const b of document.querySelectorAll<HTMLElement>('[data-insert]')) {
      b.addEventListener('click', () => this.open(b.dataset.insert as PrimitiveKind));
    }
  }

  private open(kind: PrimitiveKind): void {
    const { hint, fields } = SHAPES[kind];
    // The new shape goes at the origin, resting on the plate (even if it overlaps other objects).
    const place = (mesh: MeshData): [number, number, number] => [0, 0, -bounds(mesh).min[2]];
    this.bar.open<MeshData>({
      focusFirst: true,
      title: `Add ${PRIMITIVE_NAMES[kind].toLowerCase()}`,
      hint,
      fields,
      // Shapes are cheap, so they are made right here instead of in the worker.
      compute: async (v) => createPrimitive(this.wasm, kind, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Number(x)])) as Partial<PrimitiveDims>),
      show: (mesh) => [previewMesh(mesh, place(mesh))],
      apply: (mesh) => {
        this.doc.transact(() => {
          const obj = this.doc.add(PRIMITIVE_NAMES[kind], mesh);
          obj.mesh.position.set(...place(mesh));
          this.doc.setSelection([obj]);
        });
      },
    });
  }
}
