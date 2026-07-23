import assert from "node:assert/strict";
import test from "node:test";
import { tableHtmlToRows } from "../src/core/tableHtml";

test("converts MinerU table HTML to safe rows", () => {
  assert.deepEqual(
    tableHtmlToRows(
      "<table><tr><th>Method</th><th>Value</th></tr>" +
        "<tr><td>s-CQDs</td><td>4.1&nbsp;nm</td></tr></table>",
    ),
    [
      ["Method", "Value"],
      ["s-CQDs", "4.1 nm"],
    ],
  );
});

test("limits malformed or oversized table output", () => {
  const rows = tableHtmlToRows(
    `<table>${"<tr><td>x</td></tr>".repeat(100)}</table>`,
  );
  assert.equal(rows.length, 50);
  assert.deepEqual(tableHtmlToRows("plain text"), []);
});
