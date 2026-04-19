import { TableCreator } from "../lib/TableCreator.js";
import { PDFTableExtractor } from "../lib/PDFTableExtractor.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * PDF Scanner Window — lets the user open a PDF, draw bounding boxes over
 * table regions, preview the extracted data, and create RollTable documents.
 */
export class PDFScannerWindow extends HandlebarsApplicationMixin(ApplicationV2) {

  // ---- PDF state ----
  #pdfDoc       = null;
  #currentPage  = 1;
  #totalPages   = 0;
  #scale        = 1.5;
  #currentViewport = null; // pdf.js PageViewport, saved after each render
  #pdfName         = null; // original File.name from the last Select PDF pick

  // ---- Selection state ----
  // #selectMode: null = off, "single" | "multi" = drawing a region with that extraction mode.
  // The mode is captured onto the region record at finalize time, so each region
  // remembers how it should be re-extracted on import.
  #selectMode   = null;
  #dragStart    = null;    // { x, y } in canvas buffer px
  #currentRect  = null;    // rubber-band rect in canvas buffer px

  // ---- Region list ----
  #regions       = [];     // RegionRecord[]
  #activeRegionId = null;

  // ---- Group state ----
  // A "family" is an invisible container holding a shared roleTemplate and a list of "instances".
  // Each region may link to an instance via instanceId + slotIndex, or be ungrouped (both null).
  #families          = [];            // Family[]
  #activeInstanceId  = null;          // string | null (null = Ungrouped draw target)
  #expandedInstances = new Set();     // instance IDs that are expanded in the list

  // ---- Creation context ----
  #folderId      = null;

  // ---- Footer options (persist across re-renders) ----
  #usePrefix     = false;
  #tablePrefix   = "";
  #makeCompound  = true;

  // ---- pdf.js module (lazy) ----
  static #pdfjs = null;

  constructor(options = {}) {
    super(options);
    this.#folderId = options.folderId ?? null;
  }

  static DEFAULT_OPTIONS = {
    id: "dtm-pdf-scanner",
    classes: ["dynamic-table-manager", "dtm-pdf-scanner"],
    tag: "div",
    window: { title: "Scan PDF", icon: "fas fa-file-pdf", resizable: true },
    position: { width: 940, height: 660 },
    actions: {
      selectPdf:            PDFScannerWindow.#onSelectPdf,
      selectSingle:         PDFScannerWindow.#onSelectSingle,
      selectMulti:          PDFScannerWindow.#onSelectMulti,
      prevPage:             PDFScannerWindow.#onPrevPage,
      nextPage:             PDFScannerWindow.#onNextPage,
      deleteRegion:         PDFScannerWindow.#onDeleteRegion,
      previewRegion:        PDFScannerWindow.#onPreviewRegion,
      createTables:         PDFScannerWindow.#onCreateTables,
      exportRecipe:         PDFScannerWindow.#onExportRecipe,
      importRecipe:         PDFScannerWindow.#onImportRecipe,
      addPrefixGroup:       PDFScannerWindow.#onAddPrefixGroup,
      newGroupInstance:     PDFScannerWindow.#onNewGroupInstance,
      activateInstance:     PDFScannerWindow.#onActivateInstance,
      toggleInstanceExpand: PDFScannerWindow.#onToggleInstanceExpand,
      deleteInstance:       PDFScannerWindow.#onDeleteInstance,
      activateUngrouped:    PDFScannerWindow.#onActivateUngrouped,
      cancel:               PDFScannerWindow.#onCancel
    }
  };

  static PARTS = {
    scanner: {
      template: "modules/dynamic-table-manager/templates/pdf-scanner.hbs"
    }
  };

  /** @override */
  async _prepareContext() {
    const activeRegion = this.#regions.find(r => r.id === this.#activeRegionId) ?? null;

    const regionView = (r) => ({
      id:          r.id,
      name:        this.#resolveRoleName(r),
      page:        r.page,
      mode:        r.mode ?? "multi",
      isActive:    r.id === this.#activeRegionId,
      entryCount:  r.parsed
        ? (r.parsed.isMultiColumn ? r.parsed.columns[0].entries.length : r.parsed.entries.length)
        : 0,
      isOverride:  !!r.customName
    });

    const instances = [];
    for (const family of this.#families) {
      for (const instance of family.instances) {
        const regions = this.#regions
          .filter(r => r.instanceId === instance.id)
          .sort((a, b) => (a.slotIndex ?? 0) - (b.slotIndex ?? 0))
          .map(regionView);
        instances.push({
          id:         instance.id,
          name:       instance.name,
          isActive:   this.#activeInstanceId === instance.id,
          isExpanded: this.#expandedInstances.has(instance.id),
          regions
        });
      }
    }
    const ungroupedRegions = this.#regions
      .filter(r => !r.instanceId)
      .map(regionView);

    return {
      hasPdf:      !!this.#pdfDoc,
      currentPage: this.#currentPage,
      totalPages:  this.#totalPages,
      isFirstPage: this.#currentPage <= 1,
      isLastPage:  this.#currentPage >= this.#totalPages,
      selectMode:     this.#selectMode,
      isSelectSingle: this.#selectMode === "single",
      isSelectMulti:  this.#selectMode === "multi",
      hasFamilies:     this.#families.length > 0,
      instances,
      ungroupedRegions,
      isUngroupedActive: this.#activeInstanceId === null,
      totalRegionCount:  this.#regions.length,
      activeRegion: activeRegion ? {
        id:            activeRegion.id,
        name:          this.#resolveRoleName(activeRegion),
        isMultiColumn: activeRegion.parsed?.isMultiColumn ?? false,
        columns:       activeRegion.parsed?.isMultiColumn
          ? activeRegion.parsed.columns.map(c => ({
              header:  c.header,
              entries: c.entries
            }))
          : null,
        entries: !activeRegion.parsed?.isMultiColumn
          ? (activeRegion.parsed?.entries ?? [])
          : null
      } : null,
      hasRegions:    this.#regions.length > 0,
      usePrefix:     this.#usePrefix,
      tablePrefix:   this.#tablePrefix,
      makeCompound:  this.#makeCompound
    };
  }

  /** @override */
  _onRender(context, options) {
    this.#attachCanvasListeners();
    this.#attachRegionListeners();
    this.#attachFooterListeners();

    // Page jump input
    const pageInput = this.element.querySelector(".dtm-page-input");
    if (pageInput) {
      pageInput.addEventListener("change", async (ev) => {
        const val = parseInt(ev.target.value);
        if (!val || val < 1 || val > this.#totalPages) {
          ev.target.value = this.#currentPage;
          return;
        }
        this.#currentPage = val;
        await this.#renderPage(this.#currentPage);
        this.#redrawOverlay();
        this.element.querySelector("[data-action='prevPage']")?.toggleAttribute("disabled", this.#currentPage <= 1);
        this.element.querySelector("[data-action='nextPage']")?.toggleAttribute("disabled", this.#currentPage >= this.#totalPages);
        this.element.querySelector(".dtm-page-total").textContent = `/ ${this.#totalPages}`;
      });
      pageInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); }
      });
    }

    if (this.#pdfDoc) {
      // Re-render page and overlay after a re-render (e.g. region added)
      this.#renderPage(this.#currentPage).then(() => this.#redrawOverlay());
    }
  }

  // ---- pdf.js lazy loader ----

  static async #loadPdfJs() {
    if (PDFScannerWindow.#pdfjs) return PDFScannerWindow.#pdfjs;
    const lib = await import("/modules/dynamic-table-manager/scripts/lib/vendor/pdf.mjs");
    lib.GlobalWorkerOptions.workerSrc =
      "/modules/dynamic-table-manager/scripts/lib/vendor/pdf.worker.mjs";
    PDFScannerWindow.#pdfjs = lib;
    return lib;
  }

  // ---- Page rendering ----

  async #renderPage(pageNum) {
    const pdfCanvas = this.element?.querySelector("#dtm-pdf-canvas");
    const overlay   = this.element?.querySelector("#dtm-select-canvas");
    if (!pdfCanvas || !overlay || !this.#pdfDoc) return;

    const page     = await this.#pdfDoc.getPage(pageNum);
    const dpr      = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: this.#scale });
    this.#currentViewport = viewport;

    // Size pdf canvas
    pdfCanvas.width        = Math.floor(viewport.width  * dpr);
    pdfCanvas.height       = Math.floor(viewport.height * dpr);
    pdfCanvas.style.width  = `${viewport.width}px`;
    pdfCanvas.style.height = `${viewport.height}px`;

    const ctx = pdfCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Size overlay canvas to match exactly
    overlay.width        = pdfCanvas.width;
    overlay.height       = pdfCanvas.height;
    overlay.style.width  = pdfCanvas.style.width;
    overlay.style.height = pdfCanvas.style.height;
  }

  // ---- Overlay drawing ----

  #redrawOverlay() {
    const overlay = this.element?.querySelector("#dtm-select-canvas");
    if (!overlay || !this.#currentViewport) return;
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const dpr = window.devicePixelRatio || 1;

    // Confirmed regions for current page
    for (const region of this.#regions.filter(r => r.page === this.#currentPage)) {
      const cr = this.#pdfRectToCanvas(region.rect, this.#currentViewport, dpr);
      const isActive = region.id === this.#activeRegionId;
      ctx.fillStyle   = isActive ? "rgba(100, 160, 255, 0.15)" : "rgba(100, 200, 100, 0.12)";
      ctx.strokeStyle = isActive ? "rgba(100, 160, 255, 0.9)"  : "rgba(100, 200, 100, 0.8)";
      ctx.lineWidth   = 2;
      ctx.setLineDash([]);
      ctx.fillRect(cr.x, cr.y, cr.w, cr.h);
      ctx.strokeRect(cr.x, cr.y, cr.w, cr.h);

      // Label
      ctx.fillStyle = isActive ? "rgba(100, 160, 255, 0.9)" : "rgba(100, 200, 100, 0.9)";
      ctx.font = `${11 * dpr}px sans-serif`;
      ctx.fillText(region.name, cr.x + 4 * dpr, cr.y + 13 * dpr);
    }

    // Active rubber-band
    if (this.#selectMode && this.#currentRect) {
      const r = this.#currentRect;
      ctx.strokeStyle = "rgba(100, 160, 255, 0.9)";
      ctx.fillStyle   = "rgba(100, 160, 255, 0.15)";
      ctx.lineWidth   = 2;
      ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
    }
  }

  // ---- Canvas mouse listeners ----

  #attachCanvasListeners() {
    const overlay = this.element?.querySelector("#dtm-select-canvas");
    if (!overlay) return;

    overlay.addEventListener("mousedown", (ev) => {
      if (!this.#selectMode) return;
      const dpr = window.devicePixelRatio || 1;
      this.#dragStart = {
        x: ev.offsetX * (overlay.width / overlay.clientWidth),
        y: ev.offsetY * (overlay.height / overlay.clientHeight)
      };
      this.#currentRect = null;
    });

    overlay.addEventListener("mousemove", (ev) => {
      if (!this.#selectMode || !this.#dragStart) return;
      const dpr = window.devicePixelRatio || 1;
      const cx = ev.offsetX * (overlay.width / overlay.clientWidth);
      const cy = ev.offsetY * (overlay.height / overlay.clientHeight);
      this.#currentRect = normalizeRect(this.#dragStart.x, this.#dragStart.y, cx, cy);
      this.#redrawOverlay();
    });

    overlay.addEventListener("mouseup", async (ev) => {
      if (!this.#selectMode || !this.#dragStart) return;
      const rect = this.#currentRect;
      this.#dragStart   = null;
      this.#currentRect = null;
      if (rect && rect.w > 10 && rect.h > 10) {
        await this.#finalizeRegion(rect);
      } else {
        this.#redrawOverlay();
      }
    });
  }

  // ---- Footer option listeners ----

  #attachFooterListeners() {
    const prefixCheck = this.element?.querySelector("[name='usePrefix']");
    const prefixInput = this.element?.querySelector("[name='tablePrefix']");
    const compoundCheck = this.element?.querySelector("[name='makeCompound']");

    if (prefixCheck && prefixInput) {
      prefixCheck.addEventListener("change", () => {
        this.#usePrefix = prefixCheck.checked;
        prefixInput.disabled = !prefixCheck.checked;
        if (prefixCheck.checked) prefixInput.focus();
      });
      prefixInput.addEventListener("input", () => {
        this.#tablePrefix = prefixInput.value;
      });
    }
    if (compoundCheck) {
      compoundCheck.addEventListener("change", () => {
        this.#makeCompound = compoundCheck.checked;
      });
    }
  }

  // ---- Region name editing (delegated) ----

  #attachRegionListeners() {
    const list = this.element?.querySelector(".dtm-region-list");
    if (!list) return;
    list.addEventListener("change", async (ev) => {
      if (ev.target.classList.contains("dtm-region-name")) {
        await this.#onRegionNameChange(ev.target);
      } else if (ev.target.classList.contains("dtm-instance-name")) {
        this.#onInstanceNameChange(ev.target);
      }
    });
    // Prevent activate action from firing when user clicks the instance name input
    list.addEventListener("click", (ev) => {
      if (ev.target.classList.contains("dtm-instance-name")) ev.stopPropagation();
    });
  }

  async #onRegionNameChange(input) {
    const id = input.closest("[data-region-id]")?.dataset.regionId;
    const region = this.#regions.find(r => r.id === id);
    if (!region) return;
    const newName = input.value.trim();
    const prevDisplay = this.#resolveRoleName(region);

    if (!newName || newName === prevDisplay) {
      input.value = prevDisplay;
      return;
    }

    if (!region.instanceId) {
      region.name = newName;
      this.#redrawOverlay();
      return;
    }

    const info = this.#findInstance(region.instanceId);
    if (!info) { input.value = prevDisplay; return; }

    const peers = info.family.instances.filter(i => i.id !== info.instance.id).map(i => i.name);
    const peersNote = peers.length
      ? `<p>Other instances in this group: <strong>${peers.join(", ")}</strong>.</p>`
      : "";

    let choice;
    try {
      choice = await foundry.applications.api.DialogV2.wait({
        window: { title: "Rename Role" },
        content: `<p>Rename role from "<strong>${prevDisplay}</strong>" to "<strong>${newName}</strong>"?</p>
                  ${peersNote}
                  <p><em>Apply to all</em>: update the shared role template.<br>
                  <em>Only this one</em>: keep the rename as an override on this region only.</p>`,
        buttons: [
          { action: "all",   label: "Apply to all",   default: true, callback: () => "all" },
          { action: "one",   label: "Only this one",                 callback: () => "one" },
          { action: "cancel", label: "Cancel",                       callback: () => "cancel" }
        ],
        rejectClose: false
      });
    } catch { choice = "cancel"; }

    if (!choice || choice === "cancel") {
      input.value = prevDisplay;
      return;
    }

    if (choice === "all") {
      info.family.roleTemplate[region.slotIndex] = newName;
      for (const r of this.#regions) {
        if (!r.instanceId) continue;
        const rinfo = this.#findInstance(r.instanceId);
        if (rinfo?.family.id === info.family.id && r.slotIndex === region.slotIndex) {
          r.customName = null;
          r.name = newName;
        }
      }
    } else {
      region.customName = newName;
      region.name = newName;
    }
    this.#redrawOverlay();
    this.render();
  }

  #onInstanceNameChange(input) {
    const id = input.dataset.instanceId;
    if (!id) return;
    const info = this.#findInstance(id);
    if (!info) return;
    const newName = input.value.trim();
    if (!newName) { input.value = info.instance.name; return; }
    info.instance.name = newName;
    // No cached-name update needed: role is unchanged; only prefix differs.
  }

  // ---- Region finalization ----

  async #finalizeRegion(canvasRect) {
    if (!this.#currentViewport || !this.#pdfDoc) return;

    const dpr     = window.devicePixelRatio || 1;
    const pdfRect = canvasRectToPdf(canvasRect, this.#currentViewport, dpr);
    const mode    = this.#selectMode === "single" ? "single" : "multi";

    const parsed  = await this.#extractForRegion(this.#currentPage, pdfRect, mode);

    const id = crypto.randomUUID();

    let instanceId = null;
    let slotIndex  = null;
    let name       = null;

    if (this.#activeInstanceId) {
      const info = this.#findInstance(this.#activeInstanceId);
      if (info) {
        instanceId = this.#activeInstanceId;
        slotIndex  = this.#regionsInInstance(instanceId).length;
        if (slotIndex >= info.family.roleTemplate.length) {
          this.#extendRoleTemplate(info.family.id, slotIndex + 1);
        }
        name = info.family.roleTemplate[slotIndex];
        this.#expandedInstances.add(instanceId);
      }
    }
    if (name === null) name = `Table ${this.#regions.length + 1}`;

    this.#regions.push({
      id, page: this.#currentPage, rect: pdfRect, name, mode, parsed,
      instanceId, slotIndex, customName: null
    });

    this.#activeRegionId = id;
    this.render();
  }

  async #extractForRegion(pageNum, pdfRect, mode = "multi") {
    const page    = await this.#pdfDoc.getPage(pageNum);
    const content = await page.getTextContent();
    return PDFTableExtractor.extract(content.items, pdfRect, mode);
  }

  // ---- Coordinate transforms ----

  #pdfRectToCanvas(pdfRect, viewport, dpr) {
    // convertToViewportPoint handles the Y-flip (PDF bottom-left → viewport top-left).
    // Pass raw PDF coordinates directly; top of rect = pdfRect.y + pdfRect.h (larger Y in PDF space).
    const [cssX1, cssY1] = viewport.convertToViewportPoint(pdfRect.x,             pdfRect.y + pdfRect.h);
    const [cssX2, cssY2] = viewport.convertToViewportPoint(pdfRect.x + pdfRect.w, pdfRect.y);

    return {
      x: Math.min(cssX1, cssX2) * dpr,
      y: Math.min(cssY1, cssY2) * dpr,
      w: Math.abs(cssX2 - cssX1) * dpr,
      h: Math.abs(cssY2 - cssY1) * dpr
    };
  }

  // ---- Group helpers ----

  #findInstance(instanceId) {
    if (!instanceId) return null;
    for (const family of this.#families) {
      const idx = family.instances.findIndex(i => i.id === instanceId);
      if (idx !== -1) return { family, instance: family.instances[idx], indexInFamily: idx };
    }
    return null;
  }

  #regionsInInstance(instanceId) {
    return this.#regions.filter(r => r.instanceId === instanceId);
  }

  #resolveRoleName(region) {
    if (!region.instanceId) return region.name ?? "";
    if (region.customName) return region.customName;
    const info = this.#findInstance(region.instanceId);
    const slot = region.slotIndex ?? 0;
    return info?.family.roleTemplate[slot] ?? `Role ${slot + 1}`;
  }

  #buildTableName(region) {
    const global = this.#usePrefix && this.#tablePrefix.trim()
      ? this.#tablePrefix.trim() + " "
      : "";
    if (region.instanceId) {
      const info = this.#findInstance(region.instanceId);
      if (info) {
        const role = region.customName
          ?? info.family.roleTemplate[region.slotIndex]
          ?? `Role ${(region.slotIndex ?? 0) + 1}`;
        return `${global}${info.instance.name} ${role}`.trim();
      }
    }
    return `${global}${region.name}`.trim();
  }

  #extendRoleTemplate(familyId, toLength) {
    const family = this.#families.find(f => f.id === familyId);
    if (!family) return;
    while (family.roleTemplate.length < toLength) {
      family.roleTemplate.push(`Role ${family.roleTemplate.length + 1}`);
    }
  }

  async #promptForName({ title, message, placeholder = "", initial = "" }) {
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
    const html = `
      <div style="margin-bottom:8px">${esc(message)}</div>
      <input type="text" name="dtm-group-name" placeholder="${esc(placeholder)}" value="${esc(initial)}" style="width:100%" autofocus>
    `;
    try {
      const result = await foundry.applications.api.DialogV2.prompt({
        window: { title },
        content: html,
        ok: {
          label: "OK",
          callback: (_event, button) => {
            const input = button.form?.elements?.["dtm-group-name"];
            return input?.value?.trim() || null;
          }
        },
        rejectClose: false
      });
      return result || null;
    } catch {
      return null;
    }
  }

  // ---- Actions ----

  static async #onSelectPdf() {
    const input = this.element.querySelector("#dtm-pdf-file-input");
    if (!input) return;
    input.onchange = async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      this.#pdfName = file.name;
      const pdfjsLib = await PDFScannerWindow.#loadPdfJs();
      const buffer   = await file.arrayBuffer();
      this.#pdfDoc   = await pdfjsLib.getDocument({ data: buffer }).promise;
      this.#totalPages  = this.#pdfDoc.numPages;
      this.#currentPage = 1;
      this.#regions     = [];
      this.#activeRegionId = null;
      this.#families = [];
      this.#activeInstanceId = null;
      this.#expandedInstances = new Set();
      await this.render();
    };
    input.click();
  }

  static #onSelectSingle() {
    this.#selectMode = this.#selectMode === "single" ? null : "single";
    this.#currentRect = null;
    this.#syncSelectButtons();
  }

  static #onSelectMulti() {
    this.#selectMode = this.#selectMode === "multi" ? null : "multi";
    this.#currentRect = null;
    this.#syncSelectButtons();
  }

  #syncSelectButtons() {
    const single = this.element.querySelector("[data-action='selectSingle']");
    const multi  = this.element.querySelector("[data-action='selectMulti']");
    single?.classList.toggle("dtm-active", this.#selectMode === "single");
    multi?.classList.toggle("dtm-active", this.#selectMode === "multi");
    const overlay = this.element.querySelector("#dtm-select-canvas");
    if (overlay) overlay.style.cursor = this.#selectMode ? "crosshair" : "default";
  }

  static async #onPrevPage() {
    if (this.#currentPage <= 1) return;
    this.#currentPage--;
    await this.#renderPage(this.#currentPage);
    this.#redrawOverlay();
    this.#syncPageNav();
  }

  static async #onNextPage() {
    if (this.#currentPage >= this.#totalPages) return;
    this.#currentPage++;
    await this.#renderPage(this.#currentPage);
    this.#redrawOverlay();
    this.#syncPageNav();
  }

  #syncPageNav() {
    const input = this.element.querySelector(".dtm-page-input");
    if (input) input.value = this.#currentPage;
    this.element.querySelector("[data-action='prevPage']")?.toggleAttribute("disabled", this.#currentPage <= 1);
    this.element.querySelector("[data-action='nextPage']")?.toggleAttribute("disabled", this.#currentPage >= this.#totalPages);
  }

  static async #onDeleteRegion(event, target) {
    const id = target.closest("[data-region-id]")?.dataset.regionId;
    if (!id) return;
    const region = this.#regions.find(r => r.id === id);
    if (!region) return;

    if (region.instanceId) {
      const info = this.#findInstance(region.instanceId);
      const roleName = this.#resolveRoleName(region);
      let choice;
      try {
        choice = await foundry.applications.api.DialogV2.wait({
          window: { title: "Delete Region" },
          content: `<p>Delete region "<strong>${roleName}</strong>" from instance "<strong>${info?.instance.name ?? "?"}</strong>".</p>
                    <p>Also remove role "<strong>${roleName}</strong>" from the shared role template (applies to all instances in this group)?</p>`,
          buttons: [
            { action: "region",  label: "Delete region only",    default: true, callback: () => "region" },
            { action: "cascade", label: "Delete region + role",                 callback: () => "cascade" },
            { action: "cancel",  label: "Cancel",                               callback: () => "cancel" }
          ],
          rejectClose: false
        });
      } catch { choice = "cancel"; }
      if (!choice || choice === "cancel") return;

      if (choice === "cascade" && info) {
        const removedSlot = region.slotIndex;
        info.family.roleTemplate.splice(removedSlot, 1);
        // Delete target region AND any peer regions at the same slot (the role is gone)
        this.#regions = this.#regions.filter(r => {
          if (r.id === id) return false;
          if (!r.instanceId) return true;
          const rinfo = this.#findInstance(r.instanceId);
          if (rinfo?.family.id === info.family.id && r.slotIndex === removedSlot) return false;
          return true;
        });
        // Decrement slotIndex on remaining regions of the family with higher index
        for (const r of this.#regions) {
          if (!r.instanceId) continue;
          const rinfo = this.#findInstance(r.instanceId);
          if (rinfo?.family.id === info.family.id && r.slotIndex > removedSlot) {
            r.slotIndex--;
          }
        }
        // Refresh cached names for the family
        for (const r of this.#regions) {
          if (!r.instanceId) continue;
          const rinfo = this.#findInstance(r.instanceId);
          if (rinfo?.family.id === info.family.id) r.name = this.#resolveRoleName(r);
        }
      } else {
        this.#regions = this.#regions.filter(r => r.id !== id);
      }
    } else {
      this.#regions = this.#regions.filter(r => r.id !== id);
    }

    if (this.#activeRegionId === id) this.#activeRegionId = null;
    this.#redrawOverlay();
    this.render();
  }

  static #onPreviewRegion(event, target) {
    const id = target.closest("[data-region-id]")?.dataset.regionId;
    if (!id) return;
    this.#activeRegionId = this.#activeRegionId === id ? null : id;
    this.#redrawOverlay();
    this.render();
  }

  static async #onCreateTables() {
    const withData = this.#regions.filter(r => r.parsed &&
      (r.parsed.isMultiColumn ? r.parsed.columns[0].entries.length > 0 : r.parsed.entries.length > 0)
    );
    if (withData.length === 0) {
      ui.notifications.warn("No regions contain extractable table data.");
      return;
    }
    const skipped = this.#regions.length - withData.length;
    if (skipped > 0) ui.notifications.warn(`${skipped} region(s) had no data and were skipped.`);

    const makeCompound = this.#makeCompound;

    const allTables = [];
    for (const region of withData) {
      const tableName = this.#buildTableName(region);
      if (region.parsed.isMultiColumn) {
        const tables = await TableCreator.createSplitTables(tableName, region.parsed, this.#folderId, makeCompound);
        allTables.push(...tables);
      } else {
        allTables.push(await TableCreator.createSingleTable(tableName, region.parsed, this.#folderId));
      }
    }

    ui.notifications.info(`Created ${allTables.length} table(s) from PDF scan.`);
    this.close();
  }

  // ---- Group actions ----

  static async #onAddPrefixGroup() {
    const name = await this.#promptForName({
      title: "New Prefix Group",
      message: "Name the first instance of this group (e.g. Elf, Human, Fighter). You can add more instances later that share the same role names.",
      placeholder: "Elf"
    });
    if (!name) return;
    const instance = { id: crypto.randomUUID(), name };
    const family = { id: crypto.randomUUID(), roleTemplate: [], instances: [instance] };
    this.#families.push(family);
    this.#activeInstanceId = instance.id;
    this.#expandedInstances.add(instance.id);
    this.render();
  }

  static async #onNewGroupInstance() {
    let targetFamily = null;
    if (this.#activeInstanceId) {
      targetFamily = this.#findInstance(this.#activeInstanceId)?.family ?? null;
    }
    if (!targetFamily) targetFamily = this.#families[this.#families.length - 1] ?? null;
    if (!targetFamily) {
      ui.notifications.warn("Create a Prefix Group first.");
      return;
    }
    const peerNames = targetFamily.instances.map(i => i.name).join(", ");
    const name = await this.#promptForName({
      title: "New Group Instance",
      message: `Add a new instance sharing roles with: ${peerNames}.`,
      placeholder: "Dwarf"
    });
    if (!name) return;
    const instance = { id: crypto.randomUUID(), name };
    targetFamily.instances.push(instance);
    this.#activeInstanceId = instance.id;
    this.#expandedInstances.add(instance.id);
    this.render();
  }

  static #onActivateInstance(event, target) {
    const id = target.closest("[data-instance-id]")?.dataset.instanceId;
    if (!id) return;
    this.#activeInstanceId = this.#activeInstanceId === id ? null : id;
    this.#expandedInstances.add(id);
    this.render();
  }

  static #onToggleInstanceExpand(event, target) {
    event.stopPropagation?.();
    const id = target.closest("[data-instance-id]")?.dataset.instanceId;
    if (!id) return;
    if (this.#expandedInstances.has(id)) this.#expandedInstances.delete(id);
    else this.#expandedInstances.add(id);
    this.render();
  }

  static async #onDeleteInstance(event, target) {
    event.stopPropagation?.();
    const id = target.closest("[data-instance-id]")?.dataset.instanceId;
    if (!id) return;
    const info = this.#findInstance(id);
    if (!info) return;
    const regionCount = this.#regionsInInstance(id).length;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete Instance" },
      content: `<p>Delete instance "<strong>${info.instance.name}</strong>" and its <strong>${regionCount}</strong> region(s)?</p>`,
      rejectClose: false
    });
    if (!ok) return;

    this.#regions = this.#regions.filter(r => r.instanceId !== id);
    if (this.#activeRegionId && !this.#regions.find(r => r.id === this.#activeRegionId)) {
      this.#activeRegionId = null;
    }
    info.family.instances = info.family.instances.filter(i => i.id !== id);
    if (info.family.instances.length === 0) {
      this.#families = this.#families.filter(f => f.id !== info.family.id);
    }
    if (this.#activeInstanceId === id) this.#activeInstanceId = null;
    this.#expandedInstances.delete(id);
    this.#redrawOverlay();
    this.render();
  }

  static #onActivateUngrouped() {
    this.#activeInstanceId = null;
    this.render();
  }

  static async #onExportRecipe() {
    if (this.#regions.length === 0) {
      ui.notifications.warn("Draw at least one region before exporting.");
      return;
    }
    const payload = {
      schemaVersion: 2,
      kind: "dtm-pdf-scan-recipe",
      moduleVersion: game.modules.get("dynamic-table-manager")?.version ?? "unknown",
      exportedAt: new Date().toISOString(),
      note: "",
      pdf: {
        fingerprints: this.#pdfDoc?.fingerprints ?? [],
        pdfName: this.#pdfName ?? null,
        pageCount: this.#totalPages
      },
      options: {
        usePrefix: this.#usePrefix,
        tablePrefix: this.#tablePrefix,
        makeCompound: this.#makeCompound
      },
      families: this.#families.map(f => ({
        id: f.id,
        roleTemplate: [...f.roleTemplate],
        instances: f.instances.map(i => ({ id: i.id, name: i.name }))
      })),
      regions: this.#regions.map(r => ({
        name: r.name,
        page: r.page,
        mode: r.mode ?? "multi",
        rect: { x: r.rect.x, y: r.rect.y, w: r.rect.w, h: r.rect.h },
        instanceId: r.instanceId ?? null,
        slotIndex: Number.isInteger(r.slotIndex) ? r.slotIndex : null,
        customName: r.customName ?? null
      }))
    };

    const slug = (this.#pdfName || "untitled")
      .replace(/\.pdf$/i, "")
      .replace(/[^a-z0-9_-]+/gi, "_") || "untitled";
    const filename = `dtm-pdf-recipe-${slug}.json`;
    const json = JSON.stringify(payload, null, 2);

    if (typeof foundry.utils.saveDataToFile === "function") {
      foundry.utils.saveDataToFile(json, "application/json", filename);
    } else {
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }
    ui.notifications.info(`Exported recipe with ${this.#regions.length} region(s).`);
  }

  static async #onImportRecipe() {
    if (!this.#pdfDoc) {
      ui.notifications.error("Load a PDF before importing a recipe.");
      return;
    }
    const input = this.element.querySelector("#dtm-recipe-file-input");
    if (!input) return;
    input.onchange = async (ev) => {
      const file = ev.target.files?.[0];
      ev.target.value = "";
      if (!file) return;

      let recipe;
      try { recipe = JSON.parse(await file.text()); }
      catch { return ui.notifications.error("Recipe file is not valid JSON."); }

      if (recipe?.kind !== "dtm-pdf-scan-recipe")
        return ui.notifications.error("Not a PDF scan recipe file.");
      const schema = recipe.schemaVersion;
      if (schema !== 1 && schema !== 2)
        return ui.notifications.error(`Unsupported recipe schema (v${schema}).`);
      if (!Array.isArray(recipe.regions))
        return ui.notifications.error("Recipe has no regions array.");

      const bad = recipe.regions.findIndex(r =>
        typeof r?.name !== "string" ||
        !Number.isInteger(r?.page) || r.page < 1 ||
        !r?.rect || ["x","y","w","h"].some(k => !Number.isFinite(r.rect[k]))
      );
      if (bad !== -1)
        return ui.notifications.error(`Recipe region #${bad + 1} is malformed.`);

      // v2: validate families + build ID remap
      let newFamilies = [];
      const instanceIdMap = new Map();
      if (schema === 2) {
        if (!Array.isArray(recipe.families))
          return ui.notifications.error("Recipe is missing families array.");
        for (let fi = 0; fi < recipe.families.length; fi++) {
          const f = recipe.families[fi];
          if (!f || !Array.isArray(f.roleTemplate) || !f.roleTemplate.every(s => typeof s === "string")
              || !Array.isArray(f.instances) || !f.instances.every(i => i?.id && typeof i?.name === "string")) {
            return ui.notifications.error(`Recipe family #${fi + 1} is malformed.`);
          }
        }
        newFamilies = recipe.families.map(f => {
          const newInstances = f.instances.map(i => {
            const newId = crypto.randomUUID();
            instanceIdMap.set(i.id, newId);
            return { id: newId, name: String(i.name) };
          });
          return { id: crypto.randomUUID(), roleTemplate: f.roleTemplate.map(String), instances: newInstances };
        });
        for (let i = 0; i < recipe.regions.length; i++) {
          const r = recipe.regions[i];
          if (r.instanceId != null) {
            if (!instanceIdMap.has(r.instanceId))
              return ui.notifications.error(`Recipe region #${i + 1} references an unknown instance.`);
            if (!Number.isInteger(r.slotIndex) || r.slotIndex < 0)
              return ui.notifications.error(`Recipe region #${i + 1} has an invalid slotIndex.`);
          }
        }
      }

      const loadedFps = (this.#pdfDoc.fingerprints ?? []).filter(Boolean);
      const recipeFps = (recipe.pdf?.fingerprints ?? []).filter(Boolean);
      const matches = recipeFps.some(f => loadedFps.includes(f));
      if (recipeFps.length > 0 && !matches) {
        const ok = await foundry.applications.api.DialogV2.confirm({
          window: { title: "PDF Fingerprint Mismatch" },
          content: `<p>This recipe was made from a different PDF file (fingerprint differs).</p>
                    <p>Recipe PDF: <strong>${recipe.pdf?.pdfName ?? "(unknown)"}</strong></p>
                    <p>If this is the same book from a different source, the regions may still line up. Proceed?</p>`,
          rejectClose: false
        });
        if (!ok) return;
      }

      const inRange = recipe.regions.filter(r => r.page <= this.#totalPages);
      const skipped = recipe.regions.length - inRange.length;

      this.#regions = [];
      this.#activeRegionId = null;
      this.#families = newFamilies;
      this.#activeInstanceId = null;
      this.#expandedInstances = new Set();
      this.#usePrefix    = !!recipe.options?.usePrefix;
      this.#tablePrefix  = String(recipe.options?.tablePrefix ?? "");
      this.#makeCompound = recipe.options?.makeCompound !== false;

      for (const r of inRange) {
        const rect   = { x: +r.rect.x, y: +r.rect.y, w: +r.rect.w, h: +r.rect.h };
        const mode   = r.mode === "single" ? "single" : "multi";
        const parsed = await this.#extractForRegion(r.page, rect, mode);
        const instanceId = (schema === 2 && r.instanceId != null) ? instanceIdMap.get(r.instanceId) : null;
        const slotIndex  = (instanceId != null && Number.isInteger(r.slotIndex)) ? r.slotIndex : null;
        const customName = (schema === 2 && r.customName != null) ? String(r.customName) : null;
        this.#regions.push({
          id: crypto.randomUUID(), page: r.page, rect, name: String(r.name), mode, parsed,
          instanceId, slotIndex, customName
        });
      }

      await this.render();

      if (skipped > 0)
        ui.notifications.warn(`${skipped} region(s) referenced pages beyond this PDF and were skipped.`);
      ui.notifications.info(`Imported ${this.#regions.length} region(s)${schema === 2 ? ` into ${newFamilies.reduce((n,f)=>n+f.instances.length,0)} instance(s)` : ""}.`);
    };
    input.click();
  }

  static #onCancel() { this.close(); }
}

// ---- Module-level coordinate helpers ----

function normalizeRect(x1, y1, x2, y2) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

function canvasRectToPdf(canvasRect, viewport, dpr) {
  // Canvas buffer px → CSS px
  const cssX = canvasRect.x / dpr;
  const cssY = canvasRect.y / dpr;
  const cssW = canvasRect.w / dpr;
  const cssH = canvasRect.h / dpr;

  // CSS px (viewport top-left origin) → PDF user units (bottom-left origin, Y increases upward).
  // convertToPdfPoint already handles the Y-flip via the viewport transform matrix.
  const [pdfLeft,  pdfTop]    = viewport.convertToPdfPoint(cssX,        cssY);
  const [pdfRight, pdfBottom] = viewport.convertToPdfPoint(cssX + cssW, cssY + cssH);

  // pdfTop > pdfBottom because top of canvas = high PDF Y; use min/max to get bottom-left rect.
  return {
    x: Math.min(pdfLeft,  pdfRight),
    y: Math.min(pdfTop,   pdfBottom),
    w: Math.abs(pdfRight - pdfLeft),
    h: Math.abs(pdfTop   - pdfBottom)
  };
}
