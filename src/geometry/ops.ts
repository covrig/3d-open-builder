import type { ManifoldToplevel } from 'manifold-3d';
import { booleanOp, combineWithTools, type BooleanOp, type RoleOp } from './booleans';
import { extrudeDown, splitByPlane } from './cut';
import type { MeshData, PlacedMesh } from './meshData';
import { checkMesh, repairMesh } from './meshTools';
import type { EdgeSegment } from './edges';
import { edgeTreatment, gusset, shell, textOnFace } from './features';
import { makeThreaded } from './threads';

/**
 * The heavy geometry operations, all plain data in and out (MeshData, numbers)
 * so they can run in the geometry worker. Each takes the Manifold module first.
 */
export const ops = {
  boolean: (wasm: ManifoldToplevel, a: { op: BooleanOp; items: PlacedMesh[] }) => booleanOp(wasm, a.op, a.items),
  combine: (wasm: ManifoldToplevel, a: { op: RoleOp; targets: PlacedMesh[]; tools: PlacedMesh[] }) =>
    combineWithTools(wasm, a.op, a.targets, a.tools),
  extrudeDown: (wasm: ManifoldToplevel, a: { item: PlacedMesh }) => extrudeDown(wasm, a.item),
  split: (wasm: ManifoldToplevel, a: { item: PlacedMesh; normal: [number, number, number]; offset: number }) =>
    splitByPlane(wasm, a.item, a.normal, a.offset),
  check: (wasm: ManifoldToplevel, a: { item: PlacedMesh; minWall: number }) => checkMesh(wasm, a.item, a.minWall),
  repair: (wasm: ManifoldToplevel, a: { mesh: MeshData }) => repairMesh(wasm, a.mesh),
  edgeTreatment: (wasm: ManifoldToplevel, a: { item: PlacedMesh; segments: EdgeSegment[]; kind: 'chamfer' | 'fillet'; size: number }) =>
    edgeTreatment(wasm, a.item, a.segments, a.kind, a.size),
  gusset: (wasm: ManifoldToplevel, a: { item: PlacedMesh; edge: EdgeSegment; leg1: number; leg2: number; thickness: number; position: number }) =>
    gusset(wasm, a.item, a.edge, a),
  shell: (wasm: ManifoldToplevel, a: { item: PlacedMesh; thickness: number }) => shell(wasm, a.item, a.thickness),
  union: (wasm: ManifoldToplevel, a: { items: PlacedMesh[] }) => booleanOp(wasm, 'union', a.items),
  threaded: (wasm: ManifoldToplevel, a: Parameters<typeof makeThreaded>[1]) => makeThreaded(wasm, a),
  text: (wasm: ManifoldToplevel, a: { item: PlacedMesh } & Parameters<typeof textOnFace>[2]) => textOnFace(wasm, a.item, a),
};

export type Ops = typeof ops;
export type OpName = keyof Ops;
export type OpArgs<K extends OpName> = Parameters<Ops[K]>[1];
export type OpResult<K extends OpName> = ReturnType<Ops[K]>;
