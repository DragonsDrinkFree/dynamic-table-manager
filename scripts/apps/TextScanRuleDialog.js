import { TextScanParser } from "../lib/TextScanParser.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const PREVIEW_MAX = 30;

function _esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Rule configuration dialog for a Text Scan group.
 * Lets the user tweak split/capture rules and see a live preview of the
 * resulting table entries before applying them to the scanner.
 */
export class TextScanRuleDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @type {Map<string, TextScanRuleDialog>} one open dialog per group */
  static _instances = new Map();

  /**
   * @param {{ group: TextScanGroup, regionItems: object[][], onApply: Function }} opts
   */
  static open(opts) {
    const existing = TextScanRuleDialog._instances.get(opts.group.id);
    if (existing) {
      if (typeof existing.bringToTop === "function" && existing.rendered) {
        existing.bringToTop();
        return existing;
      }
      // Stale or failed instance — evict and reopen.
      TextScanRuleDialog._instances.delete(opts.group.id);
      try { existing.close(); } catch (_) { /* already gone */ }
    }
    const inst = new TextScanRuleDialog(opts);
    TextScanRuleDialog._instances.set(opts.group.id, inst);
    inst.render(true);
    return inst;
  }

  constructor({ group, regionItems, onApply }) {
    super({});
    this._group       = group;
    this._regionItems = regionItems;   // PDFTextItem[][] — one array per region
    this._onApply     = onApply;       // callback(updatedGroup)
    this._rules       = foundry.utils.deepClone(group.rules ?? TextScanParser.defaultRules());
    this._parseResult = null;          // cached TextScanParser.parse() result
    this._reparse();
  }

  static DEFAULT_OPTIONS = {
    classes: ["dynamic-table-manager", "dtm-ts-dialog"],
    tag: "div",
    window: { title: "Text Scan Rules", icon: "fas fa-code", resizable: true },
    position: { width: 760, height: 640 },
    actions: {
      apply:  TextScanRuleDialog.#onApply,
      cancel: TextScanRuleDialog.#onCancel
    }
  };

  static PARTS = {
    dialog: { template: "modules/dynamic-table-manager/templates/text-scan-rule-dialog.hbs" }
  };

  get id()    { return `dtm-ts-rules-${this._group.id}`; }
  get title() { return `Text Scan Rules — ${this._group.name}`; }

  // ─────────────────────────────────────────────────────────────────────────
  //  Parsing
  // ─────────────────────────────────────────────────────────────────────────

  _reparse() {
    try {
      this._parseResult = TextScanParser.parse(this._regionItems, this._rules);
    } catch (err) {
      console.warn("DTM TextScanRuleDialog: parse error", err);
      this._parseResult = { entries: [], rawText: "" };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Context
  // ─────────────────────────────────────────────────────────────────────────

  async _prepareContext() {
    const r = this._rules;
    const previewHtml = this._buildPreviewHtml();

    return {
      groupName:    this._group.name,
      rawText:      this._parseResult?.rawText ?? "",
      entryCount:   this._parseResult?.entries.length ?? 0,
      previewHtml,

      // Split mode
      splitFont:        r.splitMode === "font",
      splitColon:       r.splitMode === "colon-prefix",
      splitRegex:       r.splitMode === "regex",
      splitPattern:     r.splitPattern ?? "",

      // Name capture
      nameBeforeColon:  r.nameCapture === "before-colon",
      nameFull:         r.nameCapture === "full",
      nameRegex:        r.nameCapture === "regex",
      namePattern:      r.namePattern ?? "",
      nameGroup:        r.nameGroup ?? 1,

      // Description capture
      descAfterColon:   r.descCapture === "after-colon",
      descRest:         r.descCapture === "rest",
      descFull:         r.descCapture === "full",
      descNone:         r.descCapture === "none",
      descRegex:        r.descCapture === "regex",
      descPattern:      r.descPattern ?? "",
      descGroup:        r.descGroup ?? 1,

      // Strip
      stripPatterns:    (r.stripPatterns ?? []).join(", ")
    };
  }

  _buildPreviewHtml() {
    const entries = this._parseResult?.entries ?? [];
    if (!entries.length) return `<div class="dtm-ts-preview-empty">No entries parsed yet.</div>`;

    const rows = entries.slice(0, PREVIEW_MAX).map(e => `
      <div class="dtm-ts-preview-row">
        <span class="dtm-ts-preview-name">${_esc(e.name)}</span>
        <span class="dtm-ts-preview-desc">${_esc(e.description)}</span>
      </div>`).join("");

    const more = entries.length > PREVIEW_MAX
      ? `<div class="dtm-ts-preview-more">… and ${entries.length - PREVIEW_MAX} more</div>`
      : "";

    return `<div class="dtm-ts-preview-header">
      <span>Name</span><span>Description</span>
    </div>${rows}${more}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Render lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  _onRender(_context, _options) {
    const html = this.element;
    html.addEventListener("change", ev => this._onFieldChange(ev));
    html.addEventListener("input",  ev => this._onFieldInput(ev));
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Field change handling
  // ─────────────────────────────────────────────────────────────────────────

  _onFieldChange(ev) {
    const t = ev.target;
    const field = t.dataset.field;
    if (!field) return;
    this._applyField(field, t.value, t.type === "radio" ? t.checked : undefined);
    this._reparse();
    this._updatePreview();
    this._updateCount();
  }

  // Debounce free-text input fields to avoid re-parsing on every keystroke.
  _onFieldInput(ev) {
    const t = ev.target;
    const field = t.dataset.field;
    if (!field) return;
    clearTimeout(this._inputTimer);
    this._inputTimer = setTimeout(() => {
      this._applyField(field, t.value);
      this._reparse();
      this._updatePreview();
      this._updateCount();
    }, 300);
  }

  _applyField(field, value, checked) {
    switch (field) {
      case "splitMode":     if (checked !== false) this._rules.splitMode    = value; break;
      case "splitPattern":  this._rules.splitPattern  = value; break;
      case "nameCapture":   if (checked !== false) this._rules.nameCapture  = value; break;
      case "namePattern":   this._rules.namePattern   = value; break;
      case "nameGroup":     this._rules.nameGroup      = parseInt(value) || 1; break;
      case "descCapture":   if (checked !== false) this._rules.descCapture  = value; break;
      case "descPattern":   this._rules.descPattern   = value; break;
      case "descGroup":     this._rules.descGroup      = parseInt(value) || 1; break;
      case "stripPatterns":
        this._rules.stripPatterns = value.split(",")
          .map(s => s.trim())
          .filter(Boolean);
        break;
    }
  }

  _updatePreview() {
    const container = this.element?.querySelector(".dtm-ts-preview");
    if (container) container.innerHTML = this._buildPreviewHtml();
  }

  _updateCount() {
    const badge = this.element?.querySelector(".dtm-ts-entry-count");
    if (badge) badge.textContent = `${this._parseResult?.entries.length ?? 0} entries`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Actions
  // ─────────────────────────────────────────────────────────────────────────

  static #onApply() {
    const updated = {
      ...this._group,
      rules: foundry.utils.deepClone(this._rules),
      parsed: this._buildParsed()
    };
    this._onApply(updated);
    this.close();
  }

  static #onCancel() { this.close(); }

  _buildParsed() {
    const entries = this._parseResult?.entries ?? [];
    if (!entries.length) return null;
    return {
      isMultiColumn: false,
      formula: `1d${entries.length}`,
      entries: entries.map((e, i) => ({
        low: i + 1, high: i + 1, name: e.name, description: e.description
      }))
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Cleanup
  // ─────────────────────────────────────────────────────────────────────────

  _onClose() {
    TextScanRuleDialog._instances.delete(this._group.id);
  }
}
