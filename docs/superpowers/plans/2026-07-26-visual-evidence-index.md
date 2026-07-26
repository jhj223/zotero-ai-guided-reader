# Visual Evidence Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add locally validated, clickable figure, table, and equation indexes to both overview and close-reading answers while preserving full visual cards, strict text quotes, Zotero Note links, and plain Anki cards.

**Architecture:** Keep verbatim text `evidence` unchanged and add a separate `visualEvidence` reference list that stores only local MinerU anchor IDs. A focused core utility validates visual anchor types and derives labels from local caption metadata; prompts, response normalization, UI, and Note export consume that shared representation. Existing `openAnchor()` supplies bbox-to-page fallback navigation, and a guide-cache version bump regenerates answers without re-parsing PDFs.

**Tech Stack:** TypeScript, React 19, Node test runner through `tsx`, Zotero 9 bootstrap plugin APIs, MinerU v3 anchors, KaTeX, `zotero-plugin-scaffold`.

---

## File Structure

- Create `src/core/visualEvidence.ts`: visual-anchor type guard, local normalization, explicit-reference detection, and shared label generation.
- Create `test/visualEvidence.test.ts`: behavior tests for visual normalization, reference detection, and labels.
- Modify `src/core/types.ts`: add `VisualEvidenceReference` and optional fields on overview/section points.
- Modify `src/core/llmResponses.ts`: normalize visual references, reject explicit unindexed visual claims, and serialize visual anchors.
- Modify `src/runtime/llmClient.ts`: require visual references in overview and section JSON contracts.
- Modify `src/runtime/cache.ts`: bump the guide cache version only.
- Modify `test/llmResponses.test.ts`, `test/llmPrompt.test.ts`, and `test/guideCacheVersion.test.ts`: cover prompt, normalization, serialization, and cache behavior.
- Modify `src/ui/GuidedReaderApp.tsx`: show point-level visual index buttons and retain deduplicated visual cards.
- Modify `test/guidedReaderUi.test.ts`: assert overview/section wiring and bbox navigation inputs.
- Modify `src/runtime/notes.ts`: render visual anchor placeholders with type-aware labels.
- Modify `test/ankiExport.test.ts`: prove visual anchor placeholders remain absent from cards.
- Create `test/notes.test.ts`: prove text and visual Note links render correctly.
- Modify `README.md` and `CLAUDE.md`: record whole-object visual indexing and retain sub-element navigation as out of scope.

### Task 1: Add the visual evidence core model

**Files:**

- Create: `src/core/visualEvidence.ts`
- Create: `test/visualEvidence.test.ts`
- Modify: `src/core/types.ts:78-110`

- [ ] **Step 1: Write failing core behavior tests**

Create `test/visualEvidence.test.ts` with representative text, image, table, and equation anchors:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeVisualEvidence,
  requiresVisualEvidence,
  visualEvidenceLabel,
} from "../src/core/visualEvidence";
import type { AnchorChunk } from "../src/core/types";

const anchors: AnchorChunk[] = [
  {
    id: "text_1",
    type: "text",
    pageIndex: 0,
    pageNumber: 1,
    text: "Ordinary paragraph",
    sectionPath: ["Results"],
  },
  {
    id: "image_1",
    type: "image",
    pageIndex: 4,
    pageNumber: 5,
    bbox: [100, 200, 900, 700],
    text: "Figure 2. Viscosity response",
    sectionPath: ["Results"],
    richContent: { caption: "Figure 2. Viscosity response" },
  },
  {
    id: "table_1",
    type: "table",
    pageIndex: 6,
    pageNumber: 7,
    text: "表1 实验条件",
    sectionPath: ["Methods"],
    richContent: { caption: "表1 实验条件", tableHtml: "<table></table>" },
  },
  {
    id: "equation_1",
    type: "equation",
    pageIndex: 7,
    pageNumber: 8,
    text: "Equation (3)",
    sectionPath: ["Theory"],
    richContent: { latex: "y=ax+b", caption: "Equation (3)" },
  },
];

test("keeps unique known visual anchors and rejects text anchors", () => {
  assert.deepEqual(
    normalizeVisualEvidence(
      [
        { anchorId: "image_1" },
        { anchorId: "text_1" },
        { anchorId: "missing" },
        { anchorId: "image_1" },
        { anchorId: "table_1" },
        { anchorId: "equation_1", page: 99 },
      ],
      new Map(anchors.map((anchor) => [anchor.id, anchor])),
    ),
    [{ anchorId: "image_1" }, { anchorId: "table_1" }],
  );
});

test("derives visual labels from local caption metadata", () => {
  assert.equal(visualEvidenceLabel(anchors[1]), "图 2");
  assert.equal(visualEvidenceLabel(anchors[2]), "表 1");
  assert.equal(visualEvidenceLabel(anchors[3]), "公式 3");
});

test("detects explicit visual references without matching ordinary words", () => {
  assert.equal(requiresVisualEvidence("如图 2 所示，黏度随温度变化。"), true);
  assert.equal(requiresVisualEvidence("Table 4 compares all samples."), true);
  assert.equal(requiresVisualEvidence("作者试图解释该机制。"), false);
  assert.equal(requiresVisualEvidence("该表达方式保持不变。"), false);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
npx tsx --test test/visualEvidence.test.ts
```

Expected: FAIL because `src/core/visualEvidence.ts` and `VisualEvidenceReference` do not exist.

- [ ] **Step 3: Add the minimal type definitions**

Add to `src/core/types.ts`:

```ts
export interface VisualEvidenceReference {
  anchorId: string;
}

export interface OutlineBullet {
  claim: string;
  anchorIds: string[];
  evidence: EvidenceReference[];
  visualEvidence?: VisualEvidenceReference[];
}

export interface SectionGuidePoint {
  category: SectionGuideCategory;
  text: string;
  evidence: EvidenceReference[];
  visualEvidence?: VisualEvidenceReference[];
}
```

- [ ] **Step 4: Implement the core utility**

Create `src/core/visualEvidence.ts` with these public functions:

```ts
import type { AnchorChunk, VisualEvidenceReference } from "./types";

const VISUAL_TYPES = new Set(["equation", "table", "image"]);
const MAX_VISUAL_EVIDENCE = 3;

export function isVisualAnchor(
  anchor: AnchorChunk | undefined,
): anchor is AnchorChunk {
  return Boolean(anchor && VISUAL_TYPES.has(anchor.type));
}

export function normalizeVisualEvidence(
  value: unknown,
  anchorById: Map<string, AnchorChunk>,
): VisualEvidenceReference[] {
  if (!Array.isArray(value)) return [];
  const result: VisualEvidenceReference[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof (item as { anchorId?: unknown }).anchorId !== "string"
    ) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "anchorId")) continue;
    const anchorId = (record.anchorId as string).trim();
    if (!anchorId || seen.has(anchorId)) continue;
    if (!isVisualAnchor(anchorById.get(anchorId))) continue;
    result.push({ anchorId });
    seen.add(anchorId);
    if (result.length >= MAX_VISUAL_EVIDENCE) break;
  }
  return result;
}

export function requiresVisualEvidence(text: string): boolean {
  return /(?:图\s*[A-Za-z0-9]+|表\s*[A-Za-z0-9]+|如图|由表|Fig(?:ure)?\.?\s*[A-Za-z0-9]+|Table\s*[A-Za-z0-9]+|(?:公式|Equation|Eq\.?)\s*\(?[A-Za-z0-9.-]+\)?)/iu.test(
    text,
  );
}

export function visualEvidenceLabel(anchor: AnchorChunk): string {
  const source = [
    anchor.richContent?.caption,
    anchor.richContent?.description,
    anchor.text,
  ]
    .filter(Boolean)
    .join(" ");
  if (anchor.type === "image") {
    const match = source.match(
      /(?:图|Figure|Fig\.?)\s*([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)?)/iu,
    );
    return match ? `图 ${match[1]}` : "图表";
  }
  if (anchor.type === "table") {
    const match = source.match(
      /(?:表|Table)\s*([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)?)/iu,
    );
    return match ? `表 ${match[1]}` : "表格";
  }
  const explicit = source.match(
    /(?:公式|Equation|Eq\.?)\s*\(?([A-Za-z0-9.-]+)\)?/iu,
  );
  const trailing = source.match(/\(([0-9]+(?:\.[0-9]+)?)\)\s*$/u);
  const number = explicit?.[1] || trailing?.[1];
  return number ? `公式 ${number}` : "公式";
}
```

- [ ] **Step 5: Run the core test and verify GREEN**

Run:

```powershell
npx tsx --test test/visualEvidence.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 6: Commit the core model**

```powershell
git add -- src/core/types.ts src/core/visualEvidence.ts test/visualEvidence.test.ts
git commit -m "feat(reader): add visual evidence model"
```

### Task 2: Require and validate visual references in generated answers

**Files:**

- Modify: `src/core/llmResponses.ts:1-185`
- Modify: `src/runtime/llmClient.ts:153-225`
- Modify: `src/runtime/cache.ts:7-12`
- Modify: `test/llmResponses.test.ts`
- Modify: `test/llmPrompt.test.ts`
- Modify: `test/guideCacheVersion.test.ts`

- [ ] **Step 1: Add failing response-normalization tests**

Extend the anchor fixture in `test/llmResponses.test.ts` with an image anchor and add tests proving:

```ts
test("keeps validated visual evidence and adds it to section scope", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          bullets: [
            {
              claim: "如图 2 所示，黏度随温度变化。",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "chunk_0002",
                  quote: "remained stable in 7000 mg/L NaCl",
                },
              ],
              visualEvidence: [{ anchorId: "figure_0001" }],
            },
          ],
        },
      ],
    },
    anchors,
  );

  assert.deepEqual(outline.sections[0].bullets[0].visualEvidence, [
    { anchorId: "figure_0001" },
  ]);
  assert.deepEqual(outline.sections[0].anchorIds, [
    "chunk_0002",
    "figure_0001",
  ]);
});

test("drops explicit visual claims without a valid visual anchor", () => {
  const outline = filterOutlineToKnownAnchors(
    {
      title: "Paper",
      sections: [
        {
          title: "Results",
          bullets: [
            {
              claim: "Figure 2 shows a monotonic response.",
              anchorIds: [],
              evidence: [
                {
                  anchorId: "chunk_0002",
                  quote: "remained stable in 7000 mg/L NaCl",
                },
              ],
              visualEvidence: [{ anchorId: "missing" }],
            },
          ],
        },
      ],
    },
    anchors,
  );
  assert.deepEqual(outline.sections, []);
});
```

Add the image fixture used above:

```ts
anchors.push({
  id: "figure_0001",
  type: "image",
  pageIndex: 4,
  pageNumber: 5,
  bbox: [100, 200, 900, 700],
  text: "Figure 2. Viscosity response",
  sectionPath: ["Results"],
  richContent: { caption: "Figure 2. Viscosity response" },
});
```

Add section-guide coverage with complete expected values:

```ts
test("keeps valid section visual evidence", () => {
  const guide = normalizeSectionGuide(
    {
      title: "Results",
      points: [
        {
          category: "fact",
          text: "Figure 2 shows the reported response.",
          evidence: [
            {
              anchorId: "chunk_0002",
              quote: "remained stable in 7000 mg/L NaCl",
            },
          ],
          visualEvidence: [{ anchorId: "figure_0001" }],
        },
      ],
    },
    anchors,
    "Results",
  );
  assert.deepEqual(guide.points[0].visualEvidence, [
    { anchorId: "figure_0001" },
  ]);
});

test("rejects an explicit section visual claim without a valid visual anchor", () => {
  assert.throws(
    () =>
      normalizeSectionGuide(
        {
          title: "Results",
          points: [
            {
              category: "fact",
              text: "Figure 2 shows the reported response.",
              evidence: [
                {
                  anchorId: "chunk_0002",
                  quote: "remained stable in 7000 mg/L NaCl",
                },
              ],
              visualEvidence: [{ anchorId: "missing" }],
            },
          ],
        },
        anchors,
        "Results",
      ),
    /traceable|quote|evidence/i,
  );
});
```

- [ ] **Step 2: Run response tests and verify RED**

Run:

```powershell
npx tsx --test test/llmResponses.test.ts
```

Expected: FAIL because `visualEvidence` is neither normalized nor added to `anchorIds`.

- [ ] **Step 3: Implement visual normalization**

Import `normalizeVisualEvidence` and `requiresVisualEvidence` in `src/core/llmResponses.ts`. In both outline bullet and section point normalization:

```ts
const visualEvidence = normalizeVisualEvidence(
  rawItem.visualEvidence,
  anchorById,
);
if (requiresVisualEvidence(text) && visualEvidence.length === 0) {
  return undefined;
}
```

Return `visualEvidence` only when non-empty, and compute outline `anchorIds` from both evidence kinds:

```ts
anchorIds: [
  ...new Set([
    ...evidence.map((item) => item.anchorId),
    ...visualEvidence.map((item) => item.anchorId),
  ]),
],
```

Update `sectionGuideToMarkdown()` so each point serializes both text and visual references as `[[ANCHOR:id]]` placeholders without duplicating an ID.

- [ ] **Step 4: Run response tests and verify GREEN**

Run:

```powershell
npx tsx --test test/llmResponses.test.ts
```

Expected: all response tests PASS.

- [ ] **Step 5: Add failing prompt and cache tests**

Update `test/llmPrompt.test.ts` to require `"visualEvidence"` in both prompts and language that makes it mandatory for figure/table/equation-derived claims. Update `test/guideCacheVersion.test.ts`:

```ts
assert.match(cache, /GUIDE_CACHE_VERSION = 3/);
```

Run:

```powershell
npx tsx --test test/llmPrompt.test.ts test/guideCacheVersion.test.ts
```

Expected: FAIL because prompts omit the new property and the guide version remains 2.

- [ ] **Step 6: Update both LLM JSON contracts and rules**

Change the outline and section examples in `src/runtime/llmClient.ts` to include:

```json
"visualEvidence":[{"anchorId":"chunk_0042"}]
```

Add explicit rules that:

- a visual-derived answer must include the direct visual anchor;
- unrelated same-section visuals must not be added;
- `anchorId` must name a supplied `equation`, `table`, or `image` anchor;
- text `evidence` remains required.

Set in `src/runtime/cache.ts`:

```ts
export const GUIDE_CACHE_VERSION = 3;
```

- [ ] **Step 7: Run prompt, cache, and response tests**

Run:

```powershell
npx tsx --test test/llmPrompt.test.ts test/guideCacheVersion.test.ts test/llmResponses.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 8: Commit generation and validation**

```powershell
git add -- src/core/llmResponses.ts src/runtime/llmClient.ts src/runtime/cache.ts test/llmResponses.test.ts test/llmPrompt.test.ts test/guideCacheVersion.test.ts
git commit -m "feat(reader): validate visual evidence references"
```

### Task 3: Render clickable indexes in overview and close reading

**Files:**

- Modify: `src/ui/GuidedReaderApp.tsx:104-120,218-240,249-371,401-504,634-660`
- Modify: `test/guidedReaderUi.test.ts`

- [ ] **Step 1: Add failing UI wiring assertions**

Extend `test/guidedReaderUi.test.ts` to require:

```ts
assert.match(source, /function VisualEvidenceLinks/);
assert.match(source, /visualEvidence=\{bullet\.visualEvidence \|\| \[\]\}/);
assert.match(source, /visualEvidence=\{point\.visualEvidence \|\| \[\]\}/);
assert.match(source, /visualEvidenceLabel/);
assert.match(source, /pageSizes=\{pageSizes\}/);
assert.match(source, /zg-visual-evidence-links/);
```

Also assert that `generatedGuideText` gathers `bullet.visualEvidence` anchor IDs and that the bottom-card union contains `point.visualEvidence`.

- [ ] **Step 2: Run UI test and verify RED**

Run:

```powershell
npx tsx --test test/guidedReaderUi.test.ts
```

Expected: FAIL because `VisualEvidenceLinks` and its wiring do not exist.

- [ ] **Step 3: Add visual index rendering**

Import `visualEvidenceLabel` and `VisualEvidenceReference`. Add:

```tsx
function VisualEvidenceLinks({
  visualEvidence,
  anchors,
  pageSizes,
  service,
}: {
  visualEvidence: VisualEvidenceReference[];
  anchors: AnchorChunk[];
  pageSizes?: Record<number, PageSize>;
  service: GuidedReadingService;
}) {
  const anchorsById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const visualAnchors = visualEvidence
    .map((reference) => anchorsById.get(reference.anchorId))
    .filter((anchor): anchor is AnchorChunk => Boolean(anchor));
  if (!visualAnchors.length) return null;
  const parsed = { anchors, pageSizes, sourceFiles: [] };
  return (
    <span className="zg-visual-evidence-links">
      {visualAnchors.map((anchor) => (
        <AnchorButton
          key={anchor.id}
          anchor={anchor}
          parsed={parsed}
          service={service}
        >
          <span className="zg-visual-evidence-link">
            {visualEvidenceLabel(anchor)} · 第 {anchor.pageNumber} 页
          </span>
        </AnchorButton>
      ))}
    </span>
  );
}
```

Render this immediately after each overview `EvidenceLinkedClaim` and each close-reading `EvidenceLinkedClaim`.

- [ ] **Step 4: Preserve and deduplicate complete visual cards**

Include every normalized `point.visualEvidence` ID in `GuideContent.visualAnchors`. Continue including `sectionAnchorIds` so previously selected complete cards remain visible. Pass `pageSizes` into `VisualEvidence`, construct the same minimal parsed object, and supply it to the card’s `AnchorButton` so normalized bbox coordinates have page-size context.

- [ ] **Step 5: Add responsive chip styles**

Add styles that wrap naturally in a narrow Zotero sidebar:

```css
.zg-visual-evidence-links {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-left: 6px;
  vertical-align: baseline;
}
.zg-visual-evidence-links .zg-anchor-button {
  height: auto !important;
}
.zg-visual-evidence-link {
  background: #edf4fb;
  border: 1px solid #bfd1e3;
  border-radius: 999px;
  color: #315f8c;
  display: inline-block;
  font-size: 11px;
  line-height: 1.45;
  padding: 1px 6px;
  white-space: nowrap;
}
```

- [ ] **Step 6: Include overview visual anchors in exported guide text**

When building `generatedGuideText`, combine and deduplicate:

```ts
[
  ...bullet.evidence.map((item) => item.anchorId),
  ...(bullet.visualEvidence || []).map((item) => item.anchorId),
];
```

Serialize each as the existing `[[ANCHOR:id]]` placeholder.

- [ ] **Step 7: Run the UI test and verify GREEN**

Run:

```powershell
npx tsx --test test/guidedReaderUi.test.ts
```

Expected: all UI source-contract tests PASS.

- [ ] **Step 8: Commit reader rendering**

```powershell
git add -- src/ui/GuidedReaderApp.tsx test/guidedReaderUi.test.ts
git commit -m "feat(reader): link visual evidence in answers"
```

### Task 4: Preserve visual links in Zotero Notes and plain cards in Anki

**Files:**

- Modify: `src/runtime/notes.ts`
- Create: `test/notes.test.ts`
- Modify: `test/ankiExport.test.ts`
- Modify: `test/llmResponses.test.ts`

- [ ] **Step 1: Add a failing Zotero Note integration test**

Create `test/notes.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { saveGuideAsNote } from "../src/runtime/notes";
import type { AnchorChunk } from "../src/core/types";

test("renders type-aware text and visual links in a Zotero Note", async () => {
  const runtime = globalThis as unknown as Record<string, unknown>;
  const previousZotero = runtime.Zotero;
  let savedHtml = "";

  class FakeNote {
    libraryID = 0;
    parentID = 0;
    setNote(value: string) {
      savedHtml = value;
    }
    async saveTx() {
      return 101;
    }
  }

  runtime.Zotero = {
    Item: FakeNote,
    Libraries: {
      get() {
        return { libraryType: "user" };
      },
    },
  };

  const anchors: AnchorChunk[] = [
    {
      id: "text_1",
      type: "text",
      pageIndex: 0,
      pageNumber: 1,
      text: "Methods",
      sectionPath: [],
    },
    {
      id: "figure_1",
      type: "image",
      pageIndex: 4,
      pageNumber: 5,
      text: "Figure 2. Viscosity response",
      sectionPath: [],
      richContent: { caption: "Figure 2. Viscosity response" },
    },
  ];

  try {
    await saveGuideAsNote({
      attachment: { key: "ATTACH1", libraryID: 1 } as Zotero.Item,
      parentItem: { id: 20, libraryID: 1 } as Zotero.Item,
      title: "Paper",
      markdown: "方法 [[ANCHOR:text_1]]\n\n图表结论 [[ANCHOR:figure_1]]",
      anchors,
    });
  } finally {
    runtime.Zotero = previousZotero;
  }

  assert.match(savedHtml, />p\.1<\/a>/);
  assert.match(savedHtml, />图 2 · p\.5<\/a>/);
  assert.match(
    savedHtml,
    /zotero:\/\/open-pdf\/library\/items\/ATTACH1\?page=5/,
  );
});
```

Use one text anchor and one `image` anchor whose caption is `Figure 2`.

- [ ] **Step 2: Run the Note test and verify RED**

Run:

```powershell
npx tsx --test test/notes.test.ts
```

Expected: FAIL because every anchor currently renders only `p.N`.

- [ ] **Step 3: Render type-aware Note labels**

Import `isVisualAnchor` and `visualEvidenceLabel` in `src/runtime/notes.ts`. Replace the fixed link text with:

```ts
const label = isVisualAnchor(anchor)
  ? `${visualEvidenceLabel(anchor)} · p.${anchor.pageNumber}`
  : `p.${anchor.pageNumber}`;
return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
```

- [ ] **Step 4: Run the Note test and verify GREEN**

Run:

```powershell
npx tsx --test test/notes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add and run Anki regression coverage**

Extend `test/ankiExport.test.ts` with:

```ts
test("strips text and visual anchor placeholders from Anki cards", () => {
  const output = buildAnkiTsv({
    title: "Paper",
    guideText:
      "图表结果说明体系保持稳定。 [[ANCHOR:chunk_0001]] [[ANCHOR:figure_0001]]",
  });
  assert.doesNotMatch(output.content, /ANCHOR|zotero:\/\/open-pdf/);
  assert.match(output.content, /图表结果说明体系保持稳定/);
});
```

Run:

```powershell
npx tsx --test test/ankiExport.test.ts test/notes.test.ts test/llmResponses.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit export behavior**

```powershell
git add -- src/runtime/notes.ts test/notes.test.ts test/ankiExport.test.ts test/llmResponses.test.ts
git commit -m "feat(reader): preserve visual links in notes"
```

### Task 5: Align product documentation

**Files:**

- Modify: `README.md:58-101`
- Modify: `CLAUDE.md:21-40`

- [ ] **Step 1: Update confirmed requirements**

Add these product statements to the “生成与个性化” and “原文定位” sections of `README.md`:

```markdown
- 概览和章节精读中凡依据图、表或公式生成的论述，都会显示经过本地校验的图表索引；点击后优先高亮对应的完整 bbox，失败时降级到所在页面。
- 章节末尾继续集中展示本节涉及的完整公式、表格和图片卡片。保存为 Zotero Note 时保留图表跳转；Anki 仍导出不含 Zotero 链接的纯问答卡片。
```

Replace the broad known limitation with:

```markdown
- 图、表和公式支持完整对象级定位；子图、曲线、数据点、表格单元格和公式子表达式级定位不在当前范围。
```

Update the confirmed requirement in `CLAUDE.md` to:

```markdown
- Render formulas with LaTeX/KaTeX. Preserve readable tables and MinerU figure
  assets/descriptions. Every overview or close-reading claim derived from a
  figure, table, or equation must retain a validated whole-object visual anchor.
  Subfigure, curve, data-point, table-cell, and expression-part navigation
  remains out of scope.
```

- [ ] **Step 2: Run formatting checks on documentation and code**

Run:

```powershell
npx prettier --check README.md CLAUDE.md docs/superpowers/specs/2026-07-26-visual-evidence-index-design.md docs/superpowers/plans/2026-07-26-visual-evidence-index.md
```

Expected: all files use Prettier formatting.

- [ ] **Step 3: Commit documentation**

```powershell
git add -- README.md CLAUDE.md
git commit -m "docs(reader): document visual source indexes"
```

### Task 6: Full verification, build, installation, and live Zotero check

**Files:**

- Verify only; do not commit `.scaffold/build`, Zotero profile files, caches, or logs.

- [ ] **Step 1: Run the complete automated suite**

Run:

```powershell
npm test
npm run lint:check
npm run build
git diff --check
```

Expected:

- all Node tests PASS;
- Prettier and ESLint PASS;
- production XPI build and `tsc --noEmit` PASS;
- no whitespace errors.

- [ ] **Step 2: Review repository state and scan for secrets**

Run:

```powershell
git status --short --branch
git log --oneline -8
git grep -n -I -E "debug-bridge\\.token|Bearer [A-Za-z0-9._-]{12,}" -- ':!package-lock.json'
```

Expected: only intentional source/document changes are committed; no plaintext temporary token or credential appears.

- [ ] **Step 3: Install the exact production XPI**

Build path:

```text
C:\Users\pc\Documents\zotero ai\.scaffold\build\zotero-ai-guided-reader.xpi
```

Use the installed Zotero Debug Bridge only for the bounded `AddonManager` uninstall/reinstall operation. Generate a one-time token, save it in the Zotero profile, restart Zotero, POST JavaScript that calls `AddonManager.getInstallForFile()` and `install()`, then clear and persist `debug-bridge.token` from inside Zotero. Do not log the token. Verify a second bridge request returns `500 token not configured`.

- [ ] **Step 4: Verify installed artifact identity**

Run:

```powershell
$profile = 'C:\Users\pc\AppData\Roaming\Zotero\Zotero\Profiles\50uh9g9g.default'
$built = 'C:\Users\pc\Documents\zotero ai\.scaffold\build\zotero-ai-guided-reader.xpi'
$installed = Join-Path $profile 'extensions\zotero-ai-guided-reader@local.xpi'
Get-Item -LiteralPath $built, $installed | Select-Object FullName, Length
Get-FileHash -LiteralPath $built, $installed -Algorithm SHA256
```

Expected: built and installed XPI lengths and SHA-256 hashes are identical.

- [ ] **Step 5: Run focused live UI checks**

With a real cached paper containing at least one figure, table, and equation:

1. Regenerate the overview so guide-cache v3 content is produced without re-running MinerU.
2. Confirm an overview visual claim displays a type-aware index and jumps to the correct whole-object bbox.
3. Expand the section and confirm the close-reading claim displays the same index behavior.
4. Confirm the full visual cards remain visible once each at the section end.
5. Narrow the reader sidebar and confirm index chips wrap without overlap.
6. Save a Zotero Note and click its visual link.
7. Export Anki TSV and confirm it contains neither `[[ANCHOR:...]]` nor `zotero://open-pdf`.

- [ ] **Step 6: Clear all temporary diagnostics and verify a clean tree**

Verify:

```powershell
$prefs = 'C:\Users\pc\AppData\Roaming\Zotero\Zotero\Profiles\50uh9g9g.default\prefs.js'
Select-String -LiteralPath $prefs -Pattern 'extensions.zotero.debug-bridge.token'
git status --porcelain=v1
```

Expected: no debug-bridge token preference and no uncommitted repository changes.
