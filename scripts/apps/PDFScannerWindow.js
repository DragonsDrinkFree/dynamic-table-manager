import { TableCreator } from "../lib/TableCreator.js";
import { PDFTableExtractor } from "../lib/PDFTableExtractor.js";
import { TextScanParser } from "../lib/TextScanParser.js";
import { TextScanRuleDialog } from "./TextScanRuleDialog.js";

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

  // ---- Text scan groups ----
  #textScanGroups    = [];   // TextScanGroup[]
  #activeTextGroupId = null; // id of group that receives new text-scan regions

  // ---- Multi-page scan groups ----
  #toolboxOpen            = null; // "single" | "multi" | null — which sub-toolbar is open
  #multiPageGroups        = [];   // MultiPageGroup[]  { id, name, mode, regionIds }
  #activeMultiPageGroupId = null; // id of group that receives new multi-page regions

  // ---- Slice scan groups ----
  #sliceGroups        = [];   // SliceGroup[]  { id, name, mode, regionIds }
  #activeSliceGroupId = null; // id of group that receives new slice regions

  // ---- Group collapse state (all group types share one Set; groups expanded by default) ----
  #collapsedGroups = new Set();

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
  #createInstanceFolders = false;

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
    position: { width: 1010, height: 660 },
    actions: {
      selectPdf:             PDFScannerWindow.#onSelectPdf,
      selectSingleToolbox:   PDFScannerWindow.#onSelectSingleToolbox,
      selectMultiToolbox:    PDFScannerWindow.#onSelectMultiToolbox,
      selectSinglePage:      PDFScannerWindow.#onSelectSinglePage,
      selectMultiPage:       PDFScannerWindow.#onSelectMultiPage,
      prevPage:              PDFScannerWindow.#onPrevPage,
      nextPage:              PDFScannerWindow.#onNextPage,
      deleteRegion:          PDFScannerWindow.#onDeleteRegion,
      previewRegion:         PDFScannerWindow.#onPreviewRegion,
      createTables:          PDFScannerWindow.#onCreateTables,
      exportRecipe:          PDFScannerWindow.#onExportRecipe,
      importRecipe:          PDFScannerWindow.#onImportRecipe,
      addPrefixGroup:        PDFScannerWindow.#onAddPrefixGroup,
      newGroupInstance:      PDFScannerWindow.#onNewGroupInstance,
      activateInstance:      PDFScannerWindow.#onActivateInstance,
      toggleInstanceExpand:  PDFScannerWindow.#onToggleInstanceExpand,
      deleteInstance:        PDFScannerWindow.#onDeleteInstance,
      activateUngrouped:     PDFScannerWindow.#onActivateUngrouped,
      selectTextScan:        PDFScannerWindow.#onSelectTextScan,
      newTextScanGroup:      PDFScannerWindow.#onNewTextScanGroup,
      activateTextGroup:     PDFScannerWindow.#onActivateTextGroup,
      editGroupRules:        PDFScannerWindow.#onEditGroupRules,
      deleteTextScanGroup:   PDFScannerWindow.#onDeleteTextScanGroup,
      removeTextRegion:      PDFScannerWindow.#onRemoveTextRegion,
      activateMpGroup:       PDFScannerWindow.#onActivateMpGroup,
      deleteMpGroup:         PDFScannerWindow.#onDeleteMpGroup,
      removeMpRegion:        PDFScannerWindow.#onRemoveMpRegion,
      selectSlice:           PDFScannerWindow.#onSelectSlice,
      activateSliceGroup:    PDFScannerWindow.#onActivateSliceGroup,
      deleteSliceGroup:      PDFScannerWindow.#onDeleteSliceGroup,
      removeSliceRegion:     PDFScannerWindow.#onRemoveSliceRegion,
      toggleGroupExpand:     PDFScannerWindow.#onToggleGroupExpand,
      cancel:                PDFScannerWindow.#onCancel
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
      .filter(r => !r.instanceId && !r.textGroupId && !r.multiPageGroupId && !r.sliceGroupId)
      .map(regionView);

    // Text scan groups for context
    const textScanGroups = this.#textScanGroups.map(g => {
      const groupRegions = this.#regions
        .filter(r => r.textGroupId === g.id)
        .map(r => ({ id: r.id, page: r.page, name: r.name }));
      return {
        id:          g.id,
        name:        g.name,
        isActive:    this.#activeTextGroupId === g.id,
        isExpanded:  !this.#collapsedGroups.has(g.id),
        entryCount:  g.parsed?.entries.length ?? 0,
        hasParsed:   !!g.parsed,
        regions:     groupRegions
      };
    });

    // Multi-page scan groups
    const multiPageGroups = this.#multiPageGroups.map(g => {
      const groupRegions = g.regionIds
        .map(id => this.#regions.find(r => r.id === id))
        .filter(Boolean);
      const totalEntryCount = groupRegions.reduce((sum, r) => {
        if (!r.parsed) return sum;
        return sum + (r.parsed.isMultiColumn
          ? (r.parsed.columns?.[0]?.entries?.length ?? 0)
          : (r.parsed.entries?.length ?? 0));
      }, 0);
      return {
        id: g.id, name: g.name, mode: g.mode,
        isActive: g.id === this.#activeMultiPageGroupId,
        isExpanded: !this.#collapsedGroups.has(g.id),
        totalEntryCount,
        regions: groupRegions.map(r => ({
          id: r.id, page: r.page,
          name: r.customName ?? r.name,
          entryCount: r.parsed
            ? (r.parsed.isMultiColumn
              ? (r.parsed.columns?.[0]?.entries?.length ?? 0)
              : (r.parsed.entries?.length ?? 0))
            : 0
        }))
      };
    });

    // Slice scan groups
    const sliceGroups = this.#sliceGroups.map(g => {
      const groupRegions = g.regionIds
        .map(id => this.#regions.find(r => r.id === id))
        .filter(Boolean)
        .map(r => {
          const isImported = Array.isArray(r.parsed?.entries);
          if (isImported) {
            const ents = r.parsed.entries;
            const low  = ents[0]?.low  ?? null;
            const high = ents[ents.length - 1]?.high ?? null;
            const rangeDisplay = (low != null && high != null)
              ? (low === high ? `${low}` : `${low}-${high}`) : null;
            return { id: r.id, page: r.page, isImported: true,
                     rangeDisplay, entryCount: ents.length,
                     namePreview: r.name, hasRange: rangeDisplay != null };
          }
          const low = r.parsed?.low ?? null;
          const high = r.parsed?.high ?? null;
          const rangeDisplay = low != null
            ? (low === high ? `${low}` : `${low}-${high}`) : null;
          return { id: r.id, page: r.page, isImported: false,
                   rangeDisplay, entryCount: null,
                   namePreview: (r.parsed?.name ?? "").slice(0, 40),
                   hasRange: low != null };
        });
      return { id: g.id, name: g.name, isActive: g.id === this.#activeSliceGroupId,
               isExpanded: !this.#collapsedGroups.has(g.id),
               regions: groupRegions, regionCount: groupRegions.length };
    });

    const hasNormalContent = this.#regions.filter(r => !r.textGroupId && !r.multiPageGroupId && !r.sliceGroupId).length > 0;
    const hasMpContent     = this.#multiPageGroups.length > 0;
    const hasTsContent     = this.#textScanGroups.length > 0;
    const hasSliceContent  = this.#sliceGroups.length > 0;

    return {
      hasPdf:      !!this.#pdfDoc,
      currentPage: this.#currentPage,
      totalPages:  this.#totalPages,
      isFirstPage: this.#currentPage <= 1,
      isLastPage:  this.#currentPage >= this.#totalPages,
      selectMode:        this.#selectMode,
      toolboxOpen:       this.#toolboxOpen,
      isSelectSingleToolbox: this.#toolboxOpen === "single",
      isSelectMultiToolbox:  this.#toolboxOpen === "multi",
      isSelectSinglePage: this.#selectMode === "single",
      isSelectMultiPage:  this.#selectMode === "single-mp" || this.#selectMode === "multi-mp",
      isSelectTextScan:  this.#selectMode === "text-scan",
      isSelectSlice:     this.#selectMode === "slice",
      hasFamilies:     this.#families.length > 0,
      instances,
      ungroupedRegions,
      isUngroupedActive: this.#activeInstanceId === null,
      totalRegionCount:  this.#regions.filter(r => !r.textGroupId && !r.multiPageGroupId && !r.sliceGroupId).length,
      hasRegions:    hasNormalContent || hasTsContent || hasMpContent || hasSliceContent,
      hasAnyContent: hasNormalContent || hasTsContent || hasMpContent || hasSliceContent,
      textScanGroups,
      hasTextScanGroups: hasTsContent,
      multiPageGroups,
      hasMpGroups: hasMpContent,
      sliceGroups,
      activeRegion: activeRegion ? (() => {
        const isSlice = !!activeRegion.sliceGroupId;
        return {
          id:            activeRegion.id,
          name:          this.#resolveRoleName(activeRegion),
          isMultiColumn: !isSlice && (activeRegion.parsed?.isMultiColumn ?? false),
          columns:       !isSlice && activeRegion.parsed?.isMultiColumn
            ? activeRegion.parsed.columns.map(c => ({ header: c.header, entries: c.entries }))
            : null,
          entries: isSlice
            ? (activeRegion.parsed?.name
                ? [{ low: activeRegion.parsed.low ?? "?", high: activeRegion.parsed.high ?? "?", name: activeRegion.parsed.name }]
                : [])
            : (!activeRegion.parsed?.isMultiColumn ? (activeRegion.parsed?.entries ?? []) : null)
        };
      })() : null,
      hasRegions:    this.#regions.length > 0,
      usePrefix:     this.#usePrefix,
      tablePrefix:   this.#tablePrefix,
      makeCompound:  this.#makeCompound,
      createInstanceFolders: this.#createInstanceFolders
    };
  }

  /** @override */
  _onRender(context, options) {
    this.#attachCanvasListeners();
    this.#attachRegionListeners();
    this.#attachFooterListeners();
    this.#syncToolbar();

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
      const isActive    = region.id === this.#activeRegionId;
      const isTextScan  = region.mode === "text-scan";
      const isMpScan    = !!region.multiPageGroupId;
      const isSliceScan = !!region.sliceGroupId;
      ctx.fillStyle   = isActive    ? "rgba(100, 160, 255, 0.15)"
                      : isTextScan  ? "rgba(220, 160, 60, 0.12)"
                      : isMpScan    ? "rgba(160, 100, 220, 0.12)"
                      : isSliceScan ? "rgba(40, 180, 160, 0.12)"
                      : "rgba(100, 200, 100, 0.12)";
      ctx.strokeStyle = isActive    ? "rgba(100, 160, 255, 0.9)"
                      : isTextScan  ? "rgba(220, 160, 60, 0.85)"
                      : isMpScan    ? "rgba(160, 100, 220, 0.85)"
                      : isSliceScan ? "rgba(40, 180, 160, 0.85)"
                      : "rgba(100, 200, 100, 0.8)";
      ctx.lineWidth   = 2;
      ctx.setLineDash([]);
      ctx.fillRect(cr.x, cr.y, cr.w, cr.h);
      ctx.strokeRect(cr.x, cr.y, cr.w, cr.h);

      // Label
      ctx.fillStyle = isActive    ? "rgba(100, 160, 255, 0.9)"
                    : isTextScan  ? "rgba(220, 160, 60, 0.9)"
                    : isMpScan    ? "rgba(160, 100, 220, 0.9)"
                    : isSliceScan ? "rgba(40, 180, 160, 0.9)"
                    : "rgba(100, 200, 100, 0.9)";
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
    const folderCheck = this.element?.querySelector("[name='createInstanceFolders']");
    if (folderCheck) {
      folderCheck.addEventListener("change", () => {
        this.#createInstanceFolders = folderCheck.checked;
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
      } else if (ev.target.classList.contains("dtm-ts-group-name-input")) {
        this.#onTextGroupNameChange(ev.target);
      } else if (ev.target.classList.contains("dtm-mp-group-name-input")) {
        this.#onMpGroupNameChange(ev.target);
      } else if (ev.target.classList.contains("dtm-slice-group-name-input")) {
        this.#onSliceGroupNameChange(ev.target);
      }
    });
    // Prevent activate actions from firing when user clicks name inputs
    list.addEventListener("click", (ev) => {
      if (ev.target.classList.contains("dtm-instance-name")) ev.stopPropagation();
      if (ev.target.classList.contains("dtm-ts-group-name-input")) ev.stopPropagation();
      if (ev.target.classList.contains("dtm-mp-group-name-input")) ev.stopPropagation();
      if (ev.target.classList.contains("dtm-slice-group-name-input")) ev.stopPropagation();
    });

    // Drag ungrouped region items into slice groups
    list.addEventListener("dragstart", (ev) => {
      const item = ev.target.closest(".dtm-region-item[data-region-id]");
      if (!item) { ev.preventDefault(); return; }
      ev.dataTransfer.setData("text/plain", item.dataset.regionId);
      ev.dataTransfer.effectAllowed = "move";
    });

    list.addEventListener("dragover", (ev) => {
      const groupEl = ev.target.closest("[data-slice-group-id]");
      if (!groupEl) return;
      if (!ev.dataTransfer.types.includes("text/plain")) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      groupEl.classList.add("dtm-drag-over");
    });

    list.addEventListener("dragleave", (ev) => {
      const groupEl = ev.target.closest("[data-slice-group-id]");
      if (!groupEl || groupEl.contains(ev.relatedTarget)) return;
      groupEl.classList.remove("dtm-drag-over");
    });

    list.addEventListener("drop", (ev) => {
      const groupEl = ev.target.closest("[data-slice-group-id]");
      if (!groupEl) return;
      ev.preventDefault();
      groupEl.classList.remove("dtm-drag-over");
      const regionId = ev.dataTransfer.getData("text/plain");
      this.#onDropRegionIntoSliceGroup(regionId, groupEl.dataset.sliceGroupId);
    });
  }

  #onDropRegionIntoSliceGroup(regionId, groupId) {
    if (!regionId || !groupId) return;
    const region = this.#regions.find(r => r.id === regionId);
    const group  = this.#sliceGroups.find(g => g.id === groupId);
    if (!region || !group) return;
    if (region.instanceId || region.textGroupId || region.multiPageGroupId || region.sliceGroupId) return;
    if (region.parsed?.isMultiColumn) {
      ui.notifications.warn("Multi-column regions cannot be added to a slice group.");
      return;
    }
    if (!region.parsed?.entries?.length) return;
    region.sliceGroupId = groupId;
    group.regionIds.push(regionId);
    this.render();
  }

  #onTextGroupNameChange(input) {
    const id = input.dataset.textGroupId;
    if (!id) return;
    const group = this.#textScanGroups.find(g => g.id === id);
    if (!group) return;
    const newName = input.value.trim();
    if (!newName) { input.value = group.name; return; }
    group.name = newName;
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

    // ---- Text scan mode: store raw items, route to a scan group ----
    if (this.#selectMode === "text-scan") {
      const rawItems = await this.#extractRawItemsForRegion(this.#currentPage, pdfRect);
      const id = crypto.randomUUID();

      // Auto-create a group if there isn't an active one.
      let groupId = this.#activeTextGroupId;
      if (!groupId || !this.#textScanGroups.find(g => g.id === groupId)) {
        const newGroup = this.#makeTextScanGroup(`Text Scan ${this.#textScanGroups.length + 1}`);
        this.#textScanGroups.push(newGroup);
        groupId = newGroup.id;
        this.#activeTextGroupId = groupId;
      }

      const regionCount = this.#regions.filter(r => r.textGroupId === groupId).length;
      const name = `Region ${regionCount + 1} (p.${this.#currentPage})`;

      this.#regions.push({
        id, page: this.#currentPage, rect: pdfRect,
        name, mode: "text-scan", parsed: null,
        instanceId: null, slotIndex: null, customName: null,
        rawItems, textGroupId: groupId
      });

      this.render();
      return;
    }

    // ---- Multi-page scan mode ----
    if (this.#selectMode === "single-mp" || this.#selectMode === "multi-mp") {
      const baseMode = this.#selectMode === "single-mp" ? "single" : "multi";
      const parsed   = await this.#extractForRegion(this.#currentPage, pdfRect, baseMode);
      const id       = crypto.randomUUID();
      const name     = `Page ${this.#currentPage}`;

      this.#regions.push({
        id, page: this.#currentPage, rect: pdfRect,
        name, mode: baseMode, parsed,
        instanceId: null, slotIndex: null, customName: null,
        rawItems: null, textGroupId: null,
        multiPageGroupId: this.#activeMultiPageGroupId
      });

      const grp = this.#multiPageGroups.find(g => g.id === this.#activeMultiPageGroupId);
      grp?.regionIds.push(id);
      this.#activeRegionId = id;
      this.render();
      return;
    }

    // ---- Slice mode: per-box single-entry extraction ----
    if (this.#selectMode === "slice") {
      const page    = await this.#pdfDoc.getPage(this.#currentPage);
      const content = await page.getTextContent();
      const parsed  = PDFTableExtractor.extractSlice(content.items, pdfRect);
      const id      = crypto.randomUUID();
      const name    = `p.${this.#currentPage}`;

      this.#regions.push({
        id, page: this.#currentPage, rect: pdfRect,
        name, mode: "single", parsed,
        instanceId: null, slotIndex: null, customName: null,
        rawItems: null, textGroupId: null,
        multiPageGroupId: null, sliceGroupId: this.#activeSliceGroupId
      });

      const grp = this.#sliceGroups.find(g => g.id === this.#activeSliceGroupId);
      grp?.regionIds.push(id);
      this.#activeRegionId = id;
      this.render();
      return;
    }

    // ---- Normal single / multi col mode ----
    const mode   = this.#selectMode === "single" ? "single" : "multi";
    const parsed = await this.#extractForRegion(this.#currentPage, pdfRect, mode);

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
      instanceId, slotIndex, customName: null,
      rawItems: null, textGroupId: null
    });

    this.#activeRegionId = id;
    this.render();
  }

  async #extractRawItemsForRegion(pageNum, pdfRect) {
    const page    = await this.#pdfDoc.getPage(pageNum);
    const content = await page.getTextContent();
    return TextScanParser.filterItemsToRect(content.items, pdfRect);
  }

  #makeTextScanGroup(name) {
    return {
      id:      crypto.randomUUID(),
      name,
      rules:   TextScanParser.defaultRules(),
      parsed:  null
    };
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
      this.#textScanGroups = [];
      this.#activeTextGroupId = null;
      this.#multiPageGroups = [];
      this.#activeMultiPageGroupId = null;
      this.#sliceGroups = [];
      this.#activeSliceGroupId = null;
      this.#collapsedGroups = new Set();
      this.#toolboxOpen = null;
      await this.render();
    };
    input.click();
  }

  static #onSelectSingleToolbox() {
    if (this.#toolboxOpen === "single") {
      this.#toolboxOpen = null;
      this.#selectMode  = null;
    } else {
      this.#toolboxOpen = "single";
      if (this.#selectMode === "multi" || this.#selectMode === "multi-mp") this.#selectMode = null;
    }
    this.#currentRect = null;
    this.#syncToolbar();
  }

  static #onSelectMultiToolbox() {
    if (this.#toolboxOpen === "multi") {
      this.#toolboxOpen = null;
      this.#selectMode  = null;
    } else {
      this.#toolboxOpen = "multi";
      if (this.#selectMode === "single" || this.#selectMode === "single-mp") this.#selectMode = null;
    }
    this.#currentRect = null;
    this.#syncToolbar();
  }

  static #onSelectSinglePage() {
    if (!this.#toolboxOpen) return;
    const baseMode = this.#toolboxOpen; // "single" or "multi"
    this.#selectMode = this.#selectMode === baseMode ? null : baseMode;
    this.#currentRect = null;
    this.#syncToolbar();
  }

  static #onSelectMultiPage() {
    if (!this.#toolboxOpen) return;
    const baseMode = this.#toolboxOpen;
    const mpMode   = `${baseMode}-mp`;
    if (this.#selectMode === mpMode) {
      this.#selectMode = null;
    } else {
      this.#selectMode = mpMode;
      // Create a new group if there is no active group or the active group already has regions.
      const activeGroup = this.#multiPageGroups.find(g => g.id === this.#activeMultiPageGroupId);
      if (!activeGroup || activeGroup.regionIds.length > 0) {
        const newGroup = {
          id:        crypto.randomUUID(),
          name:      `Scan Group ${this.#multiPageGroups.length + 1}`,
          mode:      baseMode,
          regionIds: []
        };
        this.#multiPageGroups.push(newGroup);
        this.#activeMultiPageGroupId = newGroup.id;
      } else {
        activeGroup.mode = baseMode;
      }
    }
    this.#currentRect = null;
    this.#syncToolbar();
    this.render();
  }

  static #onSelectSlice() {
    if (!this.#toolboxOpen) return;
    if (this.#selectMode === "slice") {
      this.#selectMode = null;
    } else {
      this.#selectMode = "slice";
      const activeGroup = this.#sliceGroups.find(g => g.id === this.#activeSliceGroupId);
      if (!activeGroup || activeGroup.regionIds.length > 0) {
        const newGroup = {
          id:        crypto.randomUUID(),
          name:      `Slice Group ${this.#sliceGroups.length + 1}`,
          mode:      this.#toolboxOpen,
          regionIds: []
        };
        this.#sliceGroups.push(newGroup);
        this.#activeSliceGroupId = newGroup.id;
      }
    }
    this.#currentRect = null;
    this.#syncToolbar();
    this.render();
  }

  #syncToolbar() {
    const singleBtn = this.element.querySelector("[data-action='selectSingleToolbox']");
    const multiBtn  = this.element.querySelector("[data-action='selectMultiToolbox']");
    const textBtn   = this.element.querySelector("[data-action='selectTextScan']");
    singleBtn?.classList.toggle("dtm-active", this.#toolboxOpen === "single");
    multiBtn?.classList.toggle("dtm-active",  this.#toolboxOpen === "multi");
    textBtn?.classList.toggle("dtm-active",   this.#selectMode === "text-scan");

    // Sub-toolbar visibility
    const subtoolbar = this.element.querySelector(".dtm-subtoolbar");
    if (subtoolbar) subtoolbar.hidden = !this.#toolboxOpen;

    // Sub-tool button active states
    const spBtn    = this.element.querySelector("[data-action='selectSinglePage']");
    const mpBtn    = this.element.querySelector("[data-action='selectMultiPage']");
    const sliceBtn = this.element.querySelector("[data-action='selectSlice']");
    const base  = this.#toolboxOpen;
    spBtn?.classList.toggle("dtm-active", this.#selectMode === base);
    mpBtn?.classList.toggle("dtm-active", this.#selectMode === `${base}-mp`);
    sliceBtn?.classList.toggle("dtm-active", this.#selectMode === "slice");

    // Cursor
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
    const normalRegions = this.#regions.filter(r => !r.textGroupId && !r.multiPageGroupId && !r.sliceGroupId);
    const withData = normalRegions.filter(r => r.parsed &&
      (r.parsed.isMultiColumn ? r.parsed.columns[0].entries.length > 0 : r.parsed.entries.length > 0)
    );
    const groupsWithData = this.#textScanGroups.filter(g => g.parsed?.entries?.length > 0);
    const mpGroupsWithData = this.#multiPageGroups.filter(g =>
      g.regionIds.some(id => {
        const r = this.#regions.find(r => r.id === id);
        if (!r?.parsed) return false;
        return r.parsed.isMultiColumn
          ? (r.parsed.columns?.[0]?.entries?.length ?? 0) > 0
          : (r.parsed.entries?.length ?? 0) > 0;
      })
    );

    const sliceGroupsHaveData = this.#sliceGroups.some(g =>
      g.regionIds.some(id => {
        const r = this.#regions.find(r => r.id === id);
        return r?.parsed?.name?.trim();
      })
    );
    if (withData.length === 0 && groupsWithData.length === 0 && mpGroupsWithData.length === 0 && !sliceGroupsHaveData) {
      ui.notifications.warn("No regions or scan groups contain extractable table data.");
      return;
    }
    const skipped = normalRegions.length - withData.length;
    if (skipped > 0) ui.notifications.warn(`${skipped} region(s) had no data and were skipped.`);

    const makeCompound = this.#makeCompound;

    const instanceFolderIds = new Map();
    if (this.#createInstanceFolders) {
      const uniqueInstanceIds = new Set(withData.map(r => r.instanceId).filter(Boolean));
      for (const instanceId of uniqueInstanceIds) {
        const info = this.#findInstance(instanceId);
        if (!info) continue;
        const folderId = await this.#ensureInstanceFolder(info.instance.name);
        if (folderId) instanceFolderIds.set(instanceId, folderId);
      }
    }

    const allTables = [];
    for (const region of withData) {
      const tableName = this.#buildTableName(region);
      const folderId = (region.instanceId && instanceFolderIds.has(region.instanceId))
        ? instanceFolderIds.get(region.instanceId)
        : this.#folderId;
      if (region.parsed.isMultiColumn) {
        const tables = await TableCreator.createSplitTables(tableName, region.parsed, folderId, makeCompound);
        allTables.push(...tables);
      } else {
        allTables.push(await TableCreator.createSingleTable(tableName, region.parsed, folderId));
      }
    }

    // Create tables from text scan groups.
    const skippedGroups = this.#textScanGroups.length - groupsWithData.length;
    if (skippedGroups > 0 && this.#textScanGroups.length > 0) {
      ui.notifications.warn(`${skippedGroups} text scan group(s) have no parsed data — use Edit Rules first.`);
    }
    for (const group of groupsWithData) {
      const tableName = (this.#usePrefix && this.#tablePrefix.trim())
        ? `${this.#tablePrefix.trim()} ${group.name}`
        : group.name;
      allTables.push(await TableCreator.createSingleTable(tableName, group.parsed, this.#folderId));
    }

    // Create tables from multi-page scan groups.
    for (const group of mpGroupsWithData) {
      const parsedArray = group.regionIds
        .map(id => this.#regions.find(r => r.id === id)?.parsed)
        .filter(Boolean);
      const merged = PDFTableExtractor.mergeResults(parsedArray);
      if (!merged) continue;
      const tableName = (this.#usePrefix && this.#tablePrefix.trim())
        ? `${this.#tablePrefix.trim()} ${group.name}`
        : group.name;
      if (merged.isMultiColumn) {
        const tables = await TableCreator.createSplitTables(tableName, merged, this.#folderId, makeCompound);
        allTables.push(...tables);
      } else {
        allTables.push(await TableCreator.createSingleTable(tableName, merged, this.#folderId));
      }
    }

    // Create tables from slice groups.
    for (const group of this.#sliceGroups) {
      const rawEntries = [];

      for (const id of group.regionIds) {
        const r = this.#regions.find(r => r.id === id);
        if (!r?.parsed) continue;
        if (Array.isArray(r.parsed.entries)) {
          rawEntries.push(...r.parsed.entries.map(e => ({ low: e.low, high: e.high, name: e.name })));
        } else if (r.parsed.name?.trim()) {
          rawEntries.push({ low: r.parsed.low ?? null, high: r.parsed.high ?? null, name: r.parsed.name });
        }
      }

      if (!rawEntries.length) continue;

      // Sort known-low entries by value, null-low entries at end
      rawEntries.sort((a, b) => {
        if (a.low == null && b.low == null) return 0;
        if (a.low == null) return 1;
        if (b.low == null) return -1;
        return a.low - b.low;
      });

      // Auto-number null-low entries from max known high + 1
      const knownHighs = rawEntries.filter(e => e.low != null).map(e => e.high);
      let autoIndex = knownHighs.length > 0 ? Math.max(...knownHighs) + 1 : 1;
      for (const e of rawEntries) {
        if (e.low == null) { e.low = autoIndex; e.high = autoIndex; }
        autoIndex = e.high + 1;
      }

      const maxHigh = Math.max(...rawEntries.map(e => e.high));
      const formula = maxHigh > 0 ? `1d${maxHigh}` : `1d${rawEntries.length}`;
      const merged  = { isMultiColumn: false, entries: rawEntries, formula };
      const tableName = (this.#usePrefix && this.#tablePrefix.trim())
        ? `${this.#tablePrefix.trim()} ${group.name}`
        : group.name;
      allTables.push(await TableCreator.createSingleTable(tableName, merged, this.#folderId));
    }

    ui.notifications.info(`Created ${allTables.length} table(s) from PDF scan.`);
    this.close();
  }

  async #ensureInstanceFolder(name) {
    const parentId = this.#folderId ?? null;
    const existing = game.folders.find(f =>
      f.type === "RollTable" &&
      f.name === name &&
      (f.folder?.id ?? null) === parentId
    );
    if (existing) return existing.id;
    const folder = await Folder.create({ name, type: "RollTable", folder: parentId });
    return folder?.id ?? null;
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
        makeCompound: this.#makeCompound,
        createInstanceFolders: this.#createInstanceFolders
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
      this.#createInstanceFolders = !!recipe.options?.createInstanceFolders;

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

  // ---- Text scan actions ----

  static #onSelectTextScan() {
    this.#selectMode  = this.#selectMode === "text-scan" ? null : "text-scan";
    this.#toolboxOpen = null;
    this.#currentRect = null;
    this.#syncToolbar();
  }

  static #onNewTextScanGroup() {
    const group = this.#makeTextScanGroup(`Text Scan ${this.#textScanGroups.length + 1}`);
    this.#textScanGroups.push(group);
    this.#activeTextGroupId = group.id;
    this.render();
  }

  static #onActivateTextGroup(event, target) {
    const id = target.closest("[data-text-group-id]")?.dataset.textGroupId;
    if (!id) return;
    this.#activeTextGroupId = this.#activeTextGroupId === id ? null : id;
    this.render();
  }

  static #onEditGroupRules(event, target) {
    event.stopPropagation?.();
    const id = target.closest("[data-text-group-id]")?.dataset.textGroupId;
    const group = this.#textScanGroups.find(g => g.id === id);
    if (!group) return;

    const regionItems = this.#regions
      .filter(r => r.textGroupId === id)
      .map(r => r.rawItems ?? []);

    if (!regionItems.some(ri => ri.length > 0)) {
      ui.notifications.warn("No scanned regions in this group yet. Draw regions first.");
      return;
    }

    TextScanRuleDialog.open({
      group,
      regionItems,
      onApply: (updated) => {
        const idx = this.#textScanGroups.findIndex(g => g.id === updated.id);
        if (idx !== -1) this.#textScanGroups[idx] = updated;
        // Deselect after apply — next draw in Text Scan mode will start a fresh group
        this.#activeTextGroupId = null;
        this.render();
      }
    });
  }

  static async #onDeleteTextScanGroup(event, target) {
    event.stopPropagation?.();
    const id = target.closest("[data-text-group-id]")?.dataset.textGroupId;
    const group = this.#textScanGroups.find(g => g.id === id);
    if (!group) return;
    const regionCount = this.#regions.filter(r => r.textGroupId === id).length;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete Text Scan Group" },
      content: `<p>Delete "<strong>${group.name}</strong>" and its <strong>${regionCount}</strong> region(s)?</p>`,
      rejectClose: false
    });
    if (!ok) return;
    this.#regions = this.#regions.filter(r => r.textGroupId !== id);
    this.#textScanGroups = this.#textScanGroups.filter(g => g.id !== id);
    if (this.#activeTextGroupId === id) this.#activeTextGroupId = null;
    this.#redrawOverlay();
    this.render();
  }

  static #onRemoveTextRegion(event, target) {
    event.stopPropagation?.();
    const regionId = target.dataset.regionId;
    if (!regionId) return;
    this.#regions = this.#regions.filter(r => r.id !== regionId);
    this.#redrawOverlay();
    this.render();
  }

  // ---- Multi-page group actions ----

  #onMpGroupNameChange(input) {
    const id = input.dataset.mpGroupId;
    if (!id) return;
    const group = this.#multiPageGroups.find(g => g.id === id);
    if (!group) return;
    const newName = input.value.trim();
    if (!newName) { input.value = group.name; return; }
    group.name = newName;
  }

  #onSliceGroupNameChange(input) {
    const id = input.dataset.sliceGroupId;
    if (!id) return;
    const group = this.#sliceGroups.find(g => g.id === id);
    if (!group) return;
    const newName = input.value.trim();
    if (!newName) { input.value = group.name; return; }
    group.name = newName;
  }

  static #onActivateMpGroup(event, target) {
    const id = target.closest("[data-mp-group-id]")?.dataset.mpGroupId;
    const group = this.#multiPageGroups.find(g => g.id === id);
    if (!group) return;

    const alreadyActive = this.#activeMultiPageGroupId === id
      && (this.#selectMode === "single-mp" || this.#selectMode === "multi-mp");

    if (alreadyActive) {
      this.#activeMultiPageGroupId = null;
      this.#selectMode  = null;
      this.#toolboxOpen = null;
    } else {
      this.#activeMultiPageGroupId = id;
      this.#toolboxOpen = group.mode;
      this.#selectMode  = `${group.mode}-mp`;
    }
    this.#currentRect = null;
    this.#syncToolbar();
    this.render();
  }

  static async #onDeleteMpGroup(event, target) {
    event.stopPropagation?.();
    const id = target.closest("[data-mp-group-id]")?.dataset.mpGroupId;
    const group = this.#multiPageGroups.find(g => g.id === id);
    if (!group) return;
    const regionCount = group.regionIds.length;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete Scan Group" },
      content: `<p>Delete "<strong>${group.name}</strong>" and its <strong>${regionCount}</strong> region(s)?</p>`,
      rejectClose: false
    });
    if (!ok) return;
    this.#regions = this.#regions.filter(r => !group.regionIds.includes(r.id));
    this.#multiPageGroups = this.#multiPageGroups.filter(g => g.id !== id);
    if (this.#activeMultiPageGroupId === id) {
      this.#activeMultiPageGroupId = null;
      if (this.#selectMode === "single-mp" || this.#selectMode === "multi-mp") {
        this.#selectMode = null;
      }
    }
    if (this.#activeRegionId && !this.#regions.find(r => r.id === this.#activeRegionId)) {
      this.#activeRegionId = null;
    }
    this.#redrawOverlay();
    this.render();
  }

  static #onRemoveMpRegion(event, target) {
    event.stopPropagation?.();
    const regionId = target.dataset.regionId;
    if (!regionId) return;
    const region = this.#regions.find(r => r.id === regionId);
    if (!region?.multiPageGroupId) return;
    const group = this.#multiPageGroups.find(g => g.id === region.multiPageGroupId);
    if (group) group.regionIds = group.regionIds.filter(id => id !== regionId);
    this.#regions = this.#regions.filter(r => r.id !== regionId);
    if (this.#activeRegionId === regionId) this.#activeRegionId = null;
    this.#redrawOverlay();
    this.render();
  }

  // ---- Slice group actions ----

  static #onActivateSliceGroup(event, target) {
    const id = target.closest("[data-slice-group-id]")?.dataset.sliceGroupId;
    const group = this.#sliceGroups.find(g => g.id === id);
    if (!group) return;

    const alreadyActive = this.#activeSliceGroupId === id && this.#selectMode === "slice";
    if (alreadyActive) {
      this.#activeSliceGroupId = null;
      this.#selectMode  = null;
      this.#toolboxOpen = null;
    } else {
      this.#activeSliceGroupId = id;
      this.#toolboxOpen = group.mode ?? "single";
      this.#selectMode  = "slice";
    }
    this.#currentRect = null;
    this.#syncToolbar();
    this.render();
  }

  static async #onDeleteSliceGroup(event, target) {
    event.stopPropagation?.();
    const id = target.closest("[data-slice-group-id]")?.dataset.sliceGroupId;
    const group = this.#sliceGroups.find(g => g.id === id);
    if (!group) return;
    const regionCount = group.regionIds.length;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Delete Slice Group" },
      content: `<p>Delete "<strong>${group.name}</strong>" and its <strong>${regionCount}</strong> slice(s)?</p>`,
      rejectClose: false
    });
    if (!ok) return;
    this.#regions = this.#regions.filter(r => !group.regionIds.includes(r.id));
    this.#sliceGroups = this.#sliceGroups.filter(g => g.id !== id);
    if (this.#activeSliceGroupId === id) {
      this.#activeSliceGroupId = null;
      if (this.#selectMode === "slice") this.#selectMode = null;
    }
    if (this.#activeRegionId && !this.#regions.find(r => r.id === this.#activeRegionId)) {
      this.#activeRegionId = null;
    }
    this.#redrawOverlay();
    this.render();
  }

  static #onRemoveSliceRegion(event, target) {
    event.stopPropagation?.();
    const regionId = target.dataset.regionId;
    if (!regionId) return;
    const region = this.#regions.find(r => r.id === regionId);
    if (!region?.sliceGroupId) return;
    const group = this.#sliceGroups.find(g => g.id === region.sliceGroupId);
    if (Array.isArray(region.parsed?.entries)) {
      // Imported normal region — unlink only, return to ungrouped
      region.sliceGroupId = null;
      if (group) group.regionIds = group.regionIds.filter(id => id !== regionId);
    } else {
      // Slice-drawn region — delete entirely
      if (group) group.regionIds = group.regionIds.filter(id => id !== regionId);
      this.#regions = this.#regions.filter(r => r.id !== regionId);
    }
    if (this.#activeRegionId === regionId) this.#activeRegionId = null;
    this.#redrawOverlay();
    this.render();
  }

  static #onToggleGroupExpand(event, target) {
    event.stopPropagation?.();
    const id = target.dataset.groupId;
    if (!id) return;
    if (this.#collapsedGroups.has(id)) this.#collapsedGroups.delete(id);
    else this.#collapsedGroups.add(id);
    this.render();
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
