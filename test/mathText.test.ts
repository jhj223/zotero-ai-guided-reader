import assert from "node:assert/strict";
import test from "node:test";
import { splitMathText, stripLatexToText } from "../src/core/mathText";

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

test("turns malformed MinerU evidence LaTeX into readable text", () => {
  assert.equal(
    stripLatexToText(
      "的酸溶时间为10 min.而 SH2 ~ SH6 的酸溶时间均为 2 0 \\ \\mathrm { m i n _ { c } }",
    ),
    "的酸溶时间为10 min.而 SH2–SH6 的酸溶时间均为 20 min",
  );

  assert.equal(
    stripLatexToText(
      "黏度均大于 4 0 \\mathrm { \\ m P a \\cdot s _ { \\mathrm { ~ c ~ } } }其中 的表观黏度可达 5 9 . 8 8 ~ \\mathrm { m P a \\cdot s _ { \\odot } }",
    ),
    "黏度均大于 40 mPa·s 其中 的表观黏度可达 59.88 mPa·s",
  );
});

test("keeps common units readable while removing LaTeX wrappers", () => {
  assert.equal(stripLatexToText("\\mathrm { { ^ { \\circ } C } }"), "°C");
  assert.equal(stripLatexToText("\\mathrm { ~ s ~ } ^ { - 1 }"), "s⁻¹");
  assert.equal(stripLatexToText("\\smash { \\ 3 }"), "3");
  assert.equal(stripLatexToText("\\textcircled ~ { ~ C ~ }"), "°C");
  assert.equal(stripLatexToText("成本为 \\$5"), "成本为 $5");
});
