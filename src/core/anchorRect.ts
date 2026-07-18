import type { BBox, PageSize } from "./types";

export type PdfRect = [number, number, number, number];

/**
 * Convert a MinerU bbox (origin top-left) into a Zotero reader rect
 * (PDF points, origin bottom-left, [left, bottom, right, top]).
 *
 * MinerU's pipeline backend emits bboxes in the same point units as
 * middle.json's page_size; the vlm backend emits them on a 0-1000 grid.
 * A bbox that exceeds the page dimensions is treated as normalized.
 */
export function anchorToPdfRect(bbox: BBox, pageSize: PageSize): PdfRect {
  const [x0, y0, x1, y1] = bbox.map(Number);
  const normalized =
    Math.max(x0, x1) > pageSize.width * 1.01 ||
    Math.max(y0, y1) > pageSize.height * 1.01;
  const sx = normalized ? pageSize.width / 1000 : 1;
  const sy = normalized ? pageSize.height / 1000 : 1;
  const left = Math.min(x0, x1) * sx;
  const right = Math.max(x0, x1) * sx;
  const top = Math.min(y0, y1) * sy;
  const bottom = Math.max(y0, y1) * sy;
  return [left, pageSize.height - bottom, right, pageSize.height - top];
}
