import katex from "katex";

const MAX_LATEX_LENGTH = 4_096;
const ACTIVE_CONTENT_PATTERN =
  /<script|<iframe|<object|<embed|<img|javascript:|data:text\/html|on[a-z]+\s*=/i;

export function renderSafeMathHtml(
  latex: string,
  displayMode: boolean,
): string | null {
  if (!latex || latex.length > MAX_LATEX_LENGTH) return null;
  try {
    const html = katex.renderToString(latex, {
      displayMode,
      output: "mathml",
      strict: "ignore",
      throwOnError: false,
      trust: false,
    });
    return ACTIVE_CONTENT_PATTERN.test(html) ? null : html;
  } catch {
    return null;
  }
}
