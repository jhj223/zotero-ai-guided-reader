export type MathTextSegment =
  | { type: "text"; value: string }
  | { type: "math"; value: string; display: boolean };

export function splitMathText(value: string): MathTextSegment[] {
  const segments: MathTextSegment[] = [];
  let text = "";
  let index = 0;

  const flushText = () => {
    if (!text) return;
    const previous = segments.at(-1);
    if (previous?.type === "text") previous.value += text;
    else segments.push({ type: "text", value: text });
    text = "";
  };

  while (index < value.length) {
    if (value.startsWith("\\$", index)) {
      text += "$";
      index += 2;
      continue;
    }

    const opening = readOpeningDelimiter(value, index);
    if (!opening) {
      text += value[index];
      index += 1;
      continue;
    }

    const closeIndex = value.indexOf(
      opening.close,
      index + opening.open.length,
    );
    if (closeIndex < 0) {
      text += value.slice(index);
      break;
    }

    flushText();
    segments.push({
      type: "math",
      value: value.slice(index + opening.open.length, closeIndex).trim(),
      display: opening.display,
    });
    index = closeIndex + opening.close.length;
  }

  flushText();
  return segments;
}

function readOpeningDelimiter(value: string, index: number) {
  if (value.startsWith("$$", index)) {
    return { open: "$$", close: "$$", display: true };
  }
  if (value.startsWith("\\[", index)) {
    return { open: "\\[", close: "\\]", display: true };
  }
  if (value.startsWith("\\(", index)) {
    return { open: "\\(", close: "\\)", display: false };
  }
  if (value[index] === "$") {
    return { open: "$", close: "$", display: false };
  }
  return undefined;
}
