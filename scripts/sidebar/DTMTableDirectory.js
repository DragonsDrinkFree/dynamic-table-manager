import { TableEditorWindow } from "../apps/TableEditorWindow.js";
import { JournalTemplateEditorWindow } from "../apps/JournalTemplateEditorWindow.js";
import { ItemTemplateEditorWindow } from "../apps/ItemTemplateEditorWindow.js";
import { CreateTableDialog } from "../apps/CreateTableDialog.js";

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
   * Inject the "Create Dynamic Table" button into the sidebar header, below the native buttons.
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

    if (!root.querySelector(".dtm-create-table")) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.classList.add("dtm-create-table");
      btn.innerHTML = `<i class="fas fa-plus"></i> Create Dynamic Table`;
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        new CreateTableDialog().render(true);
      });

      const searchEl = header.querySelector("search, .search-primary, input[type='search']");
      if (searchEl) searchEl.before(btn);
      else header.append(btn);
    }
  }

  /**
   * Route table entry clicks to our editor instead of the default sheet.
   * @param {HTMLElement} root
   */
  _bindTableClicks(root) {
    // Use capture phase so our handler fires before Foundry's child-element listeners.
    root.addEventListener("click", (ev) => {
      const entry = ev.target.closest("[data-entry-id]:not(.folder)");
      if (!entry) return;
      if (ev.target.closest("button") || ev.target.closest("a.control")) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const table = game.tables.get(entry.dataset.entryId);
      if (!table) return;
      const tableType = table.getFlag("dynamic-table-manager", "tableType");
      if (tableType === "item-template") {
        ItemTemplateEditorWindow.openForTable(table);
      } else if (tableType === "journal-template") {
        JournalTemplateEditorWindow.openForTable(table);
      } else {
        TableEditorWindow.openForTable(table);
      }
    }, true);
  }

}
