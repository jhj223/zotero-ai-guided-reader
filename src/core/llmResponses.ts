import type { ReadingOutline } from "./types";

export function extractJsonObject<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ?? trimmed;

  try {
    return JSON.parse(candidate) as T;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    }
    throw new Error("LLM response did not contain a valid JSON object.");
  }
}

export function filterOutlineToKnownAnchors(
  outline: ReadingOutline,
  knownAnchorIds: Set<string>,
): ReadingOutline {
  return {
    ...outline,
    sections: outline.sections
      .map((section) => {
        const filteredSection: ReadingOutline["sections"][number] = {
          title: section.title,
          bullets: section.bullets
            .map((bullet) => ({
              ...bullet,
              anchorIds: bullet.anchorIds.filter((id) =>
                knownAnchorIds.has(id),
              ),
            }))
            .filter((bullet) => bullet.anchorIds.length > 0),
        };
        if (section.anchorIds) {
          filteredSection.anchorIds = section.anchorIds.filter((id) =>
            knownAnchorIds.has(id),
          );
        }
        return filteredSection;
      })
      .filter(
        (section) =>
          section.bullets.length > 0 || (section.anchorIds?.length ?? 0) > 0,
      ),
  };
}
