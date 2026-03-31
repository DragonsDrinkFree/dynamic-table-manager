/**
 * Parses dice notation strings (NdX+M) and calculates possible result ranges.
 * Supports: d6, d10, d100, 2d6, 2d6+4, 2d6-5, etc.
 * Handles negative modifiers that can produce negative range minimums.
 */
export class DiceFormulaParser {

  /**
   * Pattern matching dice notation.
   * Groups: (count)d(sides)(+/-modifier)
   * Examples: d6, 2d6, 2d6+4, d100-5, 3d8+10
   * @type {RegExp}
   */
  static DICE_PATTERN = /^(-?\d*)[dD](\d+)([+-]\d+)?$/;

  /**
   * Check if a string is a valid dice formula.
   * @param {string} formula
   * @returns {boolean}
   */
  static isValid(formula) {
    if (!formula || typeof formula !== "string") return false;
    return this.DICE_PATTERN.test(formula.trim());
  }

  /**
   * Parse a dice formula into its components with calculated min/max.
   * @param {string} formula - e.g., "2d6+4"
   * @returns {{ count: number, sides: number, modifier: number, min: number, max: number }|null}
   */
  static parse(formula) {
    if (!formula || typeof formula !== "string") return null;
    const match = formula.trim().match(this.DICE_PATTERN);
    if (!match) return null;

    const count = match[1] ? parseInt(match[1]) : 1;
    const sides = parseInt(match[2]);
    const modifier = match[3] ? parseInt(match[3]) : 0;

    if (count < 1 || sides < 1) return null;

    const min = count + modifier;         // All dice roll 1
    const max = (count * sides) + modifier; // All dice roll max

    return { count, sides, modifier, min, max };
  }

  /**
   * Get the [min, max] range for a formula.
   * @param {string} formula
   * @returns {number[]|null} [min, max] or null if invalid
   */
  static getRange(formula) {
    const parsed = this.parse(formula);
    if (!parsed) return null;
    return [parsed.min, parsed.max];
  }

  /**
   * Generate row definitions for each possible value in the range.
   * Each row covers exactly one value: { low, high } where low === high.
   * @param {string} formula
   * @returns {{ low: number, high: number }[]}
   */
  static generateRows(formula) {
    const parsed = this.parse(formula);
    if (!parsed) return [];

    const rows = [];
    for (let i = parsed.min; i <= parsed.max; i++) {
      rows.push({ low: i, high: i });
    }
    return rows;
  }
}
