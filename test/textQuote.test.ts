import assert from "node:assert/strict";
import test from "node:test";
import {
  findApproximateQuoteInSegments,
  findQuoteInSegments,
  findQuotesInSegments,
  normalizeForQuoteMatch,
  quoteMatchesSource,
  toVisibleSourceText,
} from "../src/core/textQuote";

test("finds a high-confidence OCR variant inside PDF character segments", () => {
  const segments = [..."the catalyst concentration was 0.30 wt percent"];

  assert.deepEqual(
    findApproximateQuoteInSegments(
      segments,
      "the catalyst concentratlon was 0.30 wt percent",
    ),
    {
      startSegment: 0,
      endSegment: 45,
      score: 0.974,
    },
  );
});

test("rejects an ambiguous approximate quote instead of highlighting randomly", () => {
  assert.equal(
    findApproximateQuoteInSegments(
      [..."alpha catalyst result filler alpha catalyst result"],
      "alpha catalvst result",
    ),
    undefined,
  );
});

test("aligns a MinerU quote with omitted scientific values to a local PDF span", () => {
  const source =
    "将体系置于10℃的冰水浴中恒温30min并通入氮气。复合引发剂AIBA:KPS:SMBS的配比为1:1:1。";

  assert.deepEqual(
    findApproximateQuoteInSegments(
      [...source],
      "将体系至于的冰水浴中恒温并通入氮气",
      { minScore: 0.62 },
    ),
    {
      startSegment: 0,
      endSegment: 24,
      score: 0.64,
    },
  );
});

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

test("removes MinerU HTML markup before matching PDF text", () => {
  assert.equal(
    normalizeForQuoteMatch(
      "表面反应降低了 <sup>H+</sup> 的浓度<sup>［7］</sup>",
    ),
    normalizeForQuoteMatch("表面反应降低了 H+ 的浓度［7］"),
  );
});

test("converts layout LaTeX into visible formula text", () => {
  assert.equal(
    toVisibleSourceText(
      "D _ {\\mathrm{e}} = \\left( C \\omega \\right) ^ {3 / 2}\\tag{2}",
    ),
    "D _ {e} = ( C ω ) ^ {3 / 2}(2)",
  );
});

test("matches a rich MinerU quote against plain PDF character segments", () => {
  assert.deepEqual(
    findQuoteInSegments(
      [..."H+有效传质系数与旋转角速度ω有关"],
      "<sup>H+</sup>有效传质系数与旋转角速度\\omega有关",
    ),
    { startSegment: 0, endSegment: 16 },
  );
});
