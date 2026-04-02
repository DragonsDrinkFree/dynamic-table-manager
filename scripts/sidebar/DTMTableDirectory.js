import { TableEditorWindow } from "../apps/TableEditorWindow.js";
import { JournalTemplateEditorWindow } from "../apps/JournalTemplateEditorWindow.js";
import { CreateTableDialog } from "../apps/CreateTableDialog.js";

const MODULE_ID = "dynamic-table-manager";

/**
 * Custom RollTable directory that replaces the default sidebar tab.
 * Extends the native RollTableDirectory to preserve folder support,
 * adds search filtering, and routes table clicks to our editor.
 */
export class DTMTableDirectory extends RollTableDirectory {

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);

    const root = this.element;
    if (!root) return;

    this._injectHeaderControls(root);
    this._bindTableClicks(root);
  }

  /**
   * Inject the "New Table" button and search bar into the sidebar header.
   * @param {HTMLElement} root
   */
  _injectHeaderControls(root) {
    let header = root.querySelector(".directory-header")
                ?? root.querySelector("header")
                ?? root.querySelector(".header");

    if (!header) {
      header = document.createElement("div");
      header.classList.add("directory-header", "dtm-injected-header");
      root.prepend(header);
    }

    if (!root.querySelector(".dtm-search")) {
      const searchDiv = document.createElement("div");
      searchDiv.classList.add("dtm-search");
      searchDiv.innerHTML = `<input type="text" placeholder="Search tables..." autocomplete="off" />`;
      header.after(searchDiv);
      searchDiv.querySelector("input").addEventListener("input", (ev) => {
        this._filterEntries(root, ev.currentTarget.value.toLowerCase().trim());
      });
    }

    if (!root.querySelector(".dtm-create-table")) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.classList.add("dtm-create-table");
      btn.innerHTML = `<i class="fas fa-plus"></i> New Table`;
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        new CreateTableDialog().render(true);
      });

      const actionArea = header.querySelector(".header-actions") ?? header.querySelector(".action-buttons");
      if (actionArea) actionArea.prepend(btn);
      else header.append(btn);
    }
  }

  /**
   * Route table entry clicks to our editor instead of the default sheet.
   * @param {HTMLElement} root
   */
  _bindTableClicks(root) {
    root.addEventListener("click", (ev) => {
      const entry = ev.target.closest("[data-entry-id]:not(.folder)");
      if (!entry) return;
      if (ev.target.closest("button") || ev.target.closest("a.control")) return;
      ev.preventDefault();
      ev.stopPropagation();
      const table = game.tables.get(entry.dataset.entryId);
      if (!table) return;
      if (table.getFlag("dynamic-table-manager", "tableType") === "journal-template") {
        JournalTemplateEditorWindow.openForTable(table);
      } else {
        TableEditorWindow.openForTable(table);
      }
    });
  }

  /**
   * Filter directory entries by search query.
   * @param {HTMLElement} root
   * @param {string} query
   */
  _filterEntries(root, query) {
    const entries = root.querySelectorAll("[data-entry-id]:not(.folder)");
    if (!query) {
      entries.forEach(el => el.style.display = "");
      root.querySelectorAll(".folder").forEach(f => f.style.display = "");
      return;
    }
    entries.forEach(el => {
      const name = el.textContent?.toLowerCase() ?? "";
      el.style.display = name.includes(query) ? "" : "none";
    });
    root.querySelectorAll(".folder").forEach(folder => {
      const hasVisible = folder.querySelector("[data-entry-id]:not(.folder):not([style*='display: none'])");
      folder.style.display = hasVisible ? "" : "none";
    });
  }
}
