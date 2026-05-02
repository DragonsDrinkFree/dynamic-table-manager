import { registerTableDirectoryHooks } from "./sidebar/DTMTableDirectory.js";
import { TableEditorWindow } from "./apps/TableEditorWindow.js";
import { CreateTableDialog } from "./apps/CreateTableDialog.js";
import { ItemTemplateRoller } from "./lib/ItemTemplateRoller.js";
import { JournalTemplateRoller } from "./lib/JournalTemplateRoller.js";

const MODULE_ID = "dynamic-table-manager";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Dynamic Table Manager`);

  // Augment the RollTable directory via hooks (no CONFIG.ui.tables override),
  // so we coexist with systems/modules that supply their own directory class.
  registerTableDirectoryHooks();

  // Handlebars helpers
  Handlebars.registerHelper("subtract", (a, b) => Number(a) - Number(b));
});

Hooks.once("setup", () => {
  // Replace the native RollTable sheet with a stub that opens our editor.
  // The legacy CONFIG.RollTable.sheetClass slot is unset on v14 systems that
  // register sheets exclusively through DocumentSheetConfig (e.g. ARS), so we
  // resolve a base class defensively and register through both APIs.
  const NativeSheet =
    CONFIG.RollTable.sheetClass
    ?? foundry.applications?.sheets?.RollTableSheet
    ?? foundry.applications?.sheets?.RollTableConfig;

  if (!NativeSheet) {
    console.warn(`${MODULE_ID} | No RollTable sheet base class found; sheet interception disabled. Sidebar clicks will still open the editor.`);
    return;
  }

  // The override short-circuits to our editor, so the base class's own logic
  // never runs — extending it only satisfies instanceof checks and Foundry's
  // sheet-instantiation contract.
  class DTMSheetInterceptor extends NativeSheet {
    render(...args) {
      TableEditorWindow.openForTable(this.document ?? this.object);
      return this;
    }
  }

  // Legacy slot: still consulted by some flows on systems that populate it.
  CONFIG.RollTable.sheetClass = DTMSheetInterceptor;

  // v14 registry: this is what wins under systems (like ARS) that use
  // DocumentSheetConfig.registerSheet exclusively. Mirrors the API the
  // system itself uses — no system-specific branching.
  const registerSheet = foundry.applications?.apps?.DocumentSheetConfig?.registerSheet;
  if (typeof registerSheet === "function") {
    try {
      registerSheet.call(
        foundry.applications.apps.DocumentSheetConfig,
        RollTable,
        MODULE_ID,
        DTMSheetInterceptor,
        { makeDefault: true, label: "Dynamic Table Manager" }
      );
    } catch (err) {
      console.warn(`${MODULE_ID} | DocumentSheetConfig.registerSheet failed; falling back to legacy sheetClass only.`, err);
    }
  }
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

// Wire reroll buttons on Item Template result cards.
function _bindResultCardClicks(root) {
  if (!root) return;
  const buttons = root.querySelectorAll('[data-dtm-action="reroll"]');
  for (const btn of buttons) {
    if (btn.dataset.dtmBound === "1") continue;
    btn.dataset.dtmBound = "1";
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const itemUuid = btn.dataset.itemUuid;
      const actionId = btn.dataset.actionId;
      const messageId = btn.closest("[data-message-id]")?.dataset.messageId
                     ?? btn.closest(".message")?.dataset.messageId;
      btn.disabled = true;
      try {
        await ItemTemplateRoller.rerollAction(itemUuid, actionId, messageId);
      } catch (err) {
        console.error(`${MODULE_ID} | Reroll failed`, err);
        ui.notifications.error("Reroll failed. Check the console for details.");
      } finally {
        btn.disabled = false;
      }
    });
  }
}

Hooks.on("renderChatMessageHTML", (_msg, html) => _bindResultCardClicks(html));

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
