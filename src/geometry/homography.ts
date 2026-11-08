/**
 * 2-D projective transforms (homographies), stored as 9 numbers, row-major,
 * mapping (u, v, 1) to (x, y, w) → (x/w, y/w). Used to place a reference
 * picture on the ground and to undo perspective from four known corners.
 */
export type H = number[];

export function applyH(h: H, u: number, v: number): [number, number] {
  const w = h[6] * u + h[7] * v + h[8];
  return [(h[0] * u + h[1] * v + h[2]) / w, (h[3] * u + h[4] * v + h[5]) / w];
}

export function multiplyH(a: H, b: H): H {
  const r: H = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]);
  }
  return r;
}

export function invertH(h: H): H {
  const [a, b, c, d, e, f, g, k, l] = h;
  const A = e * l - f * k, B = -(d * l - f * g), C = d * k - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('The picture mapping cannot be inverted');
  return [
    A / det, -(b * l - c * k) / det, (b * f - c * e) / det,
    B / det, (a * l - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * k - b * g) / det, (a * e - b * d) / det,
  ];
}

/** Similarity transform: rotate by `angle` (radians) and scale by `s` about (cx, cy), then shift by (tx, ty). */
export function similarityH(s: number, angle: number, cx: number, cy: number, tx = 0, ty = 0): H {
  const c = Math.cos(angle) * s, sn = Math.sin(angle) * s;
  return [c, -sn, cx - c * cx + sn * cy + tx, sn, c, cy - sn * cx - c * cy + ty, 0, 0, 1];
}

/** Homography taking four source points exactly to four target points (no three in a line). */
export function solveH(src: [number, number][], dst: [number, number][]): H {
  // 8 unknowns (h33 = 1): two equations per point pair.
  const m: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i], [x, y] = dst[i];
    m.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    m.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) throw new Error('Those points don\'t form a proper four-sided shape');
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 9; c++) m[r][c] -= f * m[col][c];
    }
  }
  const h = m.map((row, i) => row[8] / row[i]);
  return [...h, 1];
}
