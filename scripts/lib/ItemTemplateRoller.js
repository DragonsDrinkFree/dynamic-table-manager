const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "avif"]);

export class ItemTemplateRoller {

  /**
   * Generate a Foundry Item from an Item Template and place it in the
   * configured output folder.
   * @param {RollTable} table
   * @returns {Promise<Item|null>}
   */
  static async generate(table) {
    const config = table.getFlag("dynamic-table-manager", "itemTemplateConfig");
    if (!config) {
      ui.notifications.warn("Item Template has no configuration yet.");
      return null;
    }
    if (!config.itemType) {
      ui.notifications.warn("Item Template: no Item Type selected.");
      return null;
    }

    // 1. Base item data
    let itemData = await ItemTemplateRoller._getBaseItemData(config.baseItem, config.itemType);

    // 2. Evaluate the action tree into an overrides object
    const overrides = {};
    await ItemTemplateRoller._evaluateActions(config.actions ?? [], overrides, itemData);

    // 3. Merge overrides onto item data
    foundry.utils.mergeObject(itemData, overrides, { overwrite: true });

    // 4. Image
    if (config.img?.mode && config.img.mode !== "none" && config.img.path) {
      const resolved = await ItemTemplateRoller._resolveImage(config.img);
      if (resolved) itemData.img = resolved;
    }

    // 5. Create item in output folder
    const createData = { ...itemData };
    if (config.outputFolderId) createData.folder = config.outputFolderId;

    const item = await Item.create(createData);
    if (item) {
      ui.notifications.info(`Generated item: ${item.name}`);
      item.sheet?.render(true);
    }
    return item;
  }

  // ---------------------------------------------------------------------------
  // Base item resolution
  // ---------------------------------------------------------------------------

  static async _getBaseItemData(baseItem, itemType) {
    const mode = baseItem?.mode ?? "none";

    if (mode === "fixed" && baseItem.uuid) {
      const doc = await fromUuid(baseItem.uuid).catch(() => null);
      if (doc instanceof Item) return foundry.utils.deepClone(doc.toObject());
    }

    if (mode === "table" && baseItem.tableUuid) {
      const result = await ItemTemplateRoller._rollTableRecursive(baseItem.tableUuid);
      if (result?.type === "document" && result.doc instanceof Item) {
        return foundry.utils.deepClone(result.doc.toObject());
      }
    }

    return { name: "Generated Item", type: itemType, system: {} };
  }

  // ---------------------------------------------------------------------------
  // Action tree evaluation
  // ---------------------------------------------------------------------------

  /**
   * Walk the action array, building up the overrides object.
   * @param {Action[]} actions
   * @param {object} overrides  mutated in place
   * @param {object} baseData   read-only base item data (for append mode)
   */
  static async _evaluateActions(actions, overrides, baseData) {
    for (const action of (actions ?? [])) {
      if (action.type === "attribute") {
        const value = await ItemTemplateRoller._resolveAttributeValue(action);
        if (value === null || value === undefined) continue;

        if (action.writeMode === "append") {
          const existing = foundry.utils.getProperty(overrides, action.path)
            ?? foundry.utils.getProperty(baseData, action.path)
            ?? "";
          const joined = existing ? `${existing}\n${value}` : value;
          foundry.utils.setProperty(overrides, action.path, joined);
        } else {
          foundry.utils.setProperty(overrides, action.path, value);
        }
      } else if (action.type === "group") {
        // Group is an organizational container; its children write to their own paths
        await ItemTemplateRoller._evaluateActions(action.children ?? [], overrides, baseData);
      } else if (action.type === "conditional") {
        const passes = await ItemTemplateRoller._evaluateCondition(action.condition);
        const branch = passes ? (action.thenActions ?? []) : (action.elseActions ?? []);
        await ItemTemplateRoller._evaluateActions(branch, overrides, baseData);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Attribute value resolution (flat model)
  // ---------------------------------------------------------------------------

  /**
   * Resolve an AttributeAction's value to a string.
   * @param {AttributeAction} action
   * @returns {Promise<string|null>}
   */
  static async _resolveAttributeValue(action) {
    if (action.sourceType === "text") {
      return action.value ?? null;
    }

    if (action.sourceType === "table") {
      if (!action.tableUuid) return null;
      const result = await ItemTemplateRoller._rollTableRecursive(action.tableUuid);
      if (!result) return null;
      if (result.type === "text") return result.value;
      if (result.type === "document") return result.doc?.name ?? null;
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Condition evaluation
  // ---------------------------------------------------------------------------

  static async _evaluateCondition(condition) {
    if (!condition) return false;

    if (condition.mode === "percent") {
      const roll = await new Roll("1d100").evaluate();
      return roll.total <= (condition.percent ?? 50);
    }

    if (condition.mode === "dice") {
      const die = condition.die ?? "d6";
      const roll = await new Roll(`1${die}`).evaluate();
      const low = condition.low ?? 1;
      const high = condition.high ?? 1;
      return roll.total >= low && roll.total <= high;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Recursive table rolling
  // ---------------------------------------------------------------------------

  /**
   * Roll a table and follow any chained RollTable documents recursively until
   * a non-table result is reached.
   * @param {string} tableUuid
   * @param {number} [depth=0]  guard against infinite loops
   * @returns {Promise<{type:"text",value:string}|{type:"document",doc:foundry.abstract.Document}|null>}
   */
  static async _rollTableRecursive(tableUuid, depth = 0) {
    if (depth > 20) {
      console.warn("DTM ItemTemplateRoller: recursion depth limit reached");
      return null;
    }

    const table = await fromUuid(tableUuid).catch(() => null);
    if (!(table instanceof RollTable)) return null;

    const draw = await table.draw({ displayChat: false });
    const result = draw.results?.[0];
    if (!result) return null;

    if (result.type === CONST.TABLE_RESULT_TYPES.DOCUMENT) {
      const doc = await fromUuid(result.documentUuid).catch(() => null);
      if (doc instanceof RollTable) {
        return ItemTemplateRoller._rollTableRecursive(doc.uuid, depth + 1);
      }
      return doc ? { type: "document", doc } : { type: "text", value: result.name ?? "" };
    }

    return { type: "text", value: result.name ?? "" };
  }

  // ---------------------------------------------------------------------------
  // Image resolution
  // ---------------------------------------------------------------------------

  static async _resolveImage(imgConfig) {
    if (imgConfig.mode === "fixed") return imgConfig.path || null;

    if (imgConfig.mode === "folder" && imgConfig.path) {
      try {
        const browser = await FilePicker.browse("user", imgConfig.path);
        const images = (browser.files ?? []).filter(f => {
          const ext = f.split(".").pop()?.toLowerCase();
          return IMAGE_EXTENSIONS.has(ext);
        });
        if (!images.length) return null;
        return images[Math.floor(Math.random() * images.length)];
      } catch (err) {
        console.warn("DTM ItemTemplateRoller: could not browse image folder", err);
        return null;
      }
    }

    return null;
  }
}
