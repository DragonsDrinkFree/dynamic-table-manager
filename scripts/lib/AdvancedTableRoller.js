import { ItemTemplateRoller } from "./ItemTemplateRoller.js";

const DUMMY_RESULT_NAME = "Dynamic Table: Advanced Table";
const DUMMY_RESULT_TEXT =
  "This result is a meta result for the Advanced Table type within the " +
  "Dynamic Table Manager Module. If you are seeing this, you may need to " +
  "re-enable the Dynamic Table Manager.";

export class AdvancedTableRoller {

  /**
   * Make sure an advanced table has the structure Foundry's RollTable machinery
   * expects (a single inert TableResult covering [1,1] and replacement:true).
   * Idempotent — safe to call any number of times.
   * @param {RollTable} table
   * @returns {Promise<void>}
   */
  static async ensureDummyResult(table) {
    if (!table) return;
    if (!game.user?.isGM) return;

    const updates = {};
    if (table.formula !== "1")       updates.formula = "1";
    if (table.replacement !== true)  updates.replacement = true;
    if (Object.keys(updates).length) await table.update(updates);

    const results = Array.from(table.results ?? []);
    const hasOneCorrectDummy = results.length === 1
      && results[0].name === DUMMY_RESULT_NAME
      && (results[0].range?.[0] ?? 0) === 1
      && (results[0].range?.[1] ?? 0) === 1
      && results[0].drawn === false;

    if (hasOneCorrectDummy) return;

    if (results.length) {
      await table.deleteEmbeddedDocuments("TableResult", results.map(r => r.id));
    }
    await table.createEmbeddedDocuments("TableResult", [{
      type: CONST.TABLE_RESULT_TYPES.TEXT,
      name: DUMMY_RESULT_NAME,
      description: DUMMY_RESULT_TEXT,
      range: [1, 1],
      weight: 1,
      drawn: false
    }]);
  }

  /**
   * Evaluate the action tree and post a formatted chat card.
   * Called from the RollTable#draw wrapper when tableType === "advanced-table".
   * @param {RollTable} table
   * @returns {Promise<{roll:null, results:[]}>}
   */
  static async roll(table) {
    const config = table.getFlag("dynamic-table-manager", "advancedTableConfig") ?? { actions: [] };
    const ctx = { outputs: [] };
    await AdvancedTableRoller._evaluateActions(config.actions ?? [], ctx);

    const rawHtml = AdvancedTableRoller._buildCardHtml(table.name, ctx.outputs);
    const enriched = await TextEditor.enrichHTML(rawHtml, { async: true });

    await ChatMessage.create({
      content: enriched,
      speaker: ChatMessage.getSpeaker({ alias: table.name })
    });

    return { roll: null, results: [] };
  }

  // ---------------------------------------------------------------------------
  // Action tree evaluation
  // ---------------------------------------------------------------------------

  /**
   * Walk the action array depth-first, collecting outputs.
   * @param {Action[]} actions
   * @param {{ outputs: {label:string|null, html:string}[] }} ctx
   */
  static async _evaluateActions(actions, ctx) {
    for (const action of (actions ?? [])) {
      if (action.type === "output") {
        const html = await AdvancedTableRoller._resolveOutputValue(action);
        if (html === null || html === undefined) continue;
        ctx.outputs.push({ label: action.label || null, html });

      } else if (action.type === "group") {
        const times = await AdvancedTableRoller._resolveLoopCount(action.loop);
        for (let i = 0; i < times; i++) {
          await AdvancedTableRoller._evaluateActions(action.children ?? [], ctx);
        }

      } else if (action.type === "conditional") {
        if (action.branches) {
          const times = await AdvancedTableRoller._resolveLoopCount(action.loop);
          for (let i = 0; i < times; i++) {
            let selectedBranch;
            const die = action.die ?? "d6";
            const roll = await new Roll(`1${die}`).evaluate();
            for (const branch of action.branches) {
              if (branch.isElse) continue;
              if (roll.total >= (branch.low ?? 1) && roll.total <= (branch.high ?? 1)) {
                selectedBranch = branch;
                break;
              }
            }
            if (!selectedBranch) selectedBranch = action.branches.find(b => b.isElse);
            if (selectedBranch) {
              await AdvancedTableRoller._evaluateActions(selectedBranch.actions ?? [], ctx);
            }
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Output value resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve an output action's value to a raw HTML string (pre-enrichment).
   * Returns null if nothing should be emitted.
   * @param {OutputAction} action
   * @returns {Promise<string|null>}
   */
  static async _resolveOutputValue(action) {
    if (action.sourceType === "text") {
      const resolved = await AdvancedTableRoller._evaluateInlineRolls(action.value ?? "");
      return AdvancedTableRoller._esc(resolved ?? "");
    }

    if (action.sourceType === "document") {
      if (!action.documentUuid) return null;
      const name = action.documentName ?? action.documentUuid;
      return `@UUID[${action.documentUuid}]{${AdvancedTableRoller._esc(name)}}`;
    }

    if (action.sourceType === "table") {
      if (!action.tableUuid) return null;
      const result = await AdvancedTableRoller._rollTableRecursive(action.tableUuid);
      if (!result) return null;

      const tableField = action.tableField ?? "name";

      if (result.type === "document") {
        if (tableField === "description") {
          const desc = AdvancedTableRoller._getDescription(result.doc);
          return desc
            ? AdvancedTableRoller._esc(desc)
            : `@UUID[${result.doc.uuid}]{${AdvancedTableRoller._esc(result.doc.name ?? "")}}`;
        }
        if (tableField === "both") {
          const name = result.doc.name ?? "";
          const desc = AdvancedTableRoller._getDescription(result.doc);
          const joined = AdvancedTableRoller._joinNameAndDesc(name, desc);
          return AdvancedTableRoller._esc(joined);
        }
        // "name" — emit a UUID link
        return `@UUID[${result.doc.uuid}]{${AdvancedTableRoller._esc(result.doc.name ?? "")}}`;
      }

      // Text result
      const name = result.value ?? "";
      const desc = result.description ?? "";
      if (tableField === "description") return AdvancedTableRoller._esc(desc || name);
      if (tableField === "both")        return AdvancedTableRoller._esc(AdvancedTableRoller._joinNameAndDesc(name, desc));
      return AdvancedTableRoller._esc(name);
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Recursive table rolling
  // ---------------------------------------------------------------------------

  /**
   * Evaluate an Advanced Table's action tree and return its combined outputs as
   * a single text result for use inside a parent table roll.  @UUID references
   * in the raw output are resolved to their display name so the result reads
   * cleanly as plain text (the parent's enrichment pass will re-linkify them).
   */
  static async _rollAdvancedTableAsResult(table, depth) {
    const config = table.getFlag("dynamic-table-manager", "advancedTableConfig") ?? { actions: [] };
    const ctx = { outputs: [] };
    await AdvancedTableRoller._evaluateActions(config.actions ?? [], ctx);
    if (!ctx.outputs.length) return null;

    // Collapse outputs to a plain-text string: strip @UUID[uuid]{name} → name,
    // then join with a semicolon separator.
    const value = ctx.outputs.map(({ label, html }) => {
      const plain = html.replace(/@UUID\[[^\]]+\]\{([^}]+)\}/g, "$1");
      return label ? `${label}: ${plain}` : plain;
    }).join("; ");

    return { type: "text", value, description: "" };
  }

  /**
   * Roll a table and follow chained RollTable documents recursively until a
   * non-table result is reached.
   * @param {string} tableUuid
   * @param {number} [depth=0]
   * @returns {Promise<{type:"text",value:string,description:string}|{type:"document",doc:foundry.abstract.Document}|null>}
   */
  static async _rollTableRecursive(tableUuid, depth = 0) {
    if (depth > 20) {
      console.warn("DTM AdvancedTableRoller: recursion depth limit reached");
      return null;
    }

    const table = await fromUuid(tableUuid).catch(() => null);
    if (!(table instanceof RollTable)) return null;

    // If the sub-table is one of our special types, route to the correct handler
    // rather than bypassing to the meaningless dummy result.
    const tableType = table.getFlag("dynamic-table-manager", "tableType");

    if (tableType === "advanced-table") {
      return AdvancedTableRoller._rollAdvancedTableAsResult(table, depth);
    }

    if (tableType === "item-template") {
      const item = await ItemTemplateRoller.generate(table).catch(err => {
        console.error("DTM AdvancedTableRoller: item-template sub-table failed", err);
        return null;
      });
      return item ? { type: "document", doc: item } : null;
    }

    if (tableType === "journal-template") {
      // Journal template creates a JournalEntry page as its output — run it and
      // surface the table name as a plain text result (page linking is a future improvement).
      try { await table.draw({ _dtmBypass: false }); } catch (_) { /* draw wrapper handles it */ }
      return { type: "text", value: table.name, description: "" };
    }

    const draw = await table.draw({ displayChat: false, _dtmBypass: true });
    const result = draw.results?.[0];
    if (!result) return null;

    const resultName = result.name ?? "";
    const resultDesc = result.description ?? "";

    if (result.type === CONST.TABLE_RESULT_TYPES.DOCUMENT) {
      const doc = await fromUuid(result.documentUuid).catch(() => null);
      if (doc instanceof RollTable) {
        return AdvancedTableRoller._rollTableRecursive(doc.uuid, depth + 1);
      }
      return doc ? { type: "document", doc } : { type: "text", value: resultName, description: resultDesc };
    }

    return { type: "text", value: resultName, description: resultDesc };
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /**
   * Resolve the loop count for a group or conditional.
   * Accepts a static integer (1, 2, 3…) or any dice formula ("d6", "2d4", "d6+1").
   * Always returns at least 1.
   */
  static async _resolveLoopCount(loop) {
    if (!loop && loop !== 0) return 1;
    const n = Number(loop);
    if (Number.isFinite(n)) return Math.max(1, Math.floor(n));
    try {
      const roll = await new Roll(String(loop)).evaluate();
      return Math.max(1, Math.floor(roll.total));
    } catch {
      return 1;
    }
  }

  static async _evaluateInlineRolls(text) {
    if (typeof text !== "string" || !text.includes("[[")) return text;
    const pattern = /\[\[\s*(?:\/r\s+)?([^\]]+?)\s*\]\]/g;
    const matches = [...text.matchAll(pattern)];
    if (!matches.length) return text;

    let result = text;
    for (const [whole, formula] of matches) {
      try {
        const roll = await new Roll(formula).evaluate();
        result = result.replace(whole, String(roll.total));
      } catch (err) {
        console.warn(`DTM AdvancedTable: invalid inline roll "${formula}" — leaving literal in place.`, err);
      }
    }
    return result;
  }

  static _getDescription(doc) {
    if (!doc) return "";
    const paths = [
      "system.description.value",
      "system.description.short",
      "system.details.description.value",
      "system.details.biography.value",
      "system.notes.value",
      "system.notes",
      "system.description",
      "description"
    ];
    for (const path of paths) {
      const val = foundry.utils.getProperty(doc, path);
      if (typeof val === "string" && val.trim()) return val;
    }
    return "";
  }

  static _joinNameAndDesc(name, description) {
    if (!description) return name;
    const trimmed = description.replace(/^\s+/, "");
    const startsWithBlock = /^<(p|div|h\d|ul|ol|li|blockquote|pre|figure|table|section|article)\b/i.test(trimmed);
    const sep = startsWithBlock ? "" : "<br>";
    return `${name}:${sep}${trimmed}`;
  }

  static _esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------------------------------------------------------------------------
  // Chat card builder
  // ---------------------------------------------------------------------------

  /**
   * Build the raw card HTML (pre-enrichment). @UUID[...] strings are left
   * unresolved here; TextEditor.enrichHTML handles them in roll().
   * @param {string} tableName
   * @param {{label:string|null, html:string}[]} outputs
   * @returns {string}
   */
  static _buildCardHtml(tableName, outputs) {
    const header = `<div class="dtm-ac-header"><i class="fas fa-table"></i> ${AdvancedTableRoller._esc(tableName)}</div>`;

    let body;
    if (!outputs.length) {
      body = `<div class="dtm-ac-empty"><em>No results.</em></div>`;
    } else {
      const rows = outputs.map(({ label, html }) => {
        const labelHtml = label
          ? `<span class="dtm-ac-label">${AdvancedTableRoller._esc(label)}:</span>`
          : "";
        return `<div class="dtm-ac-row">${labelHtml}<span class="dtm-ac-value">${html}</span></div>`;
      }).join("");
      body = `<div class="dtm-ac-results">${rows}</div>`;
    }

    return `<div class="dtm-advanced-card">${header}${body}</div>`;
  }
}
