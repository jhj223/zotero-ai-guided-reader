import { buildZoteroOpenPdfLink } from "../core/anchorMarkup";
import type { AnchorChunk } from "../core/types";
import { shouldTryTemporaryHighlight } from "./preferences";
import { getOpenPdfLibraryTarget } from "./zoteroLinks";

export function openAnchor(input: {
  attachment: Zotero.Item;
  anchor: AnchorChunk;
}): void {
  const link = buildZoteroOpenPdfLink({
    attachmentKey: input.attachment.key,
    pageIndex: input.anchor.pageIndex,
    ...getOpenPdfLibraryTarget(input.attachment),
  });
  Zotero.launchURL(link);

  if (shouldTryTemporaryHighlight() && input.anchor.bbox) {
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
