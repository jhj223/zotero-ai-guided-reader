export type MathTextSegment =
  | { type: "text"; value: string }
  | { type: "math"; value: string; display: boolean };

const SUPERSCRIPT_CHARACTERS: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
};

const SUBSCRIPT_CHARACTERS: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
};

export function stripLatexToText(value: string): string {
  let text = value.replace(/\r?\n/g, " ");

  for (let pass = 0; pass < 12; pass += 1) {
    const previous = text;
    text = text
      .replace(/\\textcircled\s*~?\s*\{\s*~?\s*C\s*~?\s*\}/gi, "°C")
      .replace(/\^\s*\{\s*\\circ\s*\}/g, "°")
      .replace(/_\s*\{\s*~?\s*(?:c|\\odot|\\circ)\s*~?\s*\}/gi, "")
      .replace(/_\s*\{\s*([+\-\d\s]+)\s*\}/g, (_match, body: string) =>
        convertScript(body, SUBSCRIPT_CHARACTERS),
      )
      .replace(/\^\s*\{\s*([+\-\d\s]+)\s*\}/g, (_match, body: string) =>
        convertScript(body, SUPERSCRIPT_CHARACTERS),
      )
      .replace(
        /\\(?:mathrm|textrm|mathbf|mathit|mathsf|mathtt|operatorname|text|smash|textcircled)\s*~?\s*\{([^{}]*)\}/g,
        "$1",
      );
    if (text === previous) break;
  }

  text = text
    .replace(/\\(?:left|right)\b\s*/g, "")
    .replace(/\\cdot\b/g, "·")
    .replace(/\\times\b/g, "×")
    .replace(/\\circ\b/g, "°")
    .replace(/\\(?:odot|quad|qquad)\b/g, " ")
    .replace(/\\Omega\b/g, "Ω")
    .replace(/\\mu\b/g, "μ")
    .replace(/(?<!\\)\${1,2}/g, "")
    .replace(/\\([%&#_$])/g, "$1")
    .replace(/\\(?:\[|\]|\(|\))/g, "")
    .replace(/\\[A-Za-z]+\b/g, " ")
    .replace(/\\[,;:!\\]/g, " ")
    .replace(/\\/g, " ")
    .replace(/[_^]\s*\{\s*([^{}]*)\s*\}/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/[_^]/g, "");

  text = text
    .replace(/(?<=\d)\s*\.\s*(?=\d)/g, ".")
    .replace(/(?<=\d)\s+(?=\d)/g, "")
    .replace(/\b([A-Z]{1,5}\d+)\s*~\s*([A-Z]{1,5}\d+)\b/g, "$1–$2")
    .replace(/\b(\d+(?:\.\d+)?)\s*~\s*(\d+(?:\.\d+)?)\b/g, "$1–$2")
    .replace(/~/g, " ")
    .replace(/\b[A-Za-z](?:\s+[A-Za-z])+\b/g, (letters) =>
      letters.replace(/\s+/g, ""),
    )
    .replace(/\s+([⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻₀₁₂₃₄₅₆₇₈₉₊₋])/g, "$1")
    .replace(/°\s+C\b/g, "°C")
    .replace(/(\d)\s+°C\b/g, "$1°C")
    .replace(/\s*([·×/])\s*/g, "$1")
    .replace(/([([])\s+/g, "$1")
    .replace(/\s+([)\]])/g, "$1")
    .replace(/\s+([,.;:，。；：])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

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

function convertScript(
  value: string,
  characters: Record<string, string>,
): string {
  const compact = value.replace(/\s+/g, "");
  const converted = [...compact]
    .map((character) => characters[character])
    .join("");
  return converted.length === compact.length ? converted : compact;
}
