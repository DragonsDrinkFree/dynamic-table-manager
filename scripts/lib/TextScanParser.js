/**
 * Parse blocks of formatted prose text from one or more PDF regions into
 * structured table entries. Supports three entry-boundary detection modes
 * (font heuristic, colon-prefix, custom regex) and configurable name /
 * description capture rules.
 *
 * This is a pure-logic class — no Foundry UI dependencies.
 */
export class TextScanParser {

  static #DEFAULT_RULES = {
    splitMode:    "colon-prefix",  // "font" | "colon-prefix" | "regex"
    splitPattern: "",
    nameCapture:  "before-colon", // "before-colon" | "full" | "regex"
    namePattern:  "",
    nameGroup:    1,
    descCapture:  "after-colon",  // "after-colon" | "rest" | "full" | "none" | "regex"
    descPattern:  "",
    descGroup:    1,
    stripPatterns: []
  };

  static defaultRules() {
    return { ...TextScanParser.#DEFAULT_RULES, stripPatterns: [] };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Parse raw pdf.js text items from one or more regions into table entries.
   *
   * @param {object[][]} itemSets   - one array of pdf.js text items per region, in combine order
   * @param {object}     rules      - rule configuration (fields from defaultRules())
   * @returns {{ entries: {name:string, description:string}[], rawText: string }}
   */
  static parse(itemSets, rules) {
    rules = { ...TextScanParser.#DEFAULT_RULES, ...rules };

    // 1. Process each region independently into row objects, then concatenate.
    //    Doing it per-region avoids any coordinate confusion between pages/columns.
    const rows = [];
    for (const items of itemSets) {
      if (!items?.length) continue;
      const regionRows = TextScanParser._itemsToRows(items);
      rows.push(...regionRows);
    }

    if (!rows.length) return { entries: [], rawText: "" };

    // 2. Compute median font size — used by the "font" split heuristic.
    const fontSizes = rows.map(r => r.fontSize).filter(s => s > 0);
    const medianFs = TextScanParser._median(fontSizes);

    // 3. Produce a human-readable raw text dump.
    const rawText = rows.map(r => r.text).join("\n");

    // 4. Split rows into entry blocks.
    const blocks = [];
    let current = [];
    for (const row of rows) {
      if (TextScanParser._isEntryStart(row, rules, medianFs)) {
        if (current.length) blocks.push(current);
        current = [row];
      } else {
        current.push(row);
      }
    }
    if (current.length) blocks.push(current);

    // 5. Extract name / description from each block.
    const entries = blocks
      .map(block => {
        const full = block.map(r => r.text).join(" ");
        const name = TextScanParser._applyStrip(
          TextScanParser._extractName(full, block, rules), rules);
        const desc = TextScanParser._applyStrip(
          TextScanParser._extractDescription(full, block, rules), rules);
        return { name: name.trim(), description: desc.trim() };
      })
      .filter(e => e.name);

    return { entries, rawText };
  }

  // ---------------------------------------------------------------------------
  // Row extraction (per region)
  // ---------------------------------------------------------------------------

  /**
   * Convert a flat array of pdf.js text items for ONE region into an ordered
   * array of row objects `{ text, hasBold, fontSize }`.  Items are grouped by
   * their real PDF Y coordinate (top-to-bottom reading order), then sorted
   * left-to-right within each row.
   */
  static _itemsToRows(items, yThreshold = 4) {
    if (!items?.length) return [];
    const rawRows = TextScanParser._groupRawByY(items, yThreshold);
    return rawRows
      .map(rowItems => {
        const text = rowItems.map(i => i.str ?? "").join("").trim();
        if (!text) return null;
        const hasBold  = rowItems.some(i => TextScanParser._isBold(i));
        const fontSize = Math.max(0, ...rowItems.map(i => Math.abs(i.transform?.[3] ?? 0)));
        return { text, items: rowItems, hasBold, fontSize };
      })
      .filter(Boolean);
  }

  /**
   * Group a flat array of pdf.js items into rows by their Y position
   * (PDF coordinates, higher Y = higher on page). Within each row, items
   * are sorted by X (left to right reading order).
   */
  static _groupRawByY(items, yThreshold = 4) {
    if (!items.length) return [];

    // Sort descending by Y (top of page first in reading order).
    const sorted = [...items].sort((a, b) => {
      const yDiff = (b.transform?.[5] ?? 0) - (a.transform?.[5] ?? 0);
      if (Math.abs(yDiff) > yThreshold) return yDiff;
      return (a.transform?.[4] ?? 0) - (b.transform?.[4] ?? 0);
    });

    const rows = [];
    let current = [sorted[0]];
    let currentY = sorted[0].transform?.[5] ?? 0;

    for (let i = 1; i < sorted.length; i++) {
      const item = sorted[i];
      const y = item.transform?.[5] ?? 0;
      if (Math.abs(y - currentY) <= yThreshold) {
        current.push(item);
      } else {
        current.sort((a, b) => (a.transform?.[4] ?? 0) - (b.transform?.[4] ?? 0));
        rows.push(current);
        current = [item];
        currentY = y;
      }
    }
    current.sort((a, b) => (a.transform?.[4] ?? 0) - (b.transform?.[4] ?? 0));
    rows.push(current);

    return rows;
  }

  // ---------------------------------------------------------------------------
  // Entry boundary detection
  // ---------------------------------------------------------------------------

  static _isBold(item) {
    return /bold|heavy|black|demi/i.test(item.fontName ?? "");
  }

  static _isEntryStart(row, rules, medianFontSize) {
    switch (rules.splitMode) {
      case "font":
        return row.hasBold || row.fontSize > medianFontSize + 1.5;

      case "colon-prefix":
        // Matches lines starting with "Word(s):" — up to ~40 chars before the colon.
        return /^[A-Z][A-Za-z\s\-]{0,40}:/.test(row.text);

      case "regex": {
        if (!rules.splitPattern) return false;
        try { return new RegExp(rules.splitPattern, "i").test(row.text); }
        catch { return false; }
      }

      default: return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Name / description extraction
  // ---------------------------------------------------------------------------

  static _extractName(blockText, rows, rules) {
    switch (rules.nameCapture) {
      case "before-colon": {
        const idx = blockText.indexOf(":");
        return idx > -1 ? blockText.slice(0, idx) : blockText;
      }
      case "full":
        return blockText;
      case "regex": {
        if (!rules.namePattern) return blockText;
        try {
          const m = blockText.match(new RegExp(rules.namePattern, "i"));
          return m ? (m[rules.nameGroup ?? 1] ?? m[0] ?? "") : blockText;
        } catch { return blockText; }
      }
      default: return blockText;
    }
  }

  static _extractDescription(blockText, rows, rules) {
    switch (rules.descCapture) {
      case "after-colon": {
        const idx = blockText.indexOf(":");
        return idx > -1 ? blockText.slice(idx + 1) : "";
      }
      case "rest":
        // Join all rows except the first (entry-start) row.
        return rows.slice(1).map(r => r.text).join(" ");
      case "full":
        return blockText;
      case "regex": {
        if (!rules.descPattern) return "";
        try {
          const m = blockText.match(new RegExp(rules.descPattern, "i"));
          return m ? (m[rules.descGroup ?? 1] ?? m[0] ?? "") : "";
        } catch { return ""; }
      }
      case "none":
      default: return "";
    }
  }

  static _applyStrip(text, rules) {
    if (!text || !rules.stripPatterns?.length) return text;
    let result = text;
    for (const pattern of rules.stripPatterns) {
      if (!pattern.trim()) continue;
      try { result = result.replace(new RegExp(pattern, "gi"), ""); }
      catch { /* invalid regex — skip */ }
    }
    return result.trim();
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  static _median(arr) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  /**
   * Filter raw pdf.js text items to those whose baseline point falls within
   * the given PDF-coordinate rectangle.
   *
   * @param {object[]} items    raw getTextContent() items
   * @param {{ x, y, w, h }} pdfRect  bottom-left origin, Y increases upward
   * @returns {object[]}
   */
  static filterItemsToRect(items, { x, y, w, h }) {
    return items.filter(item => {
      const ix = item.transform?.[4] ?? 0;
      const iy = item.transform?.[5] ?? 0;
      return ix >= x && ix <= x + w && iy >= y && iy <= y + h;
    });
  }
}
