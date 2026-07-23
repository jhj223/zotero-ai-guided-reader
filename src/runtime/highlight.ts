import {
  anchorToPdfRect,
  type BBoxCoordinateSpace,
  type PdfRect,
} from "../core/anchorRect";
import {
  findApproximateQuoteInSegments,
  findQuotesInSegments,
} from "../core/textQuote";
import {
  locateSemanticSpan,
  type SemanticRanker,
} from "../core/semanticLocator";
import type { AnchorChunk, PageSize } from "../core/types";
import {
  readSemanticSettings,
  shouldTryTemporaryHighlight,
} from "./preferences";
import { SemanticClient } from "./semanticClient";

type ReaderLocation =
  | { pageIndex: number }
  | { position: { pageIndex: number; rects: PdfRect[] } };

type ReaderPosition = { pageIndex: number; rects: PdfRect[] };

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
  _highlightedPosition?: unknown;
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
    semanticQuery?: string,
  ): Promise<boolean>;
  highlightRect(
    openedReader: unknown,
    itemID: number,
    pageIndex: number,
    rect: PdfRect,
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
  highlightRect: highlightRectInReader,
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
    semanticQuery?: string;
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
  const semanticQuery = input.semanticQuery?.trim();
  if (quote || semanticQuery) {
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
            anchor.bboxSpace || "normalized-1000",
          )
        : undefined;
    if (
      await deps.highlightQuote(
        openedReader,
        input.attachment.id,
        anchor.pageIndex,
        quote || semanticQuery || "",
        expectedRect,
        semanticQuery,
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

  const rect = anchorToPdfRect(
    anchor.bbox,
    pageSize,
    anchor.bboxSpace || "normalized-1000",
  );
  if (
    await deps.highlightRect(
      openedReader,
      input.attachment.id,
      anchor.pageIndex,
      rect,
    )
  ) {
    return;
  }

  await deps.navigateReader(openedReader, input.attachment.id, {
    position: { pageIndex: anchor.pageIndex, rects: [rect] },
  });
}

export async function highlightQuoteInReader(
  openedReader: unknown,
  itemID: number,
  pageIndex: number,
  quote: string,
  expectedRect?: PdfRect,
  semanticQuery?: string,
  semanticRanker: SemanticRanker = rankSemanticCandidates,
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
      if (ranges.length === 0 && expectedRect) {
        const scoped = characterScopeForRect(chars, expectedRect);
        if (scoped) {
          const scopedCharacters = chars.slice(scoped.start, scoped.end);
          const approximate = findApproximateQuoteInSegments(
            scopedCharacters.map((character) => character.c || ""),
            quote,
            {
              minScore: 0.62,
              minScoreGap: 0.04,
            },
          );
          if (approximate) {
            const range = buildSelectionRange(
              chars,
              pageIndex,
              scoped.start + approximate.startSegment,
              scoped.start + approximate.endSegment + 1,
            );
            if (range) ranges.push(range);
          }
          if (ranges.length === 0 && semanticQuery) {
            try {
              const semantic = await locateSemanticSpan(
                scopedCharacters.map((character) => character.c || ""),
                semanticQuery,
                semanticRanker,
              );
              if (semantic) {
                const range = buildSelectionRange(
                  chars,
                  pageIndex,
                  scoped.start + semantic.startSegment,
                  scoped.start + semantic.endSegment + 1,
                );
                if (range) ranges.push(range);
              }
            } catch (error) {
              logSemanticHighlightError(pageIndex, error);
            }
          }
        }
      }
      const range = chooseClosestRange(ranges, expectedRect);
      if (!range || !view._iframeWindow || !view._render) return false;

      try {
        // TODO: These private fields were verified against Zotero 9.0.6 and
        // zotero/reader. Keep the bbox/page fallback for future API changes.
        return applyPersistentSelection(view, range);
      } catch (error) {
        logExactHighlightError(pageIndex, error);
        return false;
      }
    }
    await Zotero.Promise.delay(50);
  }
  return false;
}

async function rankSemanticCandidates(
  query: string,
  documents: string[],
): Promise<number[]> {
  const settings = readSemanticSettings();
  if (settings.provider === "none") return [];
  return new SemanticClient(settings).score(query, documents);
}

export async function highlightRectInReader(
  openedReader: unknown,
  itemID: number,
  pageIndex: number,
  rect: PdfRect,
): Promise<boolean> {
  if (typeof Zotero === "undefined") return false;
  let reader = asRuntimeReader(openedReader);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    reader ??= findReader(itemID);
    const view = reader?._internalReader?._lastView;
    const page = view?._pdfPages?.[pageIndex];
    if (view?._render && page) {
      try {
        const position = { pageIndex, rects: [roundRect(rect)] };
        view._selectionRanges = [];
        view._highlightedPosition = cloneIntoReader(position, view);
        view._render();
        view.navigateToPosition?.(position, { block: "center" });
        return true;
      } catch (error) {
        logRectHighlightError(pageIndex, error);
        return false;
      }
    }
    await Zotero.Promise.delay(50);
  }
  return false;
}

function applyPersistentSelection<T extends { position: ReaderPosition }>(
  view: RuntimePdfView,
  range: T,
): boolean {
  if (!view._iframeWindow || !view._render) return false;
  const selectionRanges = cloneIntoReader([range], view) as T[];
  view._highlightedPosition = undefined;
  view._selectionRanges = selectionRanges;
  view._render();
  view.navigateToPosition?.(selectionRanges[0].position, { block: "center" });
  return true;
}

function cloneIntoReader<T>(value: T, view: RuntimePdfView): T {
  if (!view._iframeWindow || typeof Components === "undefined") return value;
  return Components.utils.cloneInto(value, view._iframeWindow) as T;
}

function characterScopeForRect(
  chars: RuntimePdfChar[],
  rect: PdfRect,
): { start: number; end: number } | undefined {
  const padding = 2;
  const expanded: PdfRect = [
    rect[0] - padding,
    rect[1] - padding,
    rect[2] + padding,
    rect[3] + padding,
  ];
  let start = -1;
  let end = -1;
  chars.forEach((character, index) => {
    const charRect =
      asPdfRect(character.inlineRect) || asPdfRect(character.rect);
    if (!charRect || !rectsOverlap(charRect, expanded)) return;
    if (start < 0) start = index;
    end = index + 1;
  });
  return start >= 0 && end > start ? { start, end } : undefined;
}

function rectsOverlap(left: PdfRect, right: PdfRect): boolean {
  return !(
    left[2] < right[0] ||
    left[0] > right[2] ||
    left[3] < right[1] ||
    left[1] > right[3]
  );
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

function logRectHighlightError(pageIndex: number, error: unknown): void {
  if (typeof ztoolkit === "undefined") return;
  ztoolkit.log("Persistent anchor rect highlight failed", {
    pageIndex,
    reason: String(error),
  });
}

function logSemanticHighlightError(pageIndex: number, error: unknown): void {
  if (typeof ztoolkit === "undefined") return;
  ztoolkit.log("Optional semantic anchor matching failed", {
    pageIndex,
    reason: error instanceof Error ? "SemanticProviderError" : "UnknownError",
  });
}
