import { toVisibleSourceText } from "./textQuote";

export function tableHtmlToRows(value: string): string[][] {
  if (!/<tr\b/i.test(value)) return [];
  const rows: string[][] = [];
  for (const rowMatch of value.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [
      ...rowMatch[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi),
    ]
      .slice(0, 20)
      .map((cell) => toVisibleSourceText(cell[1]).replace(/\s+/g, " ").trim());
    if (cells.length) rows.push(cells);
    if (rows.length >= 50) break;
  }
  return rows;
}
