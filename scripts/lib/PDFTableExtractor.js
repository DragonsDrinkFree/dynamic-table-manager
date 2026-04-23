import { PasteTableParser } from "./PasteTableParser.js";

/**
 * Extracts structured table data from pdf.js text content items
 * within a user-drawn bounding rectangle.
 *
 * Output is shape-compatible with PasteTableParser.parse() so it can
 * be fed directly into TableCreator methods.
 *
 * Two modes:
 *   "single" — one conceptual table; region may span multiple visual
 *              columns (e.g. d100 Trinket printed in two page-columns).
 *              Detects flow-column layout and pairs every range with
 *              its adjacent content cell. Always returns a single-column
 *              result (isMultiColumn: false).
 *
 *   "multi"  — region covers a true multi-column data table (range + N
 *              data columns). Returns isMultiColumn: true when contentCols >= 2.
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
   * @param {"single"|"multi"} [mode="multi"]  Extraction mode
   * @returns {{ formula: string, isMultiColumn: boolean, entries?: [], columns?: [] }}
   */
  static extract(textItems, rect, mode = "multi") {
    let result;
    if (mode === "single") {
      result = PDFTableExtractor.#extractSingle(textItems, rect);
    } else {
      const prep = PDFTableExtractor.#prepareGrid(textItems, rect);
      if (!prep) return { formula: "", isMultiColumn: false, entries: [] };
      const { grid, firstColIsRange, colCount } = prep;
      result = PDFTableExtractor.#extractMulti(grid, firstColIsRange, colCount);
    }
    if (!result.formula) result.formula = PDFTableExtractor.#inferFormula(textItems, rect, result);
    return result;
  }

  /**
   * Infer a dice formula for the table.
   * Priority 1: a standalone dice token in the region (e.g. "d100", "D12", "d%").
   * Priority 2: "1d{rowCount}" based on how many rows were extracted.
   */
  static #inferFormula(textItems, rect, result) {
    const filtered = PDFTableExtractor.#filterItems(textItems, rect);
    const DICE_STANDALONE = /^[dD](\d+|%)$/;
    for (const item of filtered) {
      const str = item.str?.trim() ?? "";
      if (!str) continue;
      const m = str.match(DICE_STANDALONE);
      if (m) {
        const size = m[1] === "%" ? "100" : m[1];
        return `1d${size}`;
      }
    }
    const count = result.isMultiColumn
      ? (result.columns?.[0]?.entries?.length ?? 0)
      : (result.entries?.length ?? 0);
    return count > 0 ? `1d${count}` : "";
  }

  // ---- Shared preparation pipeline ----

  /**
   * Filter → row-cluster → continuation-merge → band-detect → grid-build → post-process.
   * Returns { grid, firstColIsRange, colCount } or null if no data.
   */
  static #prepareGrid(textItems, rect) {
    const filtered = PDFTableExtractor.#filterItems(textItems, rect);
    if (filtered.length === 0) return null;

    const allRows = PDFTableExtractor.#clusterRows(filtered);
    if (allRows.length === 0) return null;

    // Identify data rows: rows whose leftmost item starts with a number.
    // Continuation rows (wrapped content with no range number) are merged into
    // their parent row so wrapped cell text is preserved.
    const dataRows = [];
    let currentGroup = null;
    for (const rowItems of allRows) {
      const firstStr = rowItems[0]?.str?.trim() ?? "";
      const firstToken = firstStr.split(/\s+/)[0].replace(/[.):\]]+$/, "");
      if (PasteTableParser.NUMBER_LINE.test(firstToken)) {
        currentGroup = [...rowItems];
        dataRows.push(currentGroup);
      } else if (currentGroup !== null) {
        currentGroup.push(...rowItems);
      }
    }

    const hasRangeCol = dataRows.length >= 2;
    const rows = hasRangeCol ? dataRows : allRows;

    const bands = PDFTableExtractor.#detectColumnBands(rows);
    const colCount = bands.length;

    const boundaries = [];
    for (let i = 1; i < bands.length; i++) {
      boundaries.push((bands[i - 1].xMax + bands[i].xMin) / 2);
    }

    const grid = PDFTableExtractor.#buildCellGrid(rows, boundaries)
      .filter(row => row.some(cell => cell.trim() !== ""));
    if (grid.length === 0) return null;

    // Post-process: PDF right-aligned number columns can split multi-digit numbers
    // across glyphs in two ways:
    //   (a) Both glyphs in range cell, space-joined: "1 1" → normalize to "11"
    //   (b) First glyph in range cell, rest leaked into content cell:
    //       range="1", content="1 The crisis..." → merge to "11" | "The crisis..."
    if (hasRangeCol && colCount >= 2) {
      for (const row of grid) {
        const rangeCell = row[0]?.trim() ?? "";
        if (/^\d[\d ]+$/.test(rangeCell) && !PasteTableParser.NUMBER_LINE.test(rangeCell)) {
          row[0] = rangeCell.replace(/\s+/g, "");
        }
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

    const firstColIsRange = hasRangeCol && grid.every(row => {
      const token = (row[0]?.trim() ?? "").split(/\s+/)[0].replace(/[.):\]]+$/, "");
      return PasteTableParser.NUMBER_LINE.test(token);
    });

    return { grid, firstColIsRange, colCount };
  }

  // ---- Single-column mode ----

  /** Gap between range-token X clusters that separates flow columns (PDF user units). */
  static FLOW_COL_GAP = 50;

  /**
   * Single-column extraction. Scans text items in reading order, grouping each
   * range token with the content items that follow it *in the same flow column*.
   *
   * Why item-level instead of grid-based: PDF tables often have the range number
   * and first content word only ~30 pt apart — tighter than the band detector's
   * gap threshold. A grid would merge them into a single cell where the range
   * token is no longer at the start, breaking range parsing. Item-level scan
   * reads each text-item's X position directly, so spacing is irrelevant.
   *
   * Flow-column detection: collect X positions of every item that starts with
   * a range token. Large gaps (> FLOW_COL_GAP) separate visual page-columns
   * (e.g. d100 Trinket printed in two side-by-side halves).
   */
  static #extractSingle(textItems, rect) {
    const filtered = PDFTableExtractor.#filterItems(textItems, rect);
    if (filtered.length === 0) return { formula: "", isMultiColumn: false, entries: [] };

    const rows = PDFTableExtractor.#clusterRows(filtered);
    if (rows.length === 0) return { formula: "", isMultiColumn: false, entries: [] };

    // Collect X positions of items whose first whitespace-separated token is a range.
    const rangeXs = [];
    for (const rowItems of rows) {
      for (const item of rowItems) {
        const trimmed = item.str?.trim() ?? "";
        if (!trimmed) continue;
        const firstTok = trimmed.split(/\s+/)[0].replace(/[.):\]]+$/, "");
        if (PasteTableParser.NUMBER_LINE.test(firstTok)) {
          rangeXs.push(item.transform[4]);
        }
      }
    }
    if (rangeXs.length === 0) return { formula: "", isMultiColumn: false, entries: [] };

    // Cluster range X positions into flow columns.
    rangeXs.sort((a, b) => a - b);
    const flowCols = [{ xMin: rangeXs[0], xMax: rangeXs[0] }];
    for (let i = 1; i < rangeXs.length; i++) {
      const last = flowCols[flowCols.length - 1];
      if (rangeXs[i] - last.xMax > PDFTableExtractor.FLOW_COL_GAP) {
        flowCols.push({ xMin: rangeXs[i], xMax: rangeXs[i] });
      } else {
        last.xMax = rangeXs[i];
      }
    }

    // Boundaries = midpoints between adjacent flow-column edges.
    const boundaries = [];
    for (let i = 1; i < flowCols.length; i++) {
      boundaries.push((flowCols[i - 1].xMax + flowCols[i].xMin) / 2);
    }
    const classify = x => {
      for (let i = 0; i < boundaries.length; i++) if (x < boundaries[i]) return i;
      return boundaries.length;
    };

    // Walk items row-by-row, left-to-right within each row. Each flow column
    // maintains its own "current pair" so wrapped content attaches to the right
    // entry regardless of which column has items on the current Y line.
    const current = Array(flowCols.length).fill(null);
    const entries = [];

    const commit = (p) => {
      if (!p) return;
      const m = p.range.match(PasteTableParser.NUMBER_LINE);
      if (!m) return;
      const low  = parseInt(m[1] ?? m[3]);
      const high = m[2] !== undefined ? PDFTableExtractor.#d100Fix(parseInt(m[2]), low) : low;
      const name = p.content.join(" ").trim();
      if (name) entries.push({ low, high, name });
    };

    for (const rowItems of rows) {
      for (const item of rowItems) {
        const str = item.str?.trim() ?? "";
        if (!str) continue;
        const col = classify(item.transform[4]);
        const firstTok = str.split(/\s+/)[0].replace(/[.):\]]+$/, "");
        if (PasteTableParser.NUMBER_LINE.test(firstTok)) {
          commit(current[col]);
          const remainder = str.slice(str.indexOf(firstTok) + firstTok.length).replace(/^[.):\]]+/, "").trim();
          current[col] = { range: firstTok, content: remainder ? [remainder] : [] };
        } else if (current[col]) {
          current[col].content.push(str);
        }
      }
    }
    for (const p of current) commit(p);

    entries.sort((a, b) => a.low - b.low);
    return { formula: "", isMultiColumn: false, entries };
  }

  // ---- Multi-column mode ----

  /**
   * Multi-column extraction. User has explicitly declared this region is a
   * true multi-column data table (range + N data columns). No side-by-side
   * auto-detection here — single-column mode is the tool for that case.
   */
  static #extractMulti(grid, firstColIsRange, colCount) {
    const contentCols = colCount - (firstColIsRange ? 1 : 0);

    // Single content column path
    if (contentCols <= 1) {
      let seq = 0;
      const entries = grid.map(row => {
        let low, high, name;

        if (firstColIsRange && colCount >= 2) {
          const rangeText = row[0]?.trim().replace(/[.):\]]+$/, "") ?? "";
          const m = rangeText.match(PasteTableParser.NUMBER_LINE);
          low  = m ? parseInt(m[1] ?? m[3]) : ++seq;
          high = m?.[2] !== undefined ? PDFTableExtractor.#d100Fix(parseInt(m[2]), low) : low;
          name = row[1]?.trim() ?? "";

        } else if (firstColIsRange && colCount === 1) {
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

    // Multi content column path
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
        high = m?.[2] !== undefined ? PDFTableExtractor.#d100Fix(parseInt(m[2]), low) : low;
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

    const merged = [toBand(rawBands[0])];
    for (let i = 1; i < rawBands.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = toBand(rawBands[i]);
      if (curr.xMin - prev.xMax > PDFTableExtractor.COL_GAP_THRESHOLD) {
        merged.push(curr);
      } else {
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
