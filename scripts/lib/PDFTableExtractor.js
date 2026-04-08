import { PasteTableParser } from "./PasteTableParser.js";

/**
 * Extracts structured table data from pdf.js text content items
 * within a user-drawn bounding rectangle.
 *
 * Output is shape-compatible with PasteTableParser.parse() so it can
 * be fed directly into TableCreator methods.
 */
export class PDFTableExtractor {

  /** Within this X distance, items are considered part of the same column band. */
  static COL_BAND_TOLERANCE = 15;

  /** Minimum gap between column band centers to be treated as a separate column. */
  static COL_GAP_THRESHOLD = 30;

  /** Y tolerance (PDF user units) for grouping items into the same row. */
  static ROW_TOLERANCE = 5;

  /**
   * Extract a structured table from pdf.js text items within a bounding box.
   *
   * @param {object[]} textItems  — pdf.js TextItem[] from page.getTextContent().items
   * @param {{ x: number, y: number, w: number, h: number }} rect
   *   Rectangle in PDF user units, bottom-left origin (Y increases upward)
   * @returns {{ formula: string, isMultiColumn: boolean, entries?: [], columns?: [] }}
   */
  static extract(textItems, rect) {
    const filtered = PDFTableExtractor.#filterItems(textItems, rect);
    if (filtered.length === 0) return { formula: "", isMultiColumn: false, entries: [] };

    const allRows = PDFTableExtractor.#clusterRows(filtered);
    if (allRows.length === 0) return { formula: "", isMultiColumn: false, entries: [] };

    // Identify data rows: rows whose leftmost item starts with a number (the range column).
    // Continuation rows (wrapped content with no range number) are merged into their parent
    // row so that wrapped cell text is not lost.
    const dataRows = [];
    let currentGroup = null;
    for (const rowItems of allRows) {
      const firstStr = rowItems[0]?.str?.trim() ?? "";
      const firstToken = firstStr.split(/\s+/)[0].replace(/[.):\]]+$/, "");
      if (PasteTableParser.NUMBER_LINE.test(firstToken)) {
        currentGroup = [...rowItems];
        dataRows.push(currentGroup);
      } else if (currentGroup !== null) {
        // Continuation line — absorb its items into the current numbered row.
        // #buildCellGrid assigns items to columns by X position, so text lands
        // in the correct column and is joined with its siblings automatically.
        currentGroup.push(...rowItems);
      }
      // Non-numbered rows before the first numbered row are headers — skip them.
    }

    // Use numeric-first rows for column detection when available; otherwise fall back.
    const hasRangeCol = dataRows.length >= 2;
    const rows = hasRangeCol ? dataRows : allRows;

    // Detect columns via band clustering — groups nearby X positions into bands,
    // then treats gaps between bands as column dividers.  This is more robust than
    // raw gap detection, which breaks when content items have slight X variations.
    const bands = PDFTableExtractor.#detectColumnBands(rows);
    const colCount = bands.length;

    // Column boundaries are midpoints between adjacent band edges
    const boundaries = [];
    for (let i = 1; i < bands.length; i++) {
      boundaries.push((bands[i - 1].xMax + bands[i].xMin) / 2);
    }

    const grid = PDFTableExtractor.#buildCellGrid(rows, boundaries)
      .filter(row => row.some(cell => cell.trim() !== ""));

    if (grid.length === 0) return { formula: "", isMultiColumn: false, entries: [] };

    // Post-process: PDF right-aligned number columns can split multi-digit numbers
    // across glyphs in two ways:
    //   (a) Both glyphs in range cell, space-joined: "1 1" → normalize to "11"
    //   (b) First glyph in range cell, rest leaked into content cell:
    //       range="1", content="1 The crisis..." → merge to "11" | "The crisis..."
    if (hasRangeCol && colCount >= 2) {
      for (const row of grid) {
        const rangeCell = row[0]?.trim() ?? "";
        // Case (a): "1 1", "1 2" etc — digits separated only by spaces → collapse
        if (/^\d[\d ]+$/.test(rangeCell) && !PasteTableParser.NUMBER_LINE.test(rangeCell)) {
          row[0] = rangeCell.replace(/\s+/g, "");
        }
        // Case (b): single digit in range cell, content cell starts with digit(s) + space
        if (/^\d$/.test(row[0]?.trim() ?? "")) {
          const contentCell = row[1]?.trim() ?? "";
          const m = contentCell.match(/^(\d+)\s+([\s\S]+)/);
          if (m) {
            row[0] = row[0].trim() + m[1];
            row[1] = m[2].trim();
          }
        }
      }
    }

    // First column is the range column when we pre-filtered to numeric-first rows
    // AND the grid confirms those cells are purely numeric.
    const firstColIsRange = hasRangeCol && grid.every(row => {
      const token = (row[0]?.trim() ?? "").split(/\s+/)[0].replace(/[.):\]]+$/, "");
      return PasteTableParser.NUMBER_LINE.test(token);
    });

    const contentCols = colCount - (firstColIsRange ? 1 : 0);

    // --- Side-by-side layout detection ---
    // e.g. [range, content, range, content] — one table printed in two visual columns.
    // Detected when contentCols >= 2 and the second content column also contains only range values.
    if (firstColIsRange && contentCols >= 2) {
      const secondRangeIdx = 2; // col 0=range, col 1=content, col 2=potential second range
      const secondColIsRange = grid.every(row => {
        const token = (row[secondRangeIdx]?.trim() ?? "").split(/\s+/)[0].replace(/[.):\]]+$/, "");
        return token !== "" && PasteTableParser.NUMBER_LINE.test(token);
      });

      if (secondColIsRange) {
        const entries = [];
        for (const row of grid) {
          const lRange = row[0]?.trim().replace(/[.):\]]+$/, "") ?? "";
          const lm = lRange.match(PasteTableParser.NUMBER_LINE);
          if (lm) {
            const lLow  = parseInt(lm[1] ?? lm[3]);
            const lHigh = lm[2] !== undefined ? PDFTableExtractor.#d100Fix(parseInt(lm[2]), lLow) : lLow;
            const lName = row[1]?.trim() ?? "";
            if (lName) entries.push({ low: lLow, high: lHigh, name: lName });
          }
          const rRange = row[secondRangeIdx]?.trim().replace(/[.):\]]+$/, "") ?? "";
          const rm = rRange.match(PasteTableParser.NUMBER_LINE);
          if (rm) {
            const rLow  = parseInt(rm[1] ?? rm[3]);
            const rHigh = rm[2] !== undefined ? PDFTableExtractor.#d100Fix(parseInt(rm[2]), rLow) : rLow;
            const rName = row[3]?.trim() ?? "";
            if (rName) entries.push({ low: rLow, high: rHigh, name: rName });
          }
        }
        entries.sort((a, b) => a.low - b.low);
        return { formula: "", isMultiColumn: false, entries: entries.filter(e => e.name) };
      }
    }

    // --- Single content column path ---
    if (contentCols <= 1) {
      let seq = 0;
      const entries = grid.map(row => {
        let low, high, name;

        if (firstColIsRange && colCount >= 2) {
          // Separate range column and content column
          const rangeText = row[0]?.trim().replace(/[.):\]]+$/, "") ?? "";
          const m = rangeText.match(PasteTableParser.NUMBER_LINE);
          low  = m ? parseInt(m[1] ?? m[3]) : ++seq;
          high = m?.[2] !== undefined ? PDFTableExtractor.#d100Fix(parseInt(m[2]), low) : low;
          name = row[1]?.trim() ?? "";

        } else if (firstColIsRange && colCount === 1) {
          // Range number and content merged into one cell ("1 Dragon Fire")
          const cell = row[0]?.trim() ?? "";
          const splitM = cell.match(/^(-?\d+(?:\s*[-–]\s*-?\d+)?)[.):\]]?\s+([\s\S]+)/);
          if (splitM) {
            const m = splitM[1].match(PasteTableParser.NUMBER_LINE);
            low  = m ? parseInt(m[1] ?? m[3]) : ++seq;
            high = m?.[2] !== undefined ? PDFTableExtractor.#d100Fix(parseInt(m[2]), low) : low;
            name = splitM[2].trim();
          } else {
            low = high = ++seq;
            name = cell;
          }

        } else {
          low = high = ++seq;
          name = row[0]?.trim() ?? "";
        }

        return { low, high, name };
      }).filter(e => e.name !== "");

      return { formula: "", isMultiColumn: false, entries };
    }

    // --- Multi-column path ---
    const startCol = firstColIsRange ? 1 : 0;
    const columns = Array.from({ length: contentCols }, (_, i) => ({
      header: `Column ${i + 1}`,
      entries: []
    }));

    let seq = 0;
    for (const row of grid) {
      let low, high;
      if (firstColIsRange) {
        const rangeText = row[0]?.trim().replace(/[.):\]]+$/, "") ?? "";
        const m = rangeText.match(PasteTableParser.NUMBER_LINE);
        low  = m ? parseInt(m[1] ?? m[3]) : ++seq;
        high = m?.[2] !== undefined ? parseInt(m[2]) : low;
      } else {
        low = high = ++seq;
      }
      for (let ci = 0; ci < contentCols; ci++) {
        const name = row[startCol + ci]?.trim() ?? "";
        columns[ci].entries.push({ low, high, name });
      }
    }

    return { formula: "", isMultiColumn: true, columnCount: contentCols, columns };
  }

  // ---- Private helpers ----

  /**
   * Keep only text items whose position falls within the bounding box.
   * pdf.js item coordinates: transform[4] = x, transform[5] = y (bottom-left origin).
   */
  static #filterItems(items, rect) {
    return items.filter(item => {
      if (!item.str?.trim()) return false;
      const x = item.transform[4];
      const y = item.transform[5];
      return x >= rect.x && x <= rect.x + rect.w
          && y >= rect.y && y <= rect.y + rect.h;
    });
  }

  /**
   * Cluster items into rows by Y proximity using nearest-row assignment.
   * Returns rows sorted top-to-bottom (descending Y in PDF space), each row
   * sorted left-to-right by X.
   */
  static #clusterRows(items) {
    const sorted = [...items].sort((a, b) => b.transform[5] - a.transform[5]);
    const rows = [];
    for (const item of sorted) {
      const y = item.transform[5];
      // Assign to the nearest existing row within tolerance (not just the last)
      let best = null, bestDist = Infinity;
      for (const row of rows) {
        const dist = Math.abs(y - row._meanY);
        if (dist <= PDFTableExtractor.ROW_TOLERANCE && dist < bestDist) {
          best = row;
          bestDist = dist;
        }
      }
      if (best) {
        best.items.push(item);
        best._meanY = best.items.reduce((s, it) => s + it.transform[5], 0) / best.items.length;
      } else {
        rows.push({ items: [item], _meanY: y });
      }
    }
    for (const row of rows) row.items.sort((a, b) => a.transform[4] - b.transform[4]);
    return rows.sort((a, b) => b._meanY - a._meanY).map(r => r.items);
  }

  /**
   * Cluster all item X positions into column bands, then return only the bands
   * that are separated by more than COL_GAP_THRESHOLD from the previous band.
   *
   * Each band: { xMin, xMax, center }
   */
  static #detectColumnBands(rows) {
    const allX = rows.flatMap(row => row.map(item => item.transform[4]));
    allX.sort((a, b) => a - b);
    if (allX.length === 0) return [{ xMin: 0, xMax: 0, center: 0 }];

    // Step 1: cluster into tight bands (items within COL_BAND_TOLERANCE = same band)
    const rawBands = [];
    let band = [allX[0]];
    for (let i = 1; i < allX.length; i++) {
      if (allX[i] - allX[i - 1] <= PDFTableExtractor.COL_BAND_TOLERANCE) {
        band.push(allX[i]);
      } else {
        rawBands.push(band);
        band = [allX[i]];
      }
    }
    rawBands.push(band);

    const toBand = arr => ({
      xMin:   arr[0],
      xMax:   arr[arr.length - 1],
      center: arr.reduce((s, x) => s + x, 0) / arr.length
    });

    // Step 2: merge bands whose gap is less than COL_GAP_THRESHOLD
    const merged = [toBand(rawBands[0])];
    for (let i = 1; i < rawBands.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = toBand(rawBands[i]);
      if (curr.xMin - prev.xMax > PDFTableExtractor.COL_GAP_THRESHOLD) {
        merged.push(curr);
      } else {
        // Absorb curr into prev by extending the range
        prev.xMax = curr.xMax;
        prev.center = (prev.xMin + prev.xMax) / 2;
      }
    }

    return merged;
  }

  /**
   * d100 tables conventionally write "00" to mean 100.
   * If the parsed high value is 0 and low > 0, return 100 instead.
   */
  static #d100Fix(high, low) {
    return (high === 0 && low > 0) ? 100 : high;
  }

  /**
   * Assign each item in each row to a column index based on X boundaries.
   * Returns a 2D array: grid[rowIndex][colIndex] = concatenated cell text.
   */
  static #buildCellGrid(rows, boundaries) {
    return rows.map(rowItems => {
      const cells = Array(boundaries.length + 1).fill(null).map(() => []);
      for (const item of rowItems) {
        const x = item.transform[4];
        let col = boundaries.findIndex(b => x < b);
        if (col === -1) col = boundaries.length;
        cells[col].push(item.str);
      }
      return cells.map(parts => parts.join(" ").trim());
    });
  }
}
