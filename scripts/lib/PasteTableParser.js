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

  /** Matches a standalone range or single number: "1", "3-8", "11-20", "01–10" */
  static NUMBER_LINE = /^(-?\d+)\s*[-–—]\s*(-?\d+)$|^(-?\d+)$/;

  /**
   * Matches a range at the START of a line followed by content on the same line:
   * "03–04 A bloodstained jester's hat."
   * Captures: [1]=low, [2]=high, [3]=content
   */
  static INLINE_RANGE = /^(-?\d+)\s*[-–—]\s*(-?\d+)\s+(.+)$/;

  /** Matches dice notation: d6, 2d10, d100+5 */
  static DICE_LINE = /^\s*-?\d*[dD]\d+([+-]\d+)?\s*$/;

  /** Returns true if a line starts a new table entry (pure range/number OR inline range+content). */
  static _isEntryStart(line) {
    return this.NUMBER_LINE.test(line) || this.INLINE_RANGE.test(line);
  }

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

    // Collect header lines (non-number, non-formula lines before first entry)
    let dataStart = 0;
    const headerLines = [];
    for (let i = 0; i < lines.length; i++) {
      if (this._isEntryStart(lines[i])) {
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

      // Case 1: pure range/number line — content follows on subsequent lines
      const numMatch = line.match(this.NUMBER_LINE);
      if (numMatch) {
        const low  = parseInt(numMatch[1] ?? numMatch[3]);
        const rawHigh = numMatch[2] !== undefined ? parseInt(numMatch[2]) : low;
        const high = rawHigh === 0 && low > 0 ? 100 : rawHigh;
        const contentLines = [];
        i++;
        while (i < dataLines.length && !this._isEntryStart(dataLines[i])) {
          contentLines.push(dataLines[i]);
          i++;
        }
        rawEntries.push({ low, high, contentLines });
        continue;
      }

      // Case 2: range + content on the same line ("03–04 A bloodstained jester's hat.")
      const inlineMatch = line.match(this.INLINE_RANGE);
      if (inlineMatch) {
        const low  = parseInt(inlineMatch[1]);
        const rawHigh = parseInt(inlineMatch[2]);
        const high = rawHigh === 0 && low > 0 ? 100 : rawHigh;
        const contentLines = [inlineMatch[3].trim()];
        i++;
        // collect any wrapped continuation lines
        while (i < dataLines.length && !this._isEntryStart(dataLines[i])) {
          contentLines.push(dataLines[i]);
          i++;
        }
        rawEntries.push({ low, high, contentLines });
        continue;
      }

      i++;
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
    const [dominantCountStr, dominantFreqCount] = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
    const dominantCount = Number(dominantCountStr);
    const dominantRatio = dominantFreqCount / rawEntries.length;

    // Single column — join multi-line content, sort for interleaved columns.
    // Also treat as single-column when line counts vary widely (wrapped text), which
    // produces an inconsistent dominant ratio even though dominantCount > 1.
    if (dominantCount <= 1 || dominantRatio < 0.75) {
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
