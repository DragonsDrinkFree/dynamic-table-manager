/**
 * Floating picker for selecting a JournalEntryPage as a template.
 *
 * Usage:
 *   const result = await JournalPagePickerPopup.open(anchorRect);
 *   // result: { name, uuid } or null if cancelled
 *
 * Displays results as "Journal Name — Page Name".
 * Search filters across all text-type journal pages in the world.
 */
export class JournalPagePickerPopup {

  static _current = null;

  /**
   * @param {{top,bottom,left,right}} anchorRect  - pre-captured viewport rect
   * @param {string} [initialQuery]
   * @returns {Promise<{name:string, uuid:string}|null>}
   */
  static open(anchorRect, initialQuery = "") {
    if (this._current) this._current._close(null);
    return new Promise(resolve => {
      const popup = new JournalPagePickerPopup(anchorRect, resolve, initialQuery);
      this._current = popup;
      popup._mount();
    });
  }

  constructor(anchorRect, resolve, initialQuery = "") {
    this._anchorRect = anchorRect;
    this._resolve = resolve;
    this._initialQuery = initialQuery;
    this._el = null;
    this._results = [];
    this._highlighted = -1;
    this._dead = false;
  }

  // ---- DOM ------------------------------------------------------------------

  _mount() {
    const el = document.createElement("div");
    el.className = "dtm-doc-picker";
    el.innerHTML = `
      <div class="dtm-doc-picker-search">
        <i class="fas fa-search"></i>
        <input type="text" class="dtm-doc-picker-input"
          placeholder="Search journal pages..."
          autocomplete="off" spellcheck="false" />
      </div>
      <div class="dtm-doc-picker-hint">Type to search journal pages</div>
      <ul class="dtm-doc-picker-list"></ul>
    `;

    this._el = el;
    document.body.appendChild(el);
    this._reposition();

    const input = el.querySelector(".dtm-doc-picker-input");
    input.addEventListener("input", () => this._runSearch(input.value));
    input.addEventListener("keydown", ev => this._onKeyDown(ev));

    if (this._initialQuery) {
      input.value = this._initialQuery;
      input.select();
      this._runSearch(this._initialQuery);
    }

    input.focus();

    // Store timer ID so _close() can cancel it if called before the timeout fires.
    this._clickAway = ev => { if (!el.contains(ev.target)) this._close(null); };
    this._clickAwayTimer = setTimeout(() => document.addEventListener("mousedown", this._clickAway), 0);
  }

  _reposition() {
    const el = this._el;
    const rect = this._anchorRect;
    const W = 320;
    const vh = window.innerHeight;

    let top = rect.bottom + 4;
    let left = rect.left;
    if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
    if (left < 8) left = 8;

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
    if (JournalPagePickerPopup._current === this) JournalPagePickerPopup._current = null;
    this._resolve(result);
  }

  // ---- Search ---------------------------------------------------------------

  _runSearch(query) {
    const lc = query.trim().toLowerCase();
    const results = [];

    for (const journal of game.journal.contents) {
      for (const page of journal.pages.contents) {
        if (page.type !== "text") continue;
        const label = `${journal.name} — ${page.name}`;
        if (!lc || label.toLowerCase().includes(lc)) {
          results.push({ name: label, uuid: page.uuid, journalName: journal.name, pageName: page.name });
        }
      }
    }

    results.sort((a, b) => {
      if (lc) {
        const as = a.name.toLowerCase().startsWith(lc);
        const bs = b.name.toLowerCase().startsWith(lc);
        if (as !== bs) return as ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    this._results = results.slice(0, 60);
    this._highlighted = this._results.length > 0 ? 0 : -1;
    this._renderResults(this._results, query.trim());
  }

  // ---- Rendering ------------------------------------------------------------

  _renderResults(results, query) {
    const list = this._el.querySelector(".dtm-doc-picker-list");
    const hint = this._el.querySelector(".dtm-doc-picker-hint");

    list.innerHTML = "";

    if (results.length === 0) {
      hint.style.display = "";
      hint.textContent = !query ? "Type to search journal pages" : "No pages found";
      return;
    }

    hint.style.display = "none";

    results.forEach((result, i) => {
      const li = document.createElement("li");
      li.className = "dtm-doc-picker-item";
      if (i === this._highlighted) li.classList.add("dtm-highlighted");
      li.dataset.index = String(i);
      li.innerHTML = `
        <i class="fas fa-book-open dtm-doc-icon"></i>
        <span class="dtm-doc-name">${result.pageName}</span>
        <span class="dtm-doc-tag">${result.journalName}</span>
      `;
      li.addEventListener("click", () => this._close({ name: result.name, uuid: result.uuid }));
      list.appendChild(li);
    });
  }

  // ---- Interaction ----------------------------------------------------------

  _onKeyDown(ev) {
    const count = this._results.length;
    switch (ev.key) {
      case "Escape":
        ev.preventDefault();
        this._close(null);
        break;
      case "ArrowDown":
        ev.preventDefault();
        this._moveHighlight(1, count);
        break;
      case "ArrowUp":
        ev.preventDefault();
        this._moveHighlight(-1, count);
        break;
      case "Tab":
        ev.preventDefault();
        this._moveHighlight(ev.shiftKey ? -1 : 1, count);
        break;
      case "Enter": {
        ev.preventDefault();
        const r = this._results[this._highlighted];
        if (r) this._close({ name: r.name, uuid: r.uuid });
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
}
