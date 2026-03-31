/**
 * Parses raw pasted text (e.g. from a PDF copy) into table rows.
 *
 * Handles two PDF linearization patterns:
 *
 * ROW-BY-ROW (multi-column tables):
 *   1, Col A, Col B, Col C, 2, Col A, Col B, Col C ...
 *   Numbers are sequential; each number is followed by N content lines.
 *
 * COLUMN-BY-COLUMN (single or multi-column interleaved):
 *   1, 11, 2, 12, 3, 13 ... (numbers out of order)
 *   Each number has exactly 1 content line.
 *
 * Multi-column detection: if entries consistently have >1 content line,
 * treat each line as a separate column and return column data.
 */
export class PasteTableParser {

  /** Matches a standalone range or single number: "1", "3-8", "11", "-2" */
  static NUMBER_LINE = /^(-?\d+)\s*[-–]\s*(-?\d+)$|^(-?\d+)$/;

  /** Matches dice notation: d6, 2d10, d100+5 */
  static DICE_LINE = /^\s*-?\d*[dD]\d+([+-]\d+)?\s*$/;

  /**
   * Parse raw pasted text.
   *
   * Returns one of two shapes depending on detected column count:
   *
   * Single column:
   *   { formula, isMultiColumn: false, entries: [{low, high, name}] }
   *
   * Multi-column:
   *   { formula, isMultiColumn: true, columnCount, columns: [{ header, entries: [{low, high, name}] }] }
   *
   * @param {string} rawText
   * @returns {object}
   */
  static parse(rawText) {
    const lines = rawText
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0);

    // Detect dice formula — first dice-notation line wins
    let formula = "";
    for (const line of lines) {
      if (this.DICE_LINE.test(line)) {
        formula = line.trim().toLowerCase();
        break;
      }
    }

    // Collect header lines (non-number, non-formula lines before first number)
    let dataStart = 0;
    const headerLines = [];
    for (let i = 0; i < lines.length; i++) {
      if (this.NUMBER_LINE.test(lines[i])) {
        dataStart = i;
        break;
      }
      if (!this.DICE_LINE.test(lines[i])) {
        headerLines.push(lines[i]);
      }
    }

    const dataLines = lines.slice(dataStart);

    // Collect raw entries: { low, high, contentLines[] }
    const rawEntries = [];
    let i = 0;
    while (i < dataLines.length) {
      const line = dataLines[i];
      const match = line.match(this.NUMBER_LINE);
      if (match) {
        const low  = parseInt(match[1] ?? match[3]);
        const high = match[2] !== undefined ? parseInt(match[2]) : low;
        const contentLines = [];
        i++;
        while (i < dataLines.length && !this.NUMBER_LINE.test(dataLines[i])) {
          contentLines.push(dataLines[i]);
          i++;
        }
        rawEntries.push({ low, high, contentLines });
      } else {
        i++;
      }
    }

    if (rawEntries.length === 0) {
      return { formula, isMultiColumn: false, entries: [] };
    }

    // Detect dominant column count (most common contentLines.length)
    const freq = {};
    for (const e of rawEntries) {
      const n = e.contentLines.length;
      freq[n] = (freq[n] ?? 0) + 1;
    }
    const dominantCount = Number(
      Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]
    );

    // Single column — join multi-line content, sort for interleaved columns
    if (dominantCount <= 1) {
      const entries = rawEntries.map(e => ({
        low: e.low,
        high: e.high,
        name: e.contentLines.join(" ").trim()
      }));
      entries.sort((a, b) => a.low - b.low);
      return { formula, isMultiColumn: false, entries };
    }

    // Multi-column — each content line is a separate column
    // Build column headers: use detected header lines, fall back to "Column N"
    const columns = Array.from({ length: dominantCount }, (_, ci) => ({
      header: headerLines[ci] ?? `Column ${ci + 1}`,
      entries: []
    }));

    for (const e of rawEntries) {
      for (let ci = 0; ci < dominantCount; ci++) {
        columns[ci].entries.push({
          low: e.low,
          high: e.high,
          name: e.contentLines[ci]?.trim() ?? ""
        });
      }
    }

    // Sort all columns by range
    for (const col of columns) {
      col.entries.sort((a, b) => a.low - b.low);
    }

    return { formula, isMultiColumn: true, columnCount: dominantCount, columns };
  }
}
