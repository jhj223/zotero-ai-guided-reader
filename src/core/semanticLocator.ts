export interface SemanticWindow {
  text: string;
  startSegment: number;
  endSegment: number;
}

export interface SemanticSpanMatch extends SemanticWindow {
  score: number;
}

export type SemanticRanker = (
  query: string,
  documents: string[],
) => Promise<number[]>;

const MAX_WINDOW_SEGMENTS = 96;
const MIN_WINDOW_TEXT = 6;

export function buildSemanticWindows(segments: string[]): SemanticWindow[] {
  const windows: SemanticWindow[] = [];
  let start = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const currentLength = index - start + 1;
    const boundary = /[。！？!?；;\n\r]/u.test(segments[index] || "");
    if (boundary || currentLength >= MAX_WINDOW_SEGMENTS) {
      addWindow(windows, segments, start, index);
      start = index + 1;
    }
  }
  if (start < segments.length)
    addWindow(windows, segments, start, segments.length - 1);

  if (windows.length === 0 && segments.length > 0) {
    for (let offset = 0; offset < segments.length; offset += 64) {
      addWindow(
        windows,
        segments,
        offset,
        Math.min(segments.length - 1, offset + MAX_WINDOW_SEGMENTS - 1),
      );
    }
  }
  return windows.slice(0, 48);
}

export async function locateSemanticSpan(
  segments: string[],
  query: string,
  rank: SemanticRanker,
  options: { minScore?: number; minScoreGap?: number } = {},
): Promise<SemanticSpanMatch | undefined> {
  if (!query.trim()) return undefined;
  const windows = buildSemanticWindows(segments);
  if (windows.length === 0) return undefined;
  const scores = await rank(
    query,
    windows.map((window) => window.text),
  );
  const candidates = windows
    .map((window, index) => ({ ...window, score: scores[index] }))
    .filter((candidate): candidate is SemanticSpanMatch =>
      Number.isFinite(candidate.score),
    )
    .sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best || best.score < (options.minScore ?? 0.52)) return undefined;
  const runnerUp = candidates.find(
    (candidate) =>
      candidate !== best && segmentOverlapRatio(best, candidate) < 0.65,
  );
  if (
    runnerUp &&
    best.score - runnerUp.score < (options.minScoreGap ?? 0.035)
  ) {
    return undefined;
  }
  return { ...best, score: Number(best.score.toFixed(3)) };
}

function addWindow(
  windows: SemanticWindow[],
  segments: string[],
  startSegment: number,
  endSegment: number,
) {
  while (startSegment <= endSegment && !segments[startSegment]?.trim()) {
    startSegment += 1;
  }
  while (endSegment >= startSegment && !segments[endSegment]?.trim()) {
    endSegment -= 1;
  }
  if (endSegment < startSegment) return;
  const text = segments
    .slice(startSegment, endSegment + 1)
    .join("")
    .trim();
  if (text.length < MIN_WINDOW_TEXT) return;
  windows.push({ text, startSegment, endSegment });
}

function segmentOverlapRatio(
  left: Pick<SemanticWindow, "startSegment" | "endSegment">,
  right: Pick<SemanticWindow, "startSegment" | "endSegment">,
): number {
  const overlap = Math.max(
    0,
    Math.min(left.endSegment, right.endSegment) -
      Math.max(left.startSegment, right.startSegment) +
      1,
  );
  const shorter = Math.min(
    left.endSegment - left.startSegment + 1,
    right.endSegment - right.startSegment + 1,
  );
  return shorter > 0 ? overlap / shorter : 0;
}
