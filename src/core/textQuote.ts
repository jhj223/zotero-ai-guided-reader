const MIN_NORMALIZED_QUOTE_LENGTH = 8;

export interface QuoteSegmentMatch {
  startSegment: number;
  endSegment: number;
}

export function normalizeForQuoteMatch(value: string): string {
  let normalized = "";
  for (const character of value.normalize("NFKC").toLocaleLowerCase()) {
    if (/^[\p{L}\p{N}]$/u.test(character)) normalized += character;
  }
  return normalized;
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

export function quoteMatchesSource(source: string, quote: string): boolean {
  const normalizedQuote = normalizeForQuoteMatch(quote);
  return (
    normalizedQuote.length >= MIN_NORMALIZED_QUOTE_LENGTH &&
    normalizeForQuoteMatch(source).includes(normalizedQuote)
  );
}
