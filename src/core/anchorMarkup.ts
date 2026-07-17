export type AnchorTextSegment = { type: "text"; text: string };
export type AnchorReferenceSegment = { type: "anchor"; anchorId: string };
export type AnchorSegment = AnchorTextSegment | AnchorReferenceSegment;

const ANCHOR_PATTERN = /\[\[ANCHOR:([a-zA-Z0-9_-]+)\]\]/g;

export function parseAnchorPlaceholders(text: string): AnchorSegment[] {
  const segments: AnchorSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(ANCHOR_PATTERN)) {
    const [placeholder, anchorId] = match;
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, start) });
    }
    segments.push({ type: "anchor", anchorId });
    lastIndex = start + placeholder.length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", text: text.slice(lastIndex) });
  }

  return segments;
}

export function buildZoteroOpenPdfLink(input: {
  attachmentKey: string;
  pageIndex: number;
  libraryType: "library" | "group";
  groupID?: number | string;
}): string {
  const pageNumber = Math.max(1, Math.floor(input.pageIndex) + 1);
  const key = encodeURIComponent(input.attachmentKey);

  if (input.libraryType === "group") {
    if (!input.groupID) {
      throw new Error("groupID is required for group library open-pdf links");
    }
    return `zotero://open-pdf/groups/${encodeURIComponent(
      String(input.groupID),
    )}/items/${key}?page=${pageNumber}`;
  }

  return `zotero://open-pdf/library/items/${key}?page=${pageNumber}`;
}
