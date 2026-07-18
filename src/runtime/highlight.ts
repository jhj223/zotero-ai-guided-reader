import { anchorToPdfRect, type PdfRect } from "../core/anchorRect";
import type { AnchorChunk, PageSize } from "../core/types";
import { shouldTryTemporaryHighlight } from "./preferences";

type ReaderLocation =
  | { pageIndex: number }
  | { position: { pageIndex: number; rects: PdfRect[] } };

interface OpenAnchorDeps {
  openReader(
    itemID: number,
    location: ReaderLocation,
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
    pageSize?: PageSize;
  },
  overrides: Partial<OpenAnchorDeps> = {},
): Promise<void> {
  const deps = { ...defaults, ...overrides };
  const { anchor } = input;

  // With a rect position the reader scrolls to the block and flashes the
  // built-in blink highlight - the same mechanism annotation links use.
  const location: ReaderLocation =
    deps.wantsHighlight() && anchor.bbox && input.pageSize
      ? {
          position: {
            pageIndex: anchor.pageIndex,
            rects: [anchorToPdfRect(anchor.bbox, input.pageSize)],
          },
        }
      : { pageIndex: anchor.pageIndex };

  await deps.openReader(input.attachment.id, location);
}
