/**
 * Prompts the user to choose a JournalEntry to receive the rolled output.
 * Used when no default output journal is configured on the template.
 */
export class JournalTemplateRollDialog {

  /**
   * Show a journal-picker dialog and return the chosen JournalEntry, or null.
   * @returns {Promise<JournalEntry|null>}
   */
  static async prompt() {
    const journals = game.journal.contents.sort((a, b) => a.name.localeCompare(b.name));

    if (journals.length === 0) {
      ui.notifications.warn("Journal Template: no journals exist. Create a journal first.");
      return null;
    }

    const options = journals.map(j =>
      `<option value="${j.id}">${j.name}</option>`
    ).join("");

    const content = `
      <div class="dtm-detect-links-source">
        <label class="dtm-field-label">Output Journal</label>
        <select name="journalId" class="dtm-source-select">
          ${options}
        </select>
        <p class="dtm-source-hint">A new page will be created in this journal.</p>
      </div>`;

    const journalId = await foundry.applications.api.DialogV2.wait({
      window: { title: "Journal Template — Choose Output" },
      content,
      rejectClose: false,
      buttons: [
        {
          action: "pick",
          label: "Generate",
          icon: "fas fa-scroll",
          default: true,
          callback: (_ev, _btn, dialog) =>
            dialog.element.querySelector("[name='journalId']")?.value ?? null
        },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" }
      ]
    });

    if (!journalId || journalId === "cancel") return null;
    return game.journal.get(journalId) ?? null;
  }
}
