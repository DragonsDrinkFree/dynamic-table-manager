import { parseRange } from "./RangeParser.js";
import { JournalTemplateRollDialog } from "../apps/JournalTemplateRollDialog.js";

/**
 * Rolling engine for Journal Template tables.
 * Evaluates each key's trigger mode, draws from source tables,
 * substitutes {{KEY}} placeholders in a template page, and
 * creates a new JournalEntryPage with the result.
 */
export class JournalTemplateRoller {

  /**
   * Roll a Journal Template table end-to-end.
   * @param {RollTable} table
   */
  static async roll(table) {
    // ── Phase 1: Validate prerequisites ──────────────────────────────────────
    const templatePageUuid = table.getFlag("dynamic-table-manager", "templatePageUuid");
    if (!templatePageUuid) {
      ui.notifications.warn("Journal Template: no template page selected. Please pick one in the editor.");
      return;
    }

    const templatePage = await fromUuid(templatePageUuid);
    if (!templatePage) {
      ui.notifications.warn("Journal Template: template page not found. It may have been deleted.");
      return;
    }

    const keyRows = [...table.results.contents].sort((a, b) => {
      const ao = a.getFlag("dynamic-table-manager", "order") ?? 0;
      const bo = b.getFlag("dynamic-table-manager", "order") ?? 0;
      return ao - bo;
    });

    if (keyRows.length === 0) {
      ui.notifications.warn("Journal Template: no keys defined.");
      return;
    }

    // ── Phase 2: Evaluate trigger modes and draw results ──────────────────────
    const substitutions = {};

    for (const row of keyRows) {
      const key = row.name?.trim();
      if (!key) continue;

      const fires = await this._evaluateMode(row);
      if (!fires) {
        substitutions[key] = "";
        continue;
      }

      const sourceTable = row.documentUuid ? await fromUuid(row.documentUuid) : null;
      if (!sourceTable) {
        substitutions[key] = "";
        continue;
      }

      try {
        const draw = await sourceTable.draw({ displayChat: false });
        const result = draw.results?.[0];
        substitutions[key] = result ? (result.name || "") : "";
      } catch (err) {
        console.error(`DTM | JournalTemplateRoller: failed to draw from table for key "${key}"`, err);
        ui.notifications.warn(`Journal Template: failed to draw result for key "${key}".`);
        substitutions[key] = "";
      }
    }

    // ── Phase 3: Substitute {{KEY}} placeholders in template ──────────────────
    const rawContent = templatePage.text?.content ?? "";
    const finalContent = rawContent.replace(/\{\{(\w[\w\s]*?)\}\}/g, (_, k) => {
      const trimmed = k.trim();
      return Object.prototype.hasOwnProperty.call(substitutions, trimmed)
        ? substitutions[trimmed]
        : `{{${trimmed}}}`;
    });

    // ── Phase 4: Write output page and post chat card ─────────────────────────
    let journal;
    const outputJournalId = table.getFlag("dynamic-table-manager", "outputJournalId");
    if (outputJournalId) {
      journal = game.journal.get(outputJournalId);
      if (!journal) {
        ui.notifications.warn("Journal Template: default output journal not found. Prompting for selection.");
      }
    }
    if (!journal) {
      journal = await JournalTemplateRollDialog.prompt();
      if (!journal) return; // user cancelled
    }

    const pageName = `${table.name} — ${new Date().toLocaleDateString()}`;
    const createdPages = await journal.createEmbeddedDocuments("JournalEntryPage", [{
      name: pageName,
      type: "text",
      text: {
        content: finalContent,
        format: templatePage.text?.format ?? 1
      }
    }]);
    const page = createdPages[0];

    await ChatMessage.create({
      content: this._formatChatCard(table, page, substitutions)
    });
  }

  /**
   * Evaluate whether a key row fires based on its mode.
   * @param {TableResult} row
   * @returns {Promise<boolean>}
   */
  static async _evaluateMode(row) {
    const mode = row.getFlag("dynamic-table-manager", "mode") ?? "guaranteed";

    if (mode === "guaranteed") return true;

    if (mode === "percent") {
      const percent = row.getFlag("dynamic-table-manager", "percent") ?? 100;
      const roll = await new Roll("1d100").evaluate();
      return roll.total <= percent;
    }

    if (mode === "dice") {
      const die = row.getFlag("dynamic-table-manager", "die") ?? "d6";
      const triggerRangeStr = row.getFlag("dynamic-table-manager", "triggerRange") ?? "1";
      const triggerRange = parseRange(triggerRangeStr);
      if (!triggerRange) return false;
      const roll = await new Roll(`1${die}`).evaluate();
      return roll.total >= triggerRange[0] && roll.total <= triggerRange[1];
    }

    return true;
  }

  /**
   * Build the chat card HTML.
   * @param {RollTable} table
   * @param {JournalEntryPage} page
   * @param {Object} substitutions
   * @returns {string}
   */
  static _formatChatCard(table, page, substitutions) {
    const pairs = Object.entries(substitutions)
      .filter(([, v]) => v !== "")
      .map(([k, v]) => `<li><strong>${k}:</strong> ${v}</li>`)
      .join("");

    const pageLink = `@UUID[${page.uuid}]{${page.name}}`;

    return `
      <div class="dtm-jt-chat-card">
        <p class="dtm-jt-chat-title"><em>${table.name}</em></p>
        ${pairs ? `<ul class="dtm-jt-chat-pairs">${pairs}</ul>` : ""}
        <p class="dtm-jt-chat-link">${pageLink}</p>
      </div>
    `;
  }
}
