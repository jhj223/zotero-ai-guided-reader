import assert from "node:assert/strict";
import test from "node:test";
import {
  findQuoteInSegments,
  findQuotesInSegments,
  normalizeForQuoteMatch,
  quoteMatchesSource,
} from "../src/core/textQuote";

test("normalizes punctuation, whitespace, case, and compatibility ligatures", () => {
  assert.equal(
    normalizeForQuoteMatch("The \uFB01nal result: 4.1 nm"),
    "thefinalresult41nm",
  );
});

test("returns every occurrence so the reader can disambiguate by position", () => {
  assert.deepEqual(
    findQuotesInSegments(
      ["alpha beta", " filler ", "alpha beta"],
      "alpha beta",
    ),
    [
      { startSegment: 0, endSegment: 0 },
      { startSegment: 2, endSegment: 2 },
    ],
  );
});

test("finds a quote across PDF character segments and line-end hyphenation", () => {
  const segments = [
    "were thoroughly dis-",
    "\n",
    "solved in a binary solvent matrix",
  ];

  assert.deepEqual(
    findQuoteInSegments(segments, "thoroughly dissolved in a binary solvent"),
    { startSegment: 0, endSegment: 2 },
  );
});

test("requires a meaningful verbatim quote from the source anchor", () => {
  const source =
    "3.33 g of sucrose and 1.8 g of dodecylamine were thoroughly dissolved.";

  assert.equal(
    quoteMatchesSource(
      source,
      "sucrose and 1.8 g of dodecylamine were thoroughly dissolved",
    ),
    true,
  );
  assert.equal(quoteMatchesSource(source, "unreported mechanism"), false);
  assert.equal(quoteMatchesSource(source, "3.33 g"), false);
});
