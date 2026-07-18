import assert from "node:assert/strict";
import test from "node:test";
import { anchorToPdfRect } from "../src/core/anchorRect";

test("flips a point-unit bbox from top-left to PDF bottom-left origin", () => {
  // A 612x792pt page: MinerU y grows downward, PDF rects grow upward.
  assert.deepEqual(
    anchorToPdfRect([62, 100, 500, 120], { width: 612, height: 792 }),
    [62, 672, 500, 692],
  );
});

test("scales a 0-1000 normalized bbox onto the page before flipping", () => {
  // vlm-style bbox on the same page: values exceed the page size, so they
  // are interpreted on MinerU's 0-1000 grid.
  assert.deepEqual(
    anchorToPdfRect([100, 500, 900, 950], { width: 500, height: 1000 }),
    [50, 50, 450, 500],
  );
});

test("normalizes swapped corners into an ordered rect", () => {
  assert.deepEqual(
    anchorToPdfRect([500, 120, 62, 100], { width: 612, height: 792 }),
    [62, 672, 500, 692],
  );
});
