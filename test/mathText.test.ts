import assert from "node:assert/strict";
import test from "node:test";
import { splitMathText } from "../src/core/mathText";

test("splits inline and display LaTeX without treating escaped dollars as math", () => {
  assert.deepEqual(splitMathText("成本为 \\$5，且 $E=mc^2$。\\[x^2+y^2\\]"), [
    { type: "text", value: "成本为 $5，且 " },
    { type: "math", value: "E=mc^2", display: false },
    { type: "text", value: "。" },
    { type: "math", value: "x^2+y^2", display: true },
  ]);
});

test("leaves unmatched math delimiters as text", () => {
  assert.deepEqual(splitMathText("结果是 $x+1"), [
    { type: "text", value: "结果是 $x+1" },
  ]);
});
