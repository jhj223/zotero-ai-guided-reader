import assert from "node:assert/strict";
import test from "node:test";
import { renderSafeMathHtml } from "../src/core/safeMathHtml";

test("renders ordinary formulas as KaTeX MathML", () => {
  const html = renderSafeMathHtml("E=mc^2", false);
  assert.match(html || "", /<math/);
  assert.doesNotMatch(html || "", /<script|onerror|javascript:/i);
});

test("does not allow trusted HTML or URL commands to create active content", () => {
  for (const latex of [
    String.raw`\href{javascript:alert(1)}{click}`,
    String.raw`\htmlClass{evil}{x}`,
    String.raw`\includegraphics{https://attacker.invalid/a.png}`,
  ]) {
    const html = renderSafeMathHtml(latex, false) || "";
    assert.doesNotMatch(
      html,
      /<script|<img|javascript:|onerror\s*=|onclick\s*=/i,
    );
  }
});

test("rejects oversized formulas before rendering", () => {
  assert.equal(renderSafeMathHtml("x".repeat(4097), false), null);
});
