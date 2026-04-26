import { DTMTableDirectory } from "./sidebar/DTMTableDirectory.js";
import { TableEditorWindow } from "./apps/TableEditorWindow.js";
import { CreateTableDialog } from "./apps/CreateTableDialog.js";
import { ItemTemplateRoller } from "./lib/ItemTemplateRoller.js";
import { JournalTemplateRoller } from "./lib/JournalTemplateRoller.js";

const MODULE_ID = "dynamic-table-manager";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Dynamic Table Manager`);

  // Replace the default RollTable directory with our custom one
  CONFIG.ui.tables = DTMTableDirectory;

  // Handlebars helpers
  Handlebars.registerHelper("subtract", (a, b) => Number(a) - Number(b));
});

Hooks.once("setup", () => {
  // Replace the native RollTable sheet with a stub that opens our editor.
  // Done in "setup" (after "init") so CONFIG.RollTable.sheetClass is guaranteed to be set.
  const NativeSheet = CONFIG.RollTable.sheetClass;
  class DTMSheetInterceptor extends NativeSheet {
    render(...args) {
      TableEditorWindow.openForTable(this.document ?? this.object);
      return this;
    }
  }
  CONFIG.RollTable.sheetClass = DTMSheetInterceptor;
});

Hooks.once("ready", () => {
  // Patch `draw` on the actual prototype that table instances inherit from.
  // In Foundry v13+ `globalThis.RollTable` may be a different/deprecated
  // reference than `CONFIG.RollTable.documentClass` (the document class
  // instances are constructed from). Walking the prototype chain to find
  // where `draw` is defined makes us robust to both arrangements and to
  // future renames in the chain.
  const TableClass = CONFIG.RollTable?.documentClass ?? globalThis.RollTable;
  let drawProto = TableClass?.prototype ?? null;
  while (drawProto && !Object.prototype.hasOwnProperty.call(drawProto, "draw")) {
    drawProto = Object.getPrototypeOf(drawProto);
  }
  if (!drawProto) {
    console.error(`${MODULE_ID} | Could not locate RollTable#draw to patch — external table.draw() calls will not route to template generators.`);
  } else {
    const origDraw = drawProto.draw;
    drawProto.draw = async function (options = {}) {
      if (options?._dtmBypass) return origDraw.call(this, options);

      const tableType = this.getFlag(MODULE_ID, "tableType");

      if (tableType === "item-template") {
        try {
          await ItemTemplateRoller.generate(this);
        } catch (err) {
          console.error(`${MODULE_ID} | Item Template generation failed`, err);
          ui.notifications.error("Item generation failed. Check the console for details.");
        }
        return { roll: null, results: [] };
      }

      if (tableType === "journal-template") {
        try {
          await JournalTemplateRoller.roll(this);
        } catch (err) {
          console.error(`${MODULE_ID} | Journal Template generation failed`, err);
          ui.notifications.error("Journal generation failed. Check the console for details.");
        }
        return { roll: null, results: [] };
      }

      return origDraw.call(this, options);
    };
    console.log(`${MODULE_ID} | RollTable#draw wrapper installed on ${drawProto.constructor?.name ?? "(anonymous prototype)"}.`);
  }

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
