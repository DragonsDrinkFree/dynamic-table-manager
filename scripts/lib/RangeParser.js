/**
 * Parse a user-entered range string into [low, high].
 * Supports: "5", "-3", "3-8", "-5-2", "-5--2"
 * @param {string} value
 * @returns {number[]|null}
 */
export function parseRange(value) {
  const match = value.match(/^(-?\d+)(?:\s*-\s*(-?\d+))?$/);
  if (!match) return null;
  const low = parseInt(match[1]);
  const high = match[2] !== undefined ? parseInt(match[2]) : low;
  if (high < low) return null;
  return [low, high];
}
