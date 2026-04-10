/**
 * Floating document-picker popup for Document-type table results.
 *
 * Usage:
 *   const result = await DocumentPickerPopup.open(anchorElement);
 *   // result: { name, img, uuid } or null if cancelled
 *
 * Query syntax:
 *   <term>          — search world Actors, Items, JournalEntries
 *   @               — list all compendiums
 *   @<name>         — list compendiums whose label includes <name>
 *   @ <term>        — search all compendiums for <term>
 *   @<name> <term>  — search compendiums matching <name> for <term>
 */
export class DocumentPickerPopup {

  static _current = null;
  static DEFAULT_TYPES = ["Actor", "Item", "JournalEntry", "RollTable"];

  /**
   * Open a picker positioned relative to a pre-captured DOMRect snapshot.
   * Callers must snapshot getBoundingClientRect() themselves before any async
   * operations, because Foundry update hooks can trigger re-renders that detach
   * anchor elements — making a live element reference return all-zero rects.
   *
   * @param {DOMRect|{top,bottom,left,right}} anchorRect  - viewport rect snapshot
   * @param {string} [initialQuery]
   * @returns {Promise<{name:string, img:string|null, uuid:string}|null>}
   */
  static open(anchorRect, initialQuery = "", typeFilter = null) {
    if (this._current) this._current._close(null);
    return new Promise(resolve => {
      const popup = new DocumentPickerPopup(anchorRect, resolve, initialQuery, typeFilter);
      this._current = popup;
      popup._mount();
    });
  }

  constructor(anchorRect, resolve, initialQuery = "", typeFilter = null) {
    this._anchorRect = anchorRect;
    this._resolve = resolve;
    this._initialQuery = initialQuery;
    this._typeFilter = typeFilter; // null = all types; array = restrict to listed types
    this._el = null;
    this._results = [];
    this._highlighted = -1;
    this._searchTimer = null;
    this._dead = false;
  }

  // ---- DOM ----------------------------------------------------------------

  _mount() {
    const el = document.createElement("div");
    el.className = "dtm-doc-picker";
    el.innerHTML = `
      <div class="dtm-doc-picker-search">
        <i class="fas fa-search"></i>
        <input type="text" class="dtm-doc-picker-input"
          placeholder="Search or paste UUID… (@ for compendiums)"
          autocomplete="off" spellcheck="false" />
      </div>
      <div class="dtm-doc-picker-hint">Type to search world documents</div>
      <ul class="dtm-doc-picker-list"></ul>
    `;

    this._el = el;
    document.body.appendChild(el);
    this._reposition();

    const input = el.querySelector(".dtm-doc-picker-input");
    input.addEventListener("input", () => this._scheduleSearch(input.value));
    input.addEventListener("keydown", ev => this._onKeyDown(ev));

    if (this._initialQuery) {
      input.value = this._initialQuery;
      input.select();
      this._scheduleSearch(this._initialQuery);
    }

    input.focus();

    // Close when clicking outside (deferred so this click doesn't immediately close).
    // Store the timer ID so _close() can cancel it if called before the timeout fires.
    this._clickAway = ev => {
      if (!el.contains(ev.target)) this._close(null);
    };
    this._clickAwayTimer = setTimeout(() => document.addEventListener("mousedown", this._clickAway), 0);
  }

  _reposition() {
    const el = this._el;
    const rect = this._anchorRect;
    const W = 300;
    const vh = window.innerHeight;

    let top = rect.bottom + 4;
    let left = rect.left;

    if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
    if (left < 8) left = 8;

    // Flip upward if the popup would overflow the bottom of the viewport
    const estimatedH = 320;
    if (top + estimatedH > vh - 8) {
      top = rect.top - estimatedH - 4;
      if (top < 8) top = 8;
    }

    Object.assign(el.style, {
      position: "fixed",
      top: `${top}px`,
      left: `${left}px`,
      width: `${W}px`,
      zIndex: "9999"
    });
  }

  _close(result) {
    if (this._dead) return;
    this._dead = true;
    this._el?.remove();
    clearTimeout(this._clickAwayTimer);
    document.removeEventListener("mousedown", this._clickAway);
    if (DocumentPickerPopup._current === this) DocumentPickerPopup._current = null;
    this._resolve(result);
  }

  // ---- Search -------------------------------------------------------------

  _scheduleSearch(query) {
    clearTimeout(this._searchTimer);
    // Compendium index fetching is async — short debounce to avoid hammering
    const delay = query.startsWith("@") && query.length > 2 ? 180 : 0;
    this._searchTimer = setTimeout(() => this._runSearch(query), delay);
  }

  async _runSearch(query) {
    if (this._dead) return;
    const results = await this._search(query.trim());
    if (this._dead) return;
    this._results = results;
    this._highlighted = results.length > 0 ? 0 : -1;
    this._renderResults(results, query.trim());
  }

  async _search(query) {
    if (!query) return [];

    if (query === "@") {
      return this._listPacks("");
    }

    if (query.startsWith("@")) {
      const rest = query.slice(1);
      const spaceAt = rest.indexOf(" ");
      if (spaceAt === -1) {
        // Still typing the pack name — show matching pack hints
        return this._listPacks(rest);
      }
      const packFilter = rest.slice(0, spaceAt);
      const term = rest.slice(spaceAt + 1);
      return this._searchPacks(packFilter, term);
    }

    // UUID direct lookup: no spaces + contains "." → try fromUuid before name search.
    // Matches world-doc format (RollTable.id) and compendium format (Compendium.pack.Type.id).
    if (!query.includes(" ") && query.includes(".")) {
      const uuidResult = await this._searchByUuid(query);
      if (uuidResult) return [uuidResult];
    }

    return this._searchWorld(query);
  }

  /**
   * Attempt to resolve a query string as a UUID or Document.id shorthand.
   * Returns a result object on success, null if the UUID cannot be resolved.
   */
  async _searchByUuid(query) {
    try {
      const doc = await fromUuid(query);
      if (!doc) return null;
      return {
        name:    doc.name,
        img:     doc.img ?? null,
        uuid:    doc.uuid,
        docType: doc.documentName ?? doc.constructor?.documentName ?? ""
      };
    } catch {
      return null;
    }
  }

  /** Return pack-hint items whose label includes filter. */
  _listPacks(filter) {
    const TYPES = this._typeFilter ?? DocumentPickerPopup.DEFAULT_TYPES;
    const lc = filter.toLowerCase();
    return [...game.packs]
      .filter(p => TYPES.includes(p.metadata.type))
      .filter(p => !filter || p.metadata.label.toLowerCase().includes(lc))
      .map(p => ({
        _isPackHint: true,
        name: p.metadata.label,
        _packId: p.collection,
        docType: p.metadata.type
      }));
  }

  /** Search compendium entries. packFilter="" means all packs. */
  async _searchPacks(packFilter, term) {
    const TYPES = this._typeFilter ?? DocumentPickerPopup.DEFAULT_TYPES;
    const lc = term.toLowerCase();
    const packLc = packFilter.toLowerCase();

    let packs = [...game.packs].filter(p => TYPES.includes(p.metadata.type));
    if (packFilter) packs = packs.filter(p => p.metadata.label.toLowerCase().includes(packLc));

    const results = [];
    for (const pack of packs) {
      await pack.getIndex();
      for (const entry of pack.index.contents) {
        if (!term || entry.name.toLowerCase().includes(lc)) {
          const uuid = pack.getUuid
            ? pack.getUuid(entry._id)
            : `Compendium.${pack.collection}.${entry._id}`;
          results.push({
            name: entry.name,
            img: entry.img ?? null,
            uuid,
            docType: pack.metadata.type,
            packLabel: pack.metadata.label
          });
          if (results.length >= 60) return results;
        }
      }
    }
    return results;
  }

  /** Search world-level Actors, Items, JournalEntries. */
  _searchWorld(query) {
    const lc = query.toLowerCase();
    const results = [];

    const allCollections = [
      [game.actors,  "Actor"],
      [game.items,   "Item"],
      [game.journal, "JournalEntry"],
      [game.tables,  "RollTable"]
    ];
    const collections = this._typeFilter
      ? allCollections.filter(([, t]) => this._typeFilter.includes(t))
      : allCollections;

    for (const [collection, docType] of collections) {
      for (const doc of collection.contents) {
        if (doc.name.toLowerCase().includes(lc)) {
          results.push({ name: doc.name, img: doc.img ?? null, uuid: doc.uuid, docType });
        }
      }
    }

    // Starts-with first, then alphabetical
    results.sort((a, b) => {
      const as = a.name.toLowerCase().startsWith(lc);
      const bs = b.name.toLowerCase().startsWith(lc);
      if (as !== bs) return as ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return results.slice(0, 60);
  }

  // ---- Rendering ----------------------------------------------------------

  _renderResults(results, query) {
    const list = this._el.querySelector(".dtm-doc-picker-list");
    const hint = this._el.querySelector(".dtm-doc-picker-hint");

    list.innerHTML = "";

    if (results.length === 0) {
      hint.style.display = "";
      hint.textContent = !query
        ? "Type to search world documents"
        : "No results found";
      return;
    }

    hint.style.display = "none";

    results.forEach((result, i) => {
      const li = document.createElement("li");
      li.className = "dtm-doc-picker-item";
      if (i === this._highlighted) li.classList.add("dtm-highlighted");
      li.dataset.index = String(i);

      if (result._isPackHint) {
        li.innerHTML = `
          <i class="fas fa-archive dtm-doc-icon"></i>
          <span class="dtm-doc-name">${result.name}</span>
          <span class="dtm-doc-tag">${result.docType}</span>
        `;
        li.addEventListener("click", () => this._selectPackHint(result));
      } else {
        const media = result.img
          ? `<img src="${result.img}" class="dtm-doc-img" alt="" />`
          : `<i class="${this._typeIcon(result.docType)} dtm-doc-icon"></i>`;
        li.innerHTML = `
          ${media}
          <span class="dtm-doc-name">${result.name}</span>
          ${result.packLabel ? `<span class="dtm-doc-tag">${result.packLabel}</span>` : ""}
        `;
        li.addEventListener("click", () => this._selectResult(result));
      }

      list.appendChild(li);
    });
  }

  _typeIcon(docType) {
    return { Actor: "fas fa-user", Item: "fas fa-suitcase",
             JournalEntry: "fas fa-book-open", RollTable: "fas fa-table" }[docType]
      ?? "fas fa-file";
  }

  // ---- Interaction --------------------------------------------------------

  _onKeyDown(ev) {
    const count = this._results.length;

    switch (ev.key) {
      case "Escape":
        ev.preventDefault();
        this._close(null);
        break;

      case "ArrowDown":
      case "Tab":
        if (ev.key === "Tab" && ev.shiftKey) {
          ev.preventDefault();
          this._moveHighlight(-1, count);
        } else {
          ev.preventDefault();
          this._moveHighlight(1, count);
        }
        break;

      case "ArrowUp":
        ev.preventDefault();
        this._moveHighlight(-1, count);
        break;

      case "Enter": {
        ev.preventDefault();
        const r = this._results[this._highlighted];
        if (!r) return;
        if (r._isPackHint) this._selectPackHint(r);
        else this._selectResult(r);
        break;
      }
    }
  }

  _moveHighlight(delta, count) {
    if (count === 0) return;
    this._highlighted = Math.max(0, Math.min(count - 1, this._highlighted + delta));
    const items = [...this._el.querySelectorAll(".dtm-doc-picker-item")];
    items.forEach((el, i) => el.classList.toggle("dtm-highlighted", i === this._highlighted));
    items[this._highlighted]?.scrollIntoView({ block: "nearest" });
  }

  /** Clicking a pack hint fills the input and re-searches. */
  _selectPackHint(result) {
    const input = this._el.querySelector(".dtm-doc-picker-input");
    input.value = `@${result.name} `;
    input.focus();
    this._scheduleSearch(input.value);
  }

  _selectResult(result) {
    this._close({ name: result.name, img: result.img ?? null, uuid: result.uuid });
  }
}
