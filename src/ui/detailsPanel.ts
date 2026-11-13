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

/** Standard filament: 1.75 mm across. */
const FILAMENT_DIAMETER_MM = 1.75;
/** What a typical print uses compared with a completely solid one (walls plus light infill): a rough figure. */
const TYPICAL_PRINT_SHARE = 0.25;

/** Length of filament (mm) that holds this volume (mm³), the filament being a solid rod. */
export function filamentLengthMm(volumeMm3: number): number {
  return volumeMm3 / (Math.PI * (FILAMENT_DIAMETER_MM / 2) ** 2);
}

/** A filament length in the unit setting's family: metres or millimetres for mm and cm, feet or inches for in. */
export function formatFilament(lengthMm: number, imperial: boolean): string {
  if (imperial) {
    const inches = lengthMm / MM_PER_UNIT.in;
    return inches >= 12 ? `${fmt(inches / 12, 1)} ft` : `${fmt(inches, 1)} in`;
  }
  return lengthMm >= 1000 ? `${fmt(lengthMm / 1000, 2)} m` : `${fmt(lengthMm, 0)} mm`;
}

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
      for (const id of ['#detail-size', '#detail-tris', '#detail-volume', '#detail-filament-solid', '#detail-filament-typical']) $(id).textContent = '–';
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
    // Filament follows the volume: nothing to show for an open mesh or while it is being worked out.
    const known = !open && !waiting;
    const solid = known ? filamentLengthMm(volume) : null;
    $('#detail-filament-solid').textContent = solid === null ? '–' : formatFilament(solid, imperial);
    $('#detail-filament-typical').textContent = solid === null ? '–' : `~${formatFilament(solid * TYPICAL_PRINT_SHARE, imperial)}`;
  }

  return { updateDetails, volumeOf };
}
