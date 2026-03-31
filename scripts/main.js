import { DTMTableDirectory } from "./sidebar/DTMTableDirectory.js";
import { TableEditorWindow } from "./apps/TableEditorWindow.js";
import { CreateTableDialog } from "./apps/CreateTableDialog.js";

const MODULE_ID = "dynamic-table-manager";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Dynamic Table Manager`);

  // Replace the default RollTable directory with our custom one
  CONFIG.ui.tables = DTMTableDirectory;

  // Handlebars helpers
  Handlebars.registerHelper("subtract", (a, b) => Number(a) - Number(b));
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Dynamic Table Manager ready`);
});

// Add a DTM "New Table" button to every folder in the table directory.
Hooks.on("renderRollTableDirectory", (_app, html) => {
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root) return;
  root.querySelectorAll(".folder-header, [data-folder-id] .folder-header, .folder .directory-item-header").forEach(header => {
    if (header.querySelector(".dtm-folder-create")) return; // already added
    const folderEl = header.closest("[data-folder-id], .folder[data-entry-id]");
    if (!folderEl) return;
    const folderId = folderEl.dataset.folderId ?? folderEl.dataset.entryId ?? null;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add("dtm-folder-create");
    btn.title = "New Table (DTM)";
    btn.innerHTML = `<i class="fas fa-table"></i>`;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      new CreateTableDialog({ folderId }).render(true);
    });
    // Insert before the last button group or append to header
    const controls = header.querySelector(".folder-controls, .header-actions, .action-buttons") ?? header;
    controls.append(btn);
  });
});
