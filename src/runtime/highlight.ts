import {
  anchorToPdfRect,
  type BBoxCoordinateSpace,
  type PdfRect,
} from "../core/anchorRect";
import { findQuotesInSegments } from "../core/textQuote";
import type { AnchorChunk, PageSize } from "../core/types";
import { shouldTryTemporaryHighlight } from "./preferences";

type ReaderLocation =
  | { pageIndex: number }
  | { position: { pageIndex: number; rects: PdfRect[] } };

interface RuntimePdfChar {
  c?: string;
  rect?: unknown;
  inlineRect?: unknown;
  ignorable?: boolean;
  lineBreakAfter?: boolean;
  paragraphBreakAfter?: boolean;
  spaceAfter?: boolean;
}

interface RuntimePdfView {
  _iframeWindow?: Window & {
    PDFViewerApplication?: {
      pdfDocument?: {
        getPage?: (pageNumber: number) => Promise<{ view?: unknown }>;
      };
      pdfViewer?: {
        _pages?: Array<{ viewport?: { viewBox?: unknown } }>;
      };
    };
  };
  _pdfPages?: Array<{ chars?: RuntimePdfChar[] }>;
  _selectionRanges?: unknown[];
  _render?: () => void;
  navigateToPosition?: (
    position: { pageIndex: number; rects: PdfRect[] },
    options?: { block?: string },
  ) => void;
}

interface RuntimeReader {
  itemID?: number;
  navigate?: (location: ReaderLocation) => Promise<unknown> | unknown;
  _internalReader?: { _lastView?: RuntimePdfView };
}

interface OpenAnchorDeps {
  openReader(
    itemID: number,
    location: ReaderLocation,
  ): Promise<unknown> | unknown;
  highlightQuote(
    openedReader: unknown,
    itemID: number,
    pageIndex: number,
    quote: string,
    expectedRect?: PdfRect,
  ): Promise<boolean>;
  resolvePageSize(
    itemID: number,
    pageIndex: number,
    openedReader: unknown,
  ): Promise<PageSize | undefined>;
  navigateReader(
    openedReader: unknown,
    itemID: number,
    location: ReaderLocation,
  ): Promise<unknown> | unknown;
  wantsHighlight(): boolean;
}

const defaults: OpenAnchorDeps = {
  openReader: (itemID, location) => Zotero.Reader.open(itemID, location),
  highlightQuote: highlightQuoteInReader,
  resolvePageSize: resolvePageSizeFromReader,
  navigateReader: navigateOpenReader,
  wantsHighlight: shouldTryTemporaryHighlight,
};

export async function openAnchor(
  input: {
    attachment: Zotero.Item;
    anchor: AnchorChunk;
    pageSize?: PageSize;
    quote?: string;
  },
  overrides: Partial<OpenAnchorDeps> = {},
): Promise<void> {
  const deps = { ...defaults, ...overrides };
  const { anchor } = input;
  const pageLocation = { pageIndex: anchor.pageIndex } as const;

  if (!deps.wantsHighlight()) {
    await deps.openReader(input.attachment.id, pageLocation);
    return;
  }

  let openedReader: unknown;
  let resolvedPageSize = input.pageSize;
  const quote = input.quote?.trim();
  if (quote) {
    openedReader = await deps.openReader(input.attachment.id, pageLocation);
    if (anchor.bbox && !resolvedPageSize) {
      resolvedPageSize = await deps.resolvePageSize(
        input.attachment.id,
        anchor.pageIndex,
        openedReader,
      );
    }
    const expectedRect =
      anchor.bbox && resolvedPageSize
        ? anchorToPdfRect(
            anchor.bbox,
            resolvedPageSize,
            input.pageSize ? "auto" : "normalized-1000",
          )
        : undefined;
    if (
      await deps.highlightQuote(
        openedReader,
        input.attachment.id,
        anchor.pageIndex,
        quote,
        expectedRect,
      )
    ) {
      return;
    }
    logHighlightFallback(anchor, "exact-quote-not-found");
  }

  if (!anchor.bbox) {
    if (!quote) await deps.openReader(input.attachment.id, pageLocation);
    return;
  }

  if (input.pageSize) {
    const location = positionLocation(
      anchor.pageIndex,
      anchor.bbox,
      input.pageSize,
    );
    if (quote) {
      await deps.navigateReader(openedReader, input.attachment.id, location);
    } else {
      await deps.openReader(input.attachment.id, location);
    }
    return;
  }

  openedReader ??= await deps.openReader(input.attachment.id, pageLocation);
  const pageSize =
    resolvedPageSize ||
    (await deps.resolvePageSize(
      input.attachment.id,
      anchor.pageIndex,
      openedReader,
    ));
  if (!pageSize) {
    logHighlightFallback(anchor, "reader-page-size-unavailable");
    return;
  }

  await deps.navigateReader(
    openedReader,
    input.attachment.id,
    positionLocation(
      anchor.pageIndex,
      anchor.bbox,
      pageSize,
      "normalized-1000",
    ),
  );
}

export async function highlightQuoteInReader(
  openedReader: unknown,
  itemID: number,
  pageIndex: number,
  quote: string,
  expectedRect?: PdfRect,
): Promise<boolean> {
  let reader = asRuntimeReader(openedReader);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    reader ??= findReader(itemID);
    const view = reader?._internalReader?._lastView;
    const chars = view?._pdfPages?.[pageIndex]?.chars;
    if (chars?.length && view) {
      const matches = findQuotesInSegments(
        chars.map((character) => character.c || ""),
        quote,
      );
      const ranges = matches
        .map((match) =>
          buildSelectionRange(
            chars,
            pageIndex,
            match.startSegment,
            match.endSegment + 1,
          ),
        )
        .filter((range): range is NonNullable<typeof range> => Boolean(range));
      const range = chooseClosestRange(ranges, expectedRect);
      if (!range || !view._iframeWindow || !view._render) return false;

      try {
        // TODO: These private fields were verified against Zotero 9.0.6 and
        // zotero/reader. Keep the bbox/page fallback for future API changes.
        const selectionRanges = Components.utils.cloneInto(
          [range],
          view._iframeWindow,
        ) as (typeof range)[];
        view._selectionRanges = selectionRanges;
        view._render();
        view.navigateToPosition?.(selectionRanges[0].position, {
          block: "center",
        });
        return true;
      } catch (error) {
        logExactHighlightError(pageIndex, error);
        return false;
      }
    }
    await Zotero.Promise.delay(50);
  }
  return false;
}

function chooseClosestRange<T extends { position: { rects: PdfRect[] } }>(
  ranges: T[],
  expectedRect?: PdfRect,
): T | undefined {
  if (!expectedRect || ranges.length < 2) return ranges[0];
  return ranges.reduce((closest, candidate) =>
    rectDistance(candidate.position.rects, expectedRect) <
    rectDistance(closest.position.rects, expectedRect)
      ? candidate
      : closest,
  );
}

function rectDistance(rects: PdfRect[], expectedRect: PdfRect): number {
  const centerX = (expectedRect[0] + expectedRect[2]) / 2;
  const centerY = (expectedRect[1] + expectedRect[3]) / 2;
  return Math.min(
    ...rects.map((rect) => {
      const x = (rect[0] + rect[2]) / 2;
      const y = (rect[1] + rect[3]) / 2;
      return (x - centerX) ** 2 + (y - centerY) ** 2;
    }),
  );
}

function buildSelectionRange(
  chars: RuntimePdfChar[],
  pageIndex: number,
  anchorOffset: number,
  headOffset: number,
) {
  const selectedChars = chars.slice(anchorOffset, headOffset);
  const rects: PdfRect[] = [];
  let currentRect: PdfRect | undefined;

  for (const character of selectedChars) {
    const inlineRect = asPdfRect(character.inlineRect);
    if (!inlineRect) return undefined;
    currentRect ??= [...inlineRect];
    currentRect = [
      Math.min(currentRect[0], inlineRect[0]),
      Math.min(currentRect[1], inlineRect[1]),
      Math.max(currentRect[2], inlineRect[2]),
      Math.max(currentRect[3], inlineRect[3]),
    ];
    if (character.lineBreakAfter) {
      rects.push(roundRect(currentRect));
      currentRect = undefined;
    }
  }
  if (currentRect) rects.push(roundRect(currentRect));
  if (rects.length === 0) return undefined;

  const text = selectedChars
    .map((character) => {
      if (character.ignorable) return "";
      const separator =
        character.spaceAfter ||
        character.lineBreakAfter ||
        character.paragraphBreakAfter
          ? " "
          : "";
      return `${character.c || ""}${separator}`;
    })
    .join("")
    .trim();
  const position = { pageIndex, rects };
  return {
    pageIndex,
    anchorOffset,
    headOffset,
    collapsed: false,
    anchor: true,
    head: true,
    text,
    position,
  };
}

function positionLocation(
  pageIndex: number,
  bbox: NonNullable<AnchorChunk["bbox"]>,
  pageSize: PageSize,
  coordinateSpace: BBoxCoordinateSpace = "auto",
): ReaderLocation {
  return {
    position: {
      pageIndex,
      rects: [anchorToPdfRect(bbox, pageSize, coordinateSpace)],
    },
  };
}

async function resolvePageSizeFromReader(
  itemID: number,
  pageIndex: number,
  openedReader: unknown,
): Promise<PageSize | undefined> {
  let reader = asRuntimeReader(openedReader);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    reader ??= findReader(itemID);
    const size = reader ? await readPageSize(reader, pageIndex) : undefined;
    if (size) return size;
    await Zotero.Promise.delay(50);
  }
  return undefined;
}

async function readPageSize(
  reader: RuntimeReader,
  pageIndex: number,
): Promise<PageSize | undefined> {
  const application =
    reader._internalReader?._lastView?._iframeWindow?.PDFViewerApplication;
  const getPage = application?.pdfDocument?.getPage;

  if (getPage) {
    try {
      const page = await getPage.call(application.pdfDocument, pageIndex + 1);
      const size = pageSizeFromBox(page.view);
      if (size) return size;
    } catch {
      // The document can still be initializing; the bounded caller retries.
    }
  }

  return pageSizeFromBox(
    application?.pdfViewer?._pages?.[pageIndex]?.viewport?.viewBox,
  );
}

function pageSizeFromBox(value: unknown): PageSize | undefined {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const box = value.slice(0, 4).map(Number);
  if (box.some((coordinate) => !Number.isFinite(coordinate))) return undefined;
  const width = Math.abs(box[2] - box[0]);
  const height = Math.abs(box[3] - box[1]);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

async function navigateOpenReader(
  openedReader: unknown,
  itemID: number,
  location: ReaderLocation,
): Promise<unknown> {
  const reader = asRuntimeReader(openedReader) ?? findReader(itemID);
  if (reader?.navigate) return reader.navigate(location);
  return Zotero.Reader.open(itemID, location);
}

function findReader(itemID: number): RuntimeReader | undefined {
  const readers = (Zotero.Reader as unknown as { _readers?: RuntimeReader[] })
    ._readers;
  return readers?.find((reader) => reader.itemID === itemID);
}

function asRuntimeReader(value: unknown): RuntimeReader | undefined {
  return value && typeof value === "object"
    ? (value as RuntimeReader)
    : undefined;
}

function asPdfRect(value: unknown): PdfRect | undefined {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const rect = value.slice(0, 4).map(Number);
  return rect.every(Number.isFinite) ? (rect as PdfRect) : undefined;
}

function roundRect(rect: PdfRect): PdfRect {
  return rect.map((value) => Number(value.toFixed(3))) as PdfRect;
}

function logHighlightFallback(anchor: AnchorChunk, reason: string): void {
  if (typeof ztoolkit === "undefined") return;
  ztoolkit.log("Anchor highlight used a degraded fallback", {
    anchorId: anchor.id,
    pageIndex: anchor.pageIndex,
    reason,
  });
}

function logExactHighlightError(pageIndex: number, error: unknown): void {
  if (typeof ztoolkit === "undefined") return;
  ztoolkit.log("Exact quote highlight failed", {
    pageIndex,
    reason: String(error),
  });
}
