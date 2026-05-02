import { TableEditorWindow } from "../apps/TableEditorWindow.js";
import { JournalTemplateEditorWindow } from "../apps/JournalTemplateEditorWindow.js";
import { ItemTemplateEditorWindow } from "../apps/ItemTemplateEditorWindow.js";
import { CreateTableDialog } from "../apps/CreateTableDialog.js";

/**
 * Sidebar table directory augmentation.
 *
 * We hook into renderRollTableDirectory rather than replacing CONFIG.ui.tables
 * with our own subclass. CONFIG.ui.tables is a single-slot assignment; any
 * system or module that also writes to it (e.g. ARS sets it to
 * ARSRollTableDirectory) silently wipes whatever was there before. The hook,
 * by contrast, fires for any directory class and lets multiple modules
 * coexist on the same directory.
 */
export function registerTableDirectoryHooks() {
  Hooks.on("renderRollTableDirectory", (_app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    _injectHeaderControls(root);
    _bindTableClicks(root);
  });
}

/**
 * Inject the "Create Dynamic Table" button into the sidebar header. If another
 * module has already added a flexrow button container near the search input,
 * we share that row instead of stacking a separate element.
 * @param {HTMLElement} root
 */
function _injectHeaderControls(root) {
  let header = root.querySelector(".directory-header")
              ?? root.querySelector("header")
              ?? root.querySelector(".header");

  if (!header) {
    header = document.createElement("div");
    header.classList.add("directory-header", "dtm-injected-header");
    root.prepend(header);
  }

  if (root.querySelector(".dtm-create-table")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.classList.add("dtm-create-table");
  btn.style.flex = "1";
  btn.innerHTML = `<i class="fas fa-plus"></i> Create Dynamic Table`;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    new CreateTableDialog().render(true);
  });

  const searchEl = header.querySelector("search, .search-primary, input[type='search']");
  const existingRow = _findHeaderButtonRow(header, searchEl);
  if (existingRow) {
    existingRow.append(btn);
    return;
  }

  if (searchEl) {
    const row = document.createElement("div");
    row.className = "header-actions action-buttons flexrow dtm-header-row";
    row.style.cssText = "margin: 0.25rem 0 0.5rem 0; gap: 0.5rem;";
    row.append(btn);
    searchEl.before(row);
  } else {
    header.append(btn);
  }
}

/**
 * Locate an existing flexrow button container in the directory header so we
 * can drop our button into it rather than creating a duplicate row.
 * @param {HTMLElement} header
 * @param {HTMLElement|null} searchEl
 * @returns {HTMLElement|null}
 */
function _findHeaderButtonRow(header, searchEl) {
  const rowSelector = ".header-actions.flexrow, .action-buttons.flexrow, div.flexrow";
  if (searchEl) {
    const prev = searchEl.previousElementSibling;
    if (prev && prev.matches(rowSelector)) return prev;
  }
  return header.querySelector(`${rowSelector}:has(button)`) ?? null;
}

/**
 * Route table-entry clicks to our editor instead of the default sheet.
 * Idempotent: only attaches the listener once per element, even if the
 * directory re-renders and reuses the same root.
 * @param {HTMLElement} root
 */
function _bindTableClicks(root) {
  if (root.dataset.dtmClicksBound === "1") return;
  root.dataset.dtmClicksBound = "1";

  // Capture phase so our handler fires before Foundry's child-element listeners.
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
