/**
 * Manages undo/redo history and snapshot revert for a table editing session.
 * Each action stores before/after state for full reversal.
 * A snapshot is taken when the editor opens for full session revert.
 */
export class UndoManager {

  /** @type {object[]} Stack of undo actions */
  #undoStack = [];

  /** @type {object[]} Stack of redo actions */
  #redoStack = [];

  /** @type {object|null} Snapshot of table state when editor was opened */
  #snapshot = null;

  /**
   * Record a new action. Clears the redo stack.
   * @param {{ type: string, before: object, after: object }} action
   */
  record(action) {
    this.#undoStack.push(action);
    this.#redoStack = [];
  }

  /**
   * Undo the last action.
   * @returns {object|null} The "before" state to apply, or null if nothing to undo.
   */
  undo() {
    const action = this.#undoStack.pop();
    if (!action) return null;
    this.#redoStack.push(action);
    return action.before;
  }

  /**
   * Redo the last undone action.
   * @returns {object|null} The "after" state to apply, or null if nothing to redo.
   */
  redo() {
    const action = this.#redoStack.pop();
    if (!action) return null;
    this.#undoStack.push(action);
    return action.after;
  }

  /**
   * Take a snapshot of the current table state.
   * Called when the editor is first opened.
   * @param {object} state - Full table state
   */
  takeSnapshot(state) {
    this.#snapshot = foundry.utils.deepClone(state);
  }

  /**
   * Revert to the snapshot taken when the editor opened.
   * Clears both undo and redo stacks.
   * @returns {object|null} The snapshot state to apply, or null if no snapshot.
   */
  revertToSnapshot() {
    if (!this.#snapshot) return null;
    this.#undoStack = [];
    this.#redoStack = [];
    return foundry.utils.deepClone(this.#snapshot);
  }

  /** @returns {boolean} */
  canUndo() {
    return this.#undoStack.length > 0;
  }

  /** @returns {boolean} */
  canRedo() {
    return this.#redoStack.length > 0;
  }

  /** @returns {number} */
  get undoCount() {
    return this.#undoStack.length;
  }

  /** @returns {number} */
  get redoCount() {
    return this.#redoStack.length;
  }
}
