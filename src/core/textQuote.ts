const MIN_NORMALIZED_QUOTE_LENGTH = 8;

export interface QuoteSegmentMatch {
  startSegment: number;
  endSegment: number;
}

export interface ApproximateQuoteSegmentMatch extends QuoteSegmentMatch {
  score: number;
}

interface ApproximateQuoteOptions {
  minScore?: number;
  minScoreGap?: number;
  minExactRun?: number;
  maxNeedleLength?: number;
  maxHaystackLength?: number;
}

export function normalizeForQuoteMatch(value: string): string {
  let normalized = "";
  for (const character of toVisibleSourceText(value)
    .normalize("NFKC")
    .toLocaleLowerCase()) {
    if (/^[\p{L}\p{N}]$/u.test(character)) normalized += character;
  }
  return normalized;
}

export function toVisibleSourceText(value: string): string {
  const greek: Record<string, string> = {
    alpha: "α",
    beta: "β",
    gamma: "γ",
    delta: "δ",
    epsilon: "ε",
    theta: "θ",
    lambda: "λ",
    mu: "μ",
    nu: "ν",
    pi: "π",
    rho: "ρ",
    sigma: "σ",
    tau: "τ",
    phi: "φ",
    psi: "ψ",
    omega: "ω",
  };

  return decodeHtmlEntities(value)
    .replace(/<[^>]*>/g, "")
    .replace(/\\tag\s*\{([^{}]*)\}/g, "($1)")
    .replace(/\\(?:left|right)\b\s*/g, "")
    .replace(
      /\\(?:mathrm|mathbf|mathit|mathsf|mathtt|mathfrak|operatorname|text)\b\s*/g,
      "",
    )
    .replace(/\\([A-Za-z]+)\b/g, (_match, command: string) => {
      if (command in greek) return greek[command];
      if (["cdot", "bullet", "times", "quad", "qquad"].includes(command)) {
        return " ";
      }
      return "";
    })
    .replace(/\\([%&#_$])/g, "$1")
    .replace(/\\[,;!:\\]/g, " ")
    .replace(/\${1,2}/g, "")
    .replace(/\{\{([^{}]*)\}\}/g, "{$1}");
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (entity, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        return safeCodePoint(Number.parseInt(body.slice(2), 16), entity);
      }
      if (body.startsWith("#")) {
        return safeCodePoint(Number.parseInt(body.slice(1), 10), entity);
      }
      return named[body.toLocaleLowerCase()] ?? entity;
    },
  );
}

function safeCodePoint(value: number, fallback: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) {
    return fallback;
  }
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}

export function findQuoteInSegments(
  segments: string[],
  quote: string,
): QuoteSegmentMatch | undefined {
  return findQuotesInSegments(segments, quote)[0];
}

export function findQuotesInSegments(
  segments: string[],
  quote: string,
): QuoteSegmentMatch[] {
  const needle = normalizeForQuoteMatch(quote);
  if (needle.length < MIN_NORMALIZED_QUOTE_LENGTH) return [];

  let haystack = "";
  const segmentByOffset: number[] = [];
  segments.forEach((segment, segmentIndex) => {
    const part = normalizeForQuoteMatch(segment);
    haystack += part;
    for (let offset = 0; offset < part.length; offset += 1) {
      segmentByOffset.push(segmentIndex);
    }
  });

  const matches: QuoteSegmentMatch[] = [];
  let start = haystack.indexOf(needle);
  while (start >= 0) {
    matches.push({
      startSegment: segmentByOffset[start],
      endSegment: segmentByOffset[start + needle.length - 1],
    });
    start = haystack.indexOf(needle, start + 1);
  }
  return matches;
}

export function findApproximateQuoteInSegments(
  segments: string[],
  quote: string,
  options: ApproximateQuoteOptions = {},
): ApproximateQuoteSegmentMatch | undefined {
  const needle = normalizeForQuoteMatch(quote);
  const maxNeedleLength = options.maxNeedleLength ?? 500;
  const maxHaystackLength = options.maxHaystackLength ?? 4000;
  if (
    needle.length < MIN_NORMALIZED_QUOTE_LENGTH ||
    needle.length > maxNeedleLength
  ) {
    return undefined;
  }

  const { text: haystack, segmentByOffset } = flattenSegments(segments);
  if (!haystack || haystack.length > maxHaystackLength) return undefined;

  const previousCosts = new Uint16Array(haystack.length + 1);
  const currentCosts = new Uint16Array(haystack.length + 1);
  const previousStarts = new Int32Array(haystack.length + 1);
  const currentStarts = new Int32Array(haystack.length + 1);
  for (let offset = 0; offset <= haystack.length; offset += 1) {
    previousStarts[offset] = offset;
  }

  for (let needleOffset = 1; needleOffset <= needle.length; needleOffset += 1) {
    currentCosts[0] = needleOffset;
    currentStarts[0] = 0;
    for (
      let haystackOffset = 1;
      haystackOffset <= haystack.length;
      haystackOffset += 1
    ) {
      let cost =
        previousCosts[haystackOffset - 1] +
        (needle[needleOffset - 1] === haystack[haystackOffset - 1] ? 0 : 1);
      let start = previousStarts[haystackOffset - 1];

      const deletedNeedle = previousCosts[haystackOffset] + 1;
      if (deletedNeedle < cost) {
        cost = deletedNeedle;
        start = previousStarts[haystackOffset];
      }

      const insertedHaystack = currentCosts[haystackOffset - 1] + 1;
      if (insertedHaystack < cost) {
        cost = insertedHaystack;
        start = currentStarts[haystackOffset - 1];
      }

      currentCosts[haystackOffset] = cost;
      currentStarts[haystackOffset] = start;
    }
    previousCosts.set(currentCosts);
    previousStarts.set(currentStarts);
  }

  const minScore = options.minScore ?? 0.82;
  const candidates: Array<{
    start: number;
    end: number;
    score: number;
  }> = [];
  for (let end = 1; end <= haystack.length; end += 1) {
    const start = previousStarts[end];
    if (start < 0 || start >= end) continue;
    const comparedLength = Math.max(needle.length, end - start);
    const score = 1 - previousCosts[end] / comparedLength;
    if (score >= minScore) candidates.push({ start, end, score });
  }
  candidates.sort((left, right) => right.score - left.score);

  const distinct: typeof candidates = [];
  for (const candidate of candidates) {
    if (distinct.some((existing) => overlapRatio(existing, candidate) >= 0.8)) {
      continue;
    }
    distinct.push(candidate);
  }

  const best = distinct[0];
  if (!best) return undefined;
  const runnerUp = distinct[1];
  if (runnerUp && best.score - runnerUp.score < (options.minScoreGap ?? 0.04)) {
    return undefined;
  }
  const candidateText = haystack.slice(best.start, best.end);
  const minExactRun =
    options.minExactRun ??
    Math.min(8, Math.max(4, Math.floor(needle.length / 4)));
  if (longestCommonRun(needle, candidateText) < minExactRun) return undefined;

  return {
    startSegment: segmentByOffset[best.start],
    endSegment: segmentByOffset[best.end - 1],
    score: Number(best.score.toFixed(3)),
  };
}

function longestCommonRun(left: string, right: string): number {
  const previous = new Uint16Array(right.length + 1);
  const current = new Uint16Array(right.length + 1);
  let longest = 0;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current.fill(0);
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] !== right[rightIndex - 1]) continue;
      current[rightIndex] = previous[rightIndex - 1] + 1;
      longest = Math.max(longest, current[rightIndex]);
    }
    previous.set(current);
  }
  return longest;
}

function flattenSegments(segments: string[]): {
  text: string;
  segmentByOffset: number[];
} {
  let text = "";
  const segmentByOffset: number[] = [];
  segments.forEach((segment, segmentIndex) => {
    const part = normalizeForQuoteMatch(segment);
    text += part;
    for (let offset = 0; offset < part.length; offset += 1) {
      segmentByOffset.push(segmentIndex);
    }
  });
  return { text, segmentByOffset };
}

function overlapRatio(
  left: { start: number; end: number },
  right: { start: number; end: number },
): number {
  const overlap = Math.max(
    0,
    Math.min(left.end, right.end) - Math.max(left.start, right.start),
  );
  return overlap / Math.min(left.end - left.start, right.end - right.start);
}

export function quoteMatchesSource(source: string, quote: string): boolean {
  const normalizedQuote = normalizeForQuoteMatch(quote);
  return (
    normalizedQuote.length >= MIN_NORMALIZED_QUOTE_LENGTH &&
    normalizeForQuoteMatch(source).includes(normalizedQuote)
  );
}
