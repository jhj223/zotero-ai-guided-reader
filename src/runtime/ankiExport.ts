export async function exportAnkiTsv(input: {
  title: string;
  guideText: string;
}): Promise<string | undefined> {
  const document = buildAnkiTsv(input);
  const selectedPath = await new ztoolkit.FilePicker(
    "导出 Anki TSV",
    "save",
    [["Anki TSV (*.tsv)", "*.tsv"]],
    document.fileName,
  ).open();
  if (selectedPath === false) return undefined;

  const outputPath = selectedPath.toLowerCase().endsWith(".tsv")
    ? selectedPath
    : `${selectedPath}.tsv`;
  await IOUtils.writeUTF8(outputPath, document.content, {
    tmpPath: `${outputPath}.tmp`,
  });
  return outputPath;
}

export function buildAnkiTsv(input: { title: string; guideText: string }): {
  fileName: string;
  content: string;
  cardCount: number;
} {
  const rows = buildCards(input.title, input.guideText);
  if (!rows.length) {
    throw new Error("当前导读没有可导出的 Anki 卡片内容。");
  }

  const content = [
    "#separator:Tab",
    "#html:true",
    "#tags column:3",
    "#columns:Front\tBack\tTags",
    ...rows.map((row) => row.map(escapeTsv).join("\t")),
  ].join("\n");
  const safeTitle = input.title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 48);
  return {
    fileName: `${safeTitle || "paper"}-anki.tsv`,
    content,
    cardCount: rows.length,
  };
}

function buildCards(title: string, guideText: string): string[][] {
  const paragraphs = guideText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\[\[ANCHOR:[^\]]+\]\]/g, "").trim())
    .filter((paragraph) => paragraph.length > 6 && !paragraph.startsWith("#"))
    .filter((paragraph, index, values) => values.indexOf(paragraph) === index)
    .slice(0, 100);
  return paragraphs.map((paragraph, index) => {
    const kind = classify(paragraph);
    const front =
      kind === "definition"
        ? `这篇论文中的概念 ${index + 1} 是什么？`
        : kind === "proof"
          ? `这篇论文的论证步骤 ${index + 1} 如何成立？`
          : `这篇论文的关键观点 ${index + 1} 有什么应用或推广？`;
    return [front, paragraph, `zotero-ai ${kind} ${quoteTag(title)}`];
  });
}

function classify(text: string): "definition" | "proof" | "extension" {
  if (/定义|概念|称为|是什么/.test(text)) return "definition";
  if (/证明|推导|因此|假设|定理|公式/.test(text)) return "proof";
  return "extension";
}

function quoteTag(title: string): string {
  return title.replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_-]+/gu, "");
}

function escapeTsv(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
}
