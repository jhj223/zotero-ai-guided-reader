import type { AnchorChunk } from "../core/types";
import { PluginCache } from "./cache";

export async function exportAnkiTsv(input: {
  title: string;
  guideText: string;
  anchors: AnchorChunk[];
}): Promise<string> {
  const rows = buildCards(input.title, input.guideText);
  const tsv = [
    "Front\tBack\tTags",
    ...rows.map((row) => row.map(escapeTsv).join("\t")),
  ].join("\n");
  const safeTitle = input.title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 48);
  return new PluginCache().writeTextFile(
    `${safeTitle || "paper"}-anki.tsv`,
    tsv,
  );
}

function buildCards(title: string, guideText: string): string[][] {
  const paragraphs = guideText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\[\[ANCHOR:[^\]]+\]\]/g, "").trim())
    .filter((paragraph) => paragraph.length > 20)
    .slice(0, 40);

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
