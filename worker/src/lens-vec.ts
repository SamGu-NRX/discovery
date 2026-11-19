// Vector checks and arithmetic for lens scoring (src/lens.ts). No imports, so
// the tests load this file directly.
//
// A taste is the cosine after subtracting a background mean. Two failures
// would make that quietly wrong instead of failing: a zero (or near-zero)
// vector, which unit() cannot normalize and which, as a background, turns
// the centered cosine back into a raw one; and vectors of different lengths,
// which make a mean NaN or score a missing dimension as 0. Every vector that
// reaches the arithmetic here has passed one of these checks.

export class VectorError extends Error {}

// Below this norm a vector carries no direction worth scoring.
export const MIN_NORM = 1e-6;

const norm = (v: number[]) => Math.hypot(...v);

export function isVector(v: unknown): v is number[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && Number.isFinite(x)) && norm(v as number[]) >= MIN_NORM;
}

// Throws unless every entry is a usable vector and all share one length.
// Returns that length.
export function checkVectors(vs: unknown[], what: string): number {
  if (!vs.length) throw new VectorError(`${what}: no vectors`);
  const bad = vs.findIndex((v) => !isVector(v));
  if (bad >= 0) throw new VectorError(`${what}: entry ${bad} is not a finite vector with norm at least ${MIN_NORM}`);
  const dim = (vs[0] as number[]).length;
  const other = vs.findIndex((v) => (v as number[]).length !== dim);
  if (other >= 0) throw new VectorError(`${what}: entry ${other} has ${(vs[other] as number[]).length} dimensions, entry 0 has ${dim}`);
  return dim;
}

// A mean or centroid read back from D1. A stored zero mean is refused rather
// than used, since it would score raw cosines.
export function parseStoredVector(json: string, what: string, dim?: number): number[] {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new VectorError(`${what} is not valid JSON`);
  }
  checkVectors([v], what);
  if (dim !== undefined && (v as number[]).length !== dim) throw new VectorError(`${what} has ${(v as number[]).length} dimensions, expected ${dim}`);
  return v as number[];
}

export function unit(v: number[]): number[] {
  const n = norm(v);
  if (n < MIN_NORM) throw new VectorError("cannot normalize a zero vector");
  return v.map((x) => x / n);
}

function sameLength(a: number[], b: number[], what: string) {
  if (a.length !== b.length) throw new VectorError(`${what}: ${a.length} dimensions against ${b.length}`);
}

export function dot(a: number[], b: number[]): number {
  sameLength(a, b, "dot product");
  return a.reduce((s, x, i) => s + x * b[i], 0);
}

export function meanOf(vs: number[][]): number[] {
  checkVectors(vs, "mean");
  return vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length);
}

// The unit vector of v minus the background mean.
export function centered(v: number[], mean: number[]): number[] {
  sameLength(v, mean, "embedding against background");
  const u = unit(v);
  return unit(u.map((x, i) => x - mean[i]));
}
