// Vector checks behind lens scoring (src/lens-vec.ts). Loaded as TypeScript
// by Node's type stripping.

import assert from "node:assert/strict";
import { test } from "node:test";
import { centered, checkVectors, dot, isVector, meanOf, parseStoredVector, unit, VectorError } from "../src/lens-vec.ts";

test("zero, near-zero, empty and non-finite vectors are not vectors", () => {
  assert.equal(isVector([0, 0, 0]), false);
  assert.equal(isVector([1e-9, 0]), false);
  assert.equal(isVector([]), false);
  assert.equal(isVector([1, Number.NaN]), false);
  assert.equal(isVector([0.1, 0.2]), true);
  assert.throws(() => unit([0, 0]), VectorError);
});

test("vectors of different lengths are refused everywhere instead of padding with zeros", () => {
  assert.throws(() => checkVectors([[1, 0], [1, 0, 0]], "batch"), /entry 1 has 3 dimensions, entry 0 has 2/);
  assert.throws(() => meanOf([[1, 0], [1, 0, 0]]), VectorError);
  assert.throws(() => dot([1, 0], [1, 0, 0]), /2 dimensions against 3/);
  assert.throws(() => centered([1, 0, 0], [0.5, 0.5]), /embedding against background/);
  assert.equal(checkVectors([[1, 0], [0, 1]], "batch"), 2);
});

test("a stored mean or centroid is parsed, checked, and refused when zero, malformed or of the wrong length", () => {
  assert.deepEqual(parseStoredVector("[0.5,0.5]", "mean", 2), [0.5, 0.5]);
  assert.throws(() => parseStoredVector("[0,0]", "background 3 of acct"), /background 3 of acct: entry 0 is not a finite vector/);
  assert.throws(() => parseStoredVector("not json", "centroid"), /centroid is not valid JSON/);
  assert.throws(() => parseStoredVector("[1,0,0]", "centroid", 2), /has 3 dimensions, expected 2/);
});

test("centering takes the background out of the unit vector", () => {
  assert.deepEqual(centered([2, 0], [0.5, 0]), [1, 0]);
  const d = centered([1, 1], [Math.SQRT1_2, 0]);
  assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-12);
  assert.ok(d[1] > d[0], "the shared direction is taken out");
});
