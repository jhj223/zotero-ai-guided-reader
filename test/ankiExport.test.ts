import assert from "node:assert/strict";
import test from "node:test";
import { buildAnkiTsv, exportAnkiTsv } from "../src/runtime/ankiExport";

test("builds an import-ready UTF-8 Anki TSV with named columns", () => {
  const output = buildAnkiTsv({
    title: "耐高温稠化酸体系",
    guideText: [
      "引言：稠化酸用于改善高温储层中的酸化施工效果。",
      "实验设计：作者通过流变测试证明体系在 180°C 仍保持稳定。",
    ].join("\n\n"),
  });

  assert.equal(output.cardCount, 2);
  assert.equal(output.fileName, "耐高温稠化酸体系-anki.tsv");
  assert.match(
    output.content,
    /^#separator:Tab\n#html:false\n#tags column:3\n#columns:Front\tBack\tTags\n/,
  );
  assert.match(output.content, /zotero-ai extension 耐高温稠化酸体系/);
  assert.match(output.content, /zotero-ai proof 耐高温稠化酸体系/);
});

test("exports untrusted guide content as plain text", () => {
  const output = buildAnkiTsv({
    title: "Paper",
    guideText:
      '第一行包含 <img src=x onerror="alert(1)">。\n第二行仍是同一张卡片。',
  });

  assert.match(output.content, /^#separator:Tab\n#html:false\n/);
  assert.doesNotMatch(output.content, /<br>/);
  assert.match(
    output.content,
    /第一行包含 <img src=x onerror="alert\(1\)">。 第二行/,
  );
});

test("rejects an empty Anki export instead of creating a header-only file", () => {
  assert.throws(
    () => buildAnkiTsv({ title: "Paper", guideText: "" }),
    /没有可导出的 Anki 卡片/,
  );
});

test("strips text and visual anchor placeholders from Anki cards", () => {
  const output = buildAnkiTsv({
    title: "Paper",
    guideText:
      "图表结果说明体系保持稳定。 [[ANCHOR:chunk_0001]] [[ANCHOR:figure_0001]]",
  });

  assert.doesNotMatch(output.content, /ANCHOR|zotero:\/\/open-pdf/);
  assert.match(output.content, /图表结果说明体系保持稳定/);
});

test("writes the Anki TSV to the path selected by the save dialog", async () => {
  const runtime = globalThis as unknown as Record<string, unknown>;
  const previousToolkit = runtime.ztoolkit;
  const previousIOUtils = runtime.IOUtils;
  let written: { path: string; content: string; tmpPath?: string } | undefined;

  runtime.ztoolkit = {
    FilePicker: class {
      open() {
        return Promise.resolve("C:\\Users\\pc\\Downloads\\paper-cards");
      }
    },
  };
  runtime.IOUtils = {
    writeUTF8(path: string, content: string, options?: { tmpPath?: string }) {
      written = { path, content, tmpPath: options?.tmpPath };
      return Promise.resolve();
    },
  };

  try {
    const outputPath = await exportAnkiTsv({
      title: "Paper",
      guideText: "作者证明该方法在高温条件下仍能保持稳定性能。",
    });
    assert.equal(outputPath, "C:\\Users\\pc\\Downloads\\paper-cards.tsv");
    assert.equal(written?.path, outputPath);
    assert.equal(written?.tmpPath, `${outputPath}.tmp`);
    assert.match(written?.content || "", /#columns:Front\tBack\tTags/);
  } finally {
    runtime.ztoolkit = previousToolkit;
    runtime.IOUtils = previousIOUtils;
  }
});
