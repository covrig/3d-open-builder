import type { ManifoldToplevel } from 'manifold-3d';
import * as THREE from 'three';
import { booleanOp, combineWithTools, type BooleanOp, type RoleOp } from './booleans';
import { extrudeToPlane, splitByPlane } from './cut';
import { meshDataToManifold, type MeshData, type PlacedMesh } from './meshData';
import { parseMeshFile } from '../io/meshParse';
import { checkMesh, repairMesh } from './meshTools';
import { findEdgesPlaced, type EdgeSegment } from './edges';
import { edgeTreatment, gusset, shell, textOnFace } from './features';
import { overlapLines } from './overlaps';
import { makeThreaded, type ThreadInfo } from './threads';

/**
 * The heavy geometry operations, all plain data in and out (MeshData, numbers)
 * so they can run in the geometry worker. Each takes the Manifold module first.
 */
export const ops = {
  boolean: (wasm: ManifoldToplevel, a: { op: BooleanOp; items: PlacedMesh[] }) => booleanOp(wasm, a.op, a.items),
  combine: (wasm: ManifoldToplevel, a: { op: RoleOp; targets: PlacedMesh[]; tools: PlacedMesh[] }) =>
    combineWithTools(wasm, a.op, a.targets, a.tools),
  // `normal` and `centre` (x, y the plane passes through) tilt the plane; without them it is level.
  extrudeDown: (wasm: ManifoldToplevel, a: { item: PlacedMesh; height: number; normal?: [number, number, number]; centre?: [number, number] }) =>
    extrudeToPlane(wasm, a.item, a.normal && a.centre
      ? { point: [a.centre[0], a.centre[1], a.height], normal: a.normal }
      : a.height),
  split: (wasm: ManifoldToplevel, a: { item: PlacedMesh; normal: [number, number, number]; offset: number }) =>
    splitByPlane(wasm, a.item, a.normal, a.offset),
  check: (wasm: ManifoldToplevel, a: { item: PlacedMesh; minWall: number }) => checkMesh(wasm, a.item, a.minWall),
  repair: (wasm: ManifoldToplevel, a: { mesh: MeshData }) => repairMesh(wasm, a.mesh),
  edgeTreatment: (wasm: ManifoldToplevel, a: { item: PlacedMesh; segments: EdgeSegment[]; kind: 'chamfer' | 'fillet'; size: number }) =>
    edgeTreatment(wasm, a.item, a.segments, a.kind, a.size),
  gusset: (wasm: ManifoldToplevel, a: { item: PlacedMesh; edge: EdgeSegment; leg1: number; leg2: number; thickness: number; position: number }) =>
    gusset(wasm, a.item, a.edge, a),
  shell: (wasm: ManifoldToplevel, a: { item: PlacedMesh; thickness: number; thread?: ThreadInfo }) => shell(wasm, a.item, a.thickness, a.thread),
  union: (wasm: ManifoldToplevel, a: { items: PlacedMesh[] }) => booleanOp(wasm, 'union', a.items),
  threaded: (wasm: ManifoldToplevel, a: Parameters<typeof makeThreaded>[1]) => makeThreaded(wasm, a),
  text: (wasm: ManifoldToplevel, a: { item: PlacedMesh } & Parameters<typeof textOnFace>[2]) => textOnFace(wasm, a.item, a),
  // Sharp edges of the object as placed, for picking (bevel, round, brace).
  findEdges: (_wasm: ManifoldToplevel, a: { item: PlacedMesh }) => findEdgesPlaced(a.item),
  // Lines along the edges sharper than `angle` degrees (the Edges view), 6 numbers per segment, in the mesh's own space.
  edgeLines: (_wasm: ManifoldToplevel, a: { mesh: MeshData; angle: number }): Float32Array => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(a.mesh.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(a.mesh.indices, 1));
    const edges = new THREE.EdgesGeometry(geometry, a.angle);
    const lines = new Float32Array(edges.getAttribute('position').array);
    geometry.dispose();
    edges.dispose();
    return lines;
  },
  overlaps: (wasm: ManifoldToplevel, a: { items: PlacedMesh[] }) => overlapLines(wasm, a.items),
  // Volume of the mesh as a solid (in its own space), or null if it isn't a closed solid. Also keeps the solid for later jobs.
  volume: (wasm: ManifoldToplevel, a: { mesh: MeshData }): number | null => {
    try {
      const m = meshDataToManifold(wasm, a.mesh);
      const v = m.volume();
      m.delete();
      return v;
    } catch {
      return null;
    }
  },
  // Read an STL or OBJ file (welding its corners), off the page.
  parseMesh: (_wasm: ManifoldToplevel, a: Parameters<typeof parseMeshFile>[0]) => parseMeshFile(a),
};

export type Ops = typeof ops;
export type OpName = keyof Ops;
export type OpArgs<K extends OpName> = Parameters<Ops[K]>[1];
export type OpResult<K extends OpName> = ReturnType<Ops[K]>;
