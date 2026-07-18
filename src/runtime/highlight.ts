import type { AnchorChunk } from "../core/types";
import { shouldTryTemporaryHighlight } from "./preferences";

interface OpenAnchorDeps {
  openReader(
    itemID: number,
    location: { pageIndex: number },
  ): Promise<unknown> | unknown;
  wantsHighlight(): boolean;
}

const defaults: OpenAnchorDeps = {
  // Navigating in-app avoids the external zotero:// protocol round trip,
  // which pops Firefox's "open this link with Zotero?" confirmation.
  openReader: (itemID, location) => Zotero.Reader.open(itemID, location),
  wantsHighlight: shouldTryTemporaryHighlight,
};

export async function openAnchor(
  input: {
    attachment: Zotero.Item;
    anchor: AnchorChunk;
  },
  overrides: Partial<OpenAnchorDeps> = {},
): Promise<void> {
  const deps = { ...defaults, ...overrides };
  await deps.openReader(input.attachment.id, {
    pageIndex: input.anchor.pageIndex,
  });

  if (deps.wantsHighlight() && input.anchor.bbox) {
    ztoolkit.log(
      "TODO experiment: wire Zotero Reader instance scroll/highlight API for transient bbox highlight.",
      {
        anchorId: input.anchor.id,
        pageIndex: input.anchor.pageIndex,
        bbox: input.anchor.bbox,
      },
    );
  }
}
