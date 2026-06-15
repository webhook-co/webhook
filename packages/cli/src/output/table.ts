import { stripAnsi } from "./color.js";

// Render rows as a left-justified, column-aligned text table with a two-space gutter (the kubectl/gh
// idiom). Headers are passed already-cased (UPPERCASE) by the caller. Column widths use the VISIBLE
// width — ANSI escapes stripped — so a color-styled status cell aligns with its plain neighbors.
// Trailing padding is trimmed per line so output stays free of trailing whitespace.

/** Visible (printed) width of a cell, ignoring any ANSI color escapes. */
function visible(cell: string): number {
  return stripAnsi(cell).length;
}

function pad(cell: string, width: number): string {
  return cell + " ".repeat(Math.max(0, width - visible(cell)));
}

export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((header, col) =>
    Math.max(visible(header), ...rows.map((row) => visible(row[col] ?? ""))),
  );
  const line = (cells: readonly string[]): string =>
    headers
      .map((_, col) => pad(cells[col] ?? "", widths[col] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}
