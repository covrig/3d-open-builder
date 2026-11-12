import * as THREE from 'three';
import type { ManifoldToplevel } from 'manifold-3d';
import { meshDataToManifold, meshId, type MeshData } from '../geometry/meshData';
import { runOp } from '../geometry/workerClient';
import type { SceneDocument, SceneObject } from '../scene/document';
import { MM_PER_UNIT, settings, toUnit } from '../settings';

/** What the Details panel needs from the rest of the app. */
export interface DetailsContext {
  doc: SceneDocument;
  wasm: ManifoldToplevel;
}

export interface DetailsPanel {
  /** Show the size, triangle count and volume of the selection (or of the whole scene). */
  updateDetails: () => void;
  /** The object's volume, null if it isn't a closed solid, undefined while the worker works it out. */
  volumeOf: (o: SceneObject) => number | null | undefined;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const fmt = (v: number, digits = 1) => v.toLocaleString(undefined, { maximumFractionDigits: digits });

/** Above this many triangles, building the solid here would hold up the page. */
const BIG_MESH = 50_000;

export function setupDetailsPanel(ctx: DetailsContext): DetailsPanel {
  const { doc, wasm } = ctx;

  /**
   * Volume of each mesh, computed once. Moving and turning don't change it and
   * scaling multiplies it, so dragging never has to rebuild the solid.
   */
  const volumeCache = new WeakMap<MeshData, number | null>();
  /** Big meshes whose volume the worker is working out */
  const volumeAsked = new WeakSet<MeshData>();

  function volumeOf(o: SceneObject): number | null | undefined {
    if (!volumeCache.has(o.data)) {
      const data = o.data;
      if (data.indices.length / 3 > BIG_MESH) {
        if (!volumeAsked.has(data)) {
          volumeAsked.add(data);
          runOp('volume', { mesh: { ...data, id: meshId(data) } }, true).then(
            (v) => {
              volumeCache.set(data, v);
              updateDetails();
            },
            () => volumeAsked.delete(data), // stopped: ask again next time
          );
        }
        return undefined;
      }
      try {
        const m = meshDataToManifold(wasm, o.data);
        volumeCache.set(o.data, m.volume());
        m.delete();
      } catch {
        volumeCache.set(o.data, null);
      }
    }
    const base = volumeCache.get(o.data)!;
    const s = o.mesh.scale;
    return base === null ? null : base * Math.abs(s.x * s.y * s.z);
  }

  function updateDetails(): void {
    const objs = doc.selection.length ? doc.selection : doc.objects;
    $('#details-scope').textContent = doc.selection.length ? 'Selection' : 'Whole scene';
    if (objs.length === 0) {
      for (const id of ['#detail-size', '#detail-tris', '#detail-volume']) $(id).textContent = '–';
      return;
    }
    const size = doc.worldBox(objs).getSize(new THREE.Vector3());
    const u = settings.unit;
    $('#detail-size').textContent = `${fmt(toUnit(size.x), 2)} × ${fmt(toUnit(size.y), 2)} × ${fmt(toUnit(size.z), 2)} ${u}`;
    $('#detail-tris').textContent = fmt(objs.reduce((n, o) => n + o.data.indices.length / 3, 0), 0);
    const volumes = objs.map(volumeOf);
    const open = volumes.filter((v) => v === null).length;
    const waiting = volumes.some((v) => v === undefined);
    const volume = volumes.reduce<number>((sum, v) => sum + (v ?? 0), 0);
    // Metric units show cm³ (what slicers use); imperial shows in³.
    const imperial = u === 'in';
    $('#detail-volume').textContent = open
      ? `${open} object${open > 1 ? 's are' : ' is'} not a closed solid`
      : waiting
        ? 'Working out…'
        : imperial
        ? `${fmt(volume / MM_PER_UNIT.in ** 3, 2)} in³`
        : `${fmt(volume / 1000, 2)} cm³`;
  }

  return { updateDetails, volumeOf };
}
