import {
  parseAnchorPlaceholders,
  buildZoteroOpenPdfLink,
} from "../core/anchorMarkup";
import type { AnchorChunk } from "../core/types";
import { isVisualAnchor, visualEvidenceLabel } from "../core/visualEvidence";
import { getOpenPdfLibraryTarget } from "./zoteroLinks";

export async function saveGuideAsNote(input: {
  attachment: Zotero.Item;
  parentItem: Zotero.Item;
  title: string;
  markdown: string;
  anchors: AnchorChunk[];
}): Promise<Zotero.Item> {
  const note = new Zotero.Item("note");
  note.libraryID = input.parentItem.libraryID;
  note.parentID = input.parentItem.id;
  note.setNote(renderNoteHtml(input));
  await note.saveTx();
  return note;
}

function renderNoteHtml(input: {
  attachment: Zotero.Item;
  title: string;
  markdown: string;
  anchors: AnchorChunk[];
}): string {
  const anchorsById = new Map(
    input.anchors.map((anchor) => [anchor.id, anchor]),
  );
  const lines = input.markdown.split(/\n{2,}/).map((paragraph) => {
    const html = parseAnchorPlaceholders(paragraph)
      .map((segment) => {
        if (segment.type === "text") return escapeHtml(segment.text);
        const anchor = anchorsById.get(segment.anchorId);
        if (!anchor) return "";
        const href = buildZoteroOpenPdfLink({
          attachmentKey: input.attachment.key,
          pageIndex: anchor.pageIndex,
          ...getOpenPdfLibraryTarget(input.attachment),
        });
        const label = isVisualAnchor(anchor)
          ? `${visualEvidenceLabel(anchor)} · p.${anchor.pageNumber}`
          : `p.${anchor.pageNumber}`;
        return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
      })
      .join("");
    return `<p>${html}</p>`;
  });
  return `<h1>${escapeHtml(input.title)}</h1>${lines.join("")}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
