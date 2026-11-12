import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { MeshData } from '../src/geometry/meshData';
import { isAxisAligned, stretchWorld, type Placement } from '../src/scene/resize';

/** A box w x d x h centred on the origin (12 triangles). */
function box(w: number, d: number, h: number): MeshData {
  const x = w / 2, y = d / 2, z = h / 2;
  const positions = new Float32Array([-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  return { positions, indices };
}

function placement(data: MeshData, position: [number, number, number] = [0, 0, 0], turnZ = 0): Placement {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(turnZ));
  return { data, position, quaternion: q.toArray() as [number, number, number, number], scale: [1, 1, 1] };
}

function worldBox(p: Placement): THREE.Box3 {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(...p.position), new THREE.Quaternion(...p.quaternion), new THREE.Vector3(...p.scale));
  const out = new THREE.Box3();
  for (let i = 0; i < p.data.positions.length; i += 3) {
    out.expandByPoint(new THREE.Vector3(p.data.positions[i], p.data.positions[i + 1], p.data.positions[i + 2]).applyMatrix4(m));
  }
  return out;
}

const size = (b: THREE.Box3) => b.getSize(new THREE.Vector3()).toArray();
const near = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 3));

/** The world box the stretch should give: the old box scaled about the anchor. */
function expected(before: THREE.Box3, f: number[], anchor: number[]): THREE.Box3 {
  const lo = before.min.toArray().map((v, i) => anchor[i] + (v - anchor[i]) * f[i]);
  const hi = before.max.toArray().map((v, i) => anchor[i] + (v - anchor[i]) * f[i]);
  return new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi));
}

describe('stretching along world axes', () => {
  it('(a) a box turned 90 degrees about Z, X x2: world X doubles', () => {
    const turned = placement(box(10, 20, 30), [0, 0, 15], 90);
    expect(size(worldBox(turned))).toEqual([expect.closeTo(20, 3), expect.closeTo(10, 3), expect.closeTo(30, 3)]);
    // The old way (local scale times a world factor) gave 20 x 20 x 30.
    const old = { ...turned, scale: [2, 1, 1] as [number, number, number] };
    near(size(worldBox(old)), [20, 20, 30]);
    const r = stretchWorld(turned, [2, 1, 1], [0, 0, 0]);
    near(size(worldBox(r)), [40, 10, 30]);
  });

  it('(a) the same with a bake in between: several turned boxes keep the box expected', () => {
    const p = placement(box(10, 20, 30), [5, 7, 15], 90);
    const anchor = [0, 0, 0];
    const r = stretchWorld(p, [2, 1, 1], [0, 0, 0]);
    const want = expected(worldBox(p), [2, 1, 1], anchor);
    near(worldBox(r).min.toArray(), want.min.toArray());
    near(worldBox(r).max.toArray(), want.max.toArray());
  });

  it('(b) a box turned 30 degrees: asking world X 37.32 gives 37.32 and leaves Y alone', () => {
    const p = placement(box(10, 20, 30), [0, 0, 15], 30);
    const before = worldBox(p);
    near(size(before), [18.660254, 22.320508, 30]);
    // The old way (the own axis that lines up best, here local X, doubled) gave 27.32 x 27.32.
    const old = { ...p, scale: [2, 1, 1] as [number, number, number] };
    expect(size(worldBox(old))[0]).toBeCloseTo(27.32, 1);
    expect(size(worldBox(old))[1]).toBeCloseTo(27.32, 1);
    const f = 37.32 / size(before)[0];
    const r = stretchWorld(p, [f, 1, 1], [before.min.x, 0, 0]);
    const s = size(worldBox(r));
    expect(s[0]).toBeCloseTo(37.32, 2);
    expect(s[1]).toBeCloseTo(size(before)[1], 3);
    expect(s[2]).toBeCloseTo(30, 3);
    // The anchored face did not move.
    expect(worldBox(r).min.x).toBeCloseTo(before.min.x, 3);
    expect(isAxisAligned(r.quaternion)).toBe(true);
    expect(r.scale).toEqual([1, 1, 1]);
  });

  it('(c) a 40 mm cube on the plate, Z set to 80: the bottom stays at 0', () => {
    const p = placement(box(40, 40, 40), [0, 0, 20]);
    // The old way scaled about the centre: from -20 to 60.
    const old = { ...p, scale: [1, 1, 2] as [number, number, number] };
    expect(worldBox(old).min.z).toBeCloseTo(-20, 3);
    expect(worldBox(old).max.z).toBeCloseTo(60, 3);
    const r = stretchWorld(p, [1, 1, 2], [0, 0, 0]);
    expect(worldBox(r).min.z).toBeCloseTo(0, 3);
    expect(worldBox(r).max.z).toBeCloseTo(80, 3);
  });

  it('an object turned 90 degrees is not baked: same data, scale of the matching axis', () => {
    const p = placement(box(10, 20, 30), [0, 0, 15], 90);
    expect(isAxisAligned(p.quaternion)).toBe(true);
    const r = stretchWorld(p, [2, 1, 1], [0, 0, 0]);
    expect(r.data).toBe(p.data);
    expect(r.scale[0]).toBeCloseTo(1, 6);
    expect(r.scale[1]).toBeCloseTo(2, 6); // local Y runs along world X
  });

  it('a turned object stretched evenly is not baked either', () => {
    const p = placement(box(10, 20, 30), [3, 4, 15], 30);
    const r = stretchWorld(p, [2, 2, 2], [0, 0, 0]);
    expect(r.data).toBe(p.data);
    near(size(worldBox(r)), size(worldBox(p)).map((v) => v * 2));
  });

  it('a baked result matches the expected box for any anchor and stretch', () => {
    const p = placement(box(10, 20, 30), [12, -8, 15], 30);
    for (const f of [[1, 1.7, 1], [0.5, 1, 1], [1, 1, 3], [2, 0.4, 1.5]] as [number, number, number][]) {
      const anchor: [number, number, number] = [4, -3, 0];
      const r = stretchWorld(p, f, anchor);
      const want = expected(worldBox(p), f, anchor);
      // A box stretched along the world axes is still the old world box, stretched.
      near(worldBox(r).min.toArray(), want.min.toArray());
      near(worldBox(r).max.toArray(), want.max.toArray());
    }
  });
});

describe('isAxisAligned', () => {
  it('is true for quarter turns and false for others', () => {
    const q = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
    expect(isAxisAligned(new THREE.Quaternion())).toBe(true);
    expect(isAxisAligned(q(Math.PI / 2, Math.PI, 0))).toBe(true);
    expect(isAxisAligned(q(0, 0, 0.5))).toBe(false);
    expect(isAxisAligned([0, 0, 0, 1])).toBe(true);
  });
});
