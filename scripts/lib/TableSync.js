/**
 * Bridges the editor UI state with Foundry's RollTable document.
 * Handles applying full state objects (from undo/redo/revert) to the actual document,
 * including creating/deleting/updating TableResult embedded documents.
 */
export class TableSync {

  /** @type {RollTable} */
  #table;

  /** @type {number|null} Debounce timer ID */
  #debounceTimer = null;

  /** @type {number} Debounce delay in ms */
  static DEBOUNCE_MS = 300;

  /**
   * @param {RollTable} table - The Foundry RollTable document to sync with
   */
  constructor(table) {
    this.#table = table;
  }

  /**
   * Apply a full table state to the RollTable document.
   * Used by undo, redo, and snapshot revert.
   * Replaces all results and updates top-level fields.
   * @param {object} state - { name, formula, description, results: [TableResult data] }
   */
  async applyState(state) {
    if (!state) return;

    // Cancel any pending debounced update
    this._cancelDebounce();

    // Update top-level table fields
    const tableUpdate = {
      name: state.name,
      formula: state.formula,
      description: state.description
    };
    if (state.replacement !== undefined) tableUpdate.replacement = state.replacement;
    await this.#table.update(tableUpdate);

    // Replace all results: delete existing, then create from state
    const existingIds = this.#table.results.map(r => r.id);
    if (existingIds.length > 0) {
      await this.#table.deleteEmbeddedDocuments("TableResult", existingIds);
    }

    if (state.results?.length > 0) {
      // Strip _id from results so Foundry assigns new ones
      const cleanResults = state.results.map(r => {
        const { _id, ...rest } = r;
        return rest;
      });
      await this.#table.createEmbeddedDocuments("TableResult", cleanResults);
    }
  }

  /**
   * Debounced update for a single field change.
   * Groups rapid edits into a single database write.
   * @param {object} updateData - Data to pass to table.update()
   */
  debouncedUpdate(updateData) {
    this._cancelDebounce();
    this.#debounceTimer = setTimeout(async () => {
      await this.#table.update(updateData);
      this.#debounceTimer = null;
    }, TableSync.DEBOUNCE_MS);
  }

  /**
   * Cancel any pending debounced update.
   */
  _cancelDebounce() {
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
  }
}
