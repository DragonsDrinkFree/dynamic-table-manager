const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Results dialog for the Detect Links feature.
 * Displays per-row match suggestions in three tiers (perfect/decent/loose),
 * allows bulk or individual acceptance, manual search override, and applies
 * all accepted rows as DOCUMENT-type TableResult updates in one batch call.
 */
export class DetectLinksDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @type {RollTable} */
  #table;

  /** @type {ApplicationV2|null} The TableEditorWindow that launched this dialog */
  #editorWindow;

  /**
   * Per-row decision state.
   * @type {Map<string, {
   *   resultId: string,
   *   resultName: string,
   *   candidates: {name:string, uuid:string, img:string|null, tier:string}[],
   *   accepted: {name:string, uuid:string, img:string|null, tier:string}|null,
   *   denied: boolean,
   *   searchQuery: string,
   *   dropdownOpen: boolean
   * }>}
   */
  #rows;

  /** @type {{name:string, uuid:string, img:string|null}[]} Full source for manual search */
  #allSourceEntries;

  constructor(options = {}) {
    super(options);
    this.#table = options.table;
    this.#editorWindow = options.editorWindow ?? null;
    this.#allSourceEntries = options.sourceEntries ?? [];
    this.#rows = new Map(
      (options.matchResults ?? []).map(mr => [mr.resultId, {
        resultId:     mr.resultId,
        resultName:   mr.resultName,
        candidates:   mr.candidates,
        accepted:     null,
        denied:       false,
        searchQuery:  "",
        dropdownOpen: false
      }])
    );
  }

  static DEFAULT_OPTIONS = {
    id: "dtm-detect-links",
    classes: ["dynamic-table-manager", "dtm-detect-links"],
    tag: "div",
    window: { title: "Detect Links", icon: "fas fa-search-plus", resizable: true },
    position: { width: 660, height: 560 },
    actions: {
      acceptRow:     DetectLinksDialog.#onAcceptRow,
      denyRow:       DetectLinksDialog.#onDenyRow,
      clearAccepted: DetectLinksDialog.#onClearAccepted,
      bulkAccept:    DetectLinksDialog.#onBulkAccept,
      applyLinks:    DetectLinksDialog.#onApplyLinks,
      cancelDialog:  DetectLinksDialog.#onCancelDialog
    }
  };

  static PARTS = {
    dialog: {
      template: "modules/dynamic-table-manager/templates/detect-links.hbs"
    }
  };

  /** @override */
  async _prepareContext() {
    let pendingPerfect = 0, pendingDecent = 0, pendingLoose = 0;

    const rows = [...this.#rows.values()].map(row => {
      const bestCandidate = row.accepted ?? (row.denied ? null : (row.candidates[0] ?? null));
      const isPending = !row.accepted && !row.denied;

      if (isPending && bestCandidate) {
        if (bestCandidate.tier === "perfect") pendingPerfect++;
        else if (bestCandidate.tier === "decent") pendingDecent++;
        else if (bestCandidate.tier === "loose")  pendingLoose++;
      }

      return {
        resultId:           row.resultId,
        resultName:         row.resultName,
        isAccepted:         !!row.accepted,
        isDenied:           row.denied && !row.accepted,
        isPending,
        accepted:           row.accepted,
        bestCandidate:      isPending ? (row.candidates[0] ?? null) : null,
        searchQuery:        row.searchQuery,
        dropdownOpen:       row.dropdownOpen,
        filteredCandidates: row.dropdownOpen && row.searchQuery.length >= 2
          ? this.#filterSource(row.searchQuery)
          : []
      };
    });

    const acceptedCount = [...this.#rows.values()].filter(r => r.accepted).length;

    return {
      rows,
      pendingPerfect,
      pendingDecent,
      pendingLoose,
      hasPending:    (pendingPerfect + pendingDecent + pendingLoose) > 0,
      acceptedCount,
      totalCount:    this.#rows.size
    };
  }

  /** @override */
  _onRender(context, options) {
    const html = this.element;

    // Manual search input — update query and open dropdown
    html.addEventListener("input", (ev) => {
      if (!ev.target.classList.contains("dtm-link-search")) return;
      const resultId = ev.target.closest("[data-result-id]")?.dataset.resultId;
      const row = this.#rows.get(resultId);
      if (!row) return;
      row.searchQuery  = ev.target.value;
      row.dropdownOpen = ev.target.value.length >= 2;
      this.render();
    });

    // Click a dropdown item → accept that entry manually
    html.addEventListener("click", (ev) => {
      const item = ev.target.closest(".dtm-link-dropdown-item");
      if (!item) return;
      const resultId = item.closest("[data-result-id]")?.dataset.resultId;
      const row = this.#rows.get(resultId);
      if (!row) return;
      row.accepted = {
        uuid: item.dataset.uuid,
        name: item.dataset.name,
        img:  item.dataset.img || null,
        tier: "manual"
      };
      row.denied       = false;
      row.searchQuery  = "";
      row.dropdownOpen = false;
      this.render();
    });

    // Click outside a search wrap → close all dropdowns
    html.addEventListener("click", (ev) => {
      if (ev.target.closest(".dtm-link-search-wrap")) return;
      let changed = false;
      for (const row of this.#rows.values()) {
        if (row.dropdownOpen) { row.dropdownOpen = false; changed = true; }
      }
      if (changed) this.render();
    });
  }

  // ---- Private helpers ----

  #filterSource(query) {
    const q = query.toLowerCase();
    return this.#allSourceEntries
      .filter(e => e.name.toLowerCase().includes(q))
      .slice(0, 8);
  }

  // ---- Actions ----

  static #onAcceptRow(event, target) {
    const resultId = target.closest("[data-result-id]")?.dataset.resultId;
    const row = this.#rows.get(resultId);
    if (!row || row.denied) return;
    const best = row.candidates[0] ?? null;
    if (best) { row.accepted = best; this.render(); }
  }

  static #onDenyRow(event, target) {
    const resultId = target.closest("[data-result-id]")?.dataset.resultId;
    const row = this.#rows.get(resultId);
    if (!row) return;
    row.accepted = null;
    row.denied   = true;
    this.render();
  }

  static #onClearAccepted(event, target) {
    const resultId = target.closest("[data-result-id]")?.dataset.resultId;
    const row = this.#rows.get(resultId);
    if (!row) return;
    row.accepted = null;
    row.denied   = false;
    this.render();
  }

  static #onBulkAccept(event, target) {
    const tier = target.dataset.tier;
    for (const row of this.#rows.values()) {
      if (row.accepted || row.denied) continue;
      const best = row.candidates[0] ?? null;
      if (best?.tier === tier) row.accepted = best;
    }
    this.render();
  }

  static async #onApplyLinks() {
    const updates = [];
    for (const row of this.#rows.values()) {
      if (!row.accepted) continue;
      updates.push({
        _id:          row.resultId,
        type:         CONST.TABLE_RESULT_TYPES.DOCUMENT,
        documentUuid: row.accepted.uuid,
        name:         row.accepted.name,
        img:          row.accepted.img ?? null
      });
    }

    if (updates.length === 0) {
      ui.notifications.info("No rows accepted — nothing to apply.");
      return;
    }

    await this.#table.updateEmbeddedDocuments("TableResult", updates);
    ui.notifications.info(`Detect Links: linked ${updates.length} row(s).`);
    // Refresh the owning TableEditorWindow if it's open, without a circular import.
    this.#editorWindow?.render();
    this.close();
  }

  static #onCancelDialog() {
    this.close();
  }
}
