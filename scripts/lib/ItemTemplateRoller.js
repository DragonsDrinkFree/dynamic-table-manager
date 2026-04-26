const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "avif"]);

const DUMMY_RESULT_NAME = "Dynamic Table: Item Template";
const DUMMY_RESULT_TEXT =
  "This result is a meta result for the Item Template table type within the " +
  "Dynamic Table Manager Module. If you are seeing this, you may need to " +
  "re-enable the Dynamic Table Manager.";

export class ItemTemplateRoller {

  /**
   * Make sure an item-template table has the structure Foundry's RollTable
   * machinery expects (a single inert TableResult covering the formula's range,
   * and `replacement: true` so native draws never mark it as drawn). Item
   * Template tables aren't really roll tables — the dummy result only exists
   * to satisfy Foundry's "do you have any results?" pre-checks. Our
   * `RollTable.prototype.draw` wrapper intercepts before the dummy is ever
   * actually rolled.
   *
   * Idempotent: safe to call any number of times. Repairs damage (missing
   * dummy, extra results, replacement turned off) by rebuilding to a known
   * good state.
   *
   * @param {RollTable} table
   * @returns {Promise<void>}
   */
  static async ensureDummyResult(table) {
    if (!table) return;
    if (!game.user?.isGM) return;  // only GMs can mutate world docs

    const updates = {};
    if (table.formula !== "1")    updates.formula = "1";
    if (table.replacement !== true) updates.replacement = true;
    if (Object.keys(updates).length) await table.update(updates);

    const results = Array.from(table.results ?? []);
    const hasOneCorrectDummy = results.length === 1
      && results[0].text === DUMMY_RESULT_TEXT
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
      text: DUMMY_RESULT_TEXT,
      range: [1, 1],
      weight: 1,
      drawn: false
    }]);
  }


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
        const resolved = await ItemTemplateRoller._resolveAttributeValue(action);
        if (resolved === null || resolved === undefined) continue;

        const value = resolved;

        if (action.writeMode === "append") {
          const existing = foundry.utils.getProperty(overrides, action.path)
            ?? foundry.utils.getProperty(baseData, action.path)
            ?? "";
          foundry.utils.setProperty(overrides, action.path,
            ItemTemplateRoller._appendValue(existing, value, action.appendMode, action.appendSeparator)
          );
        } else if (action.writeMode === "prepend") {
          const existing = foundry.utils.getProperty(overrides, action.path)
            ?? foundry.utils.getProperty(baseData, action.path)
            ?? "";
          foundry.utils.setProperty(overrides, action.path,
            ItemTemplateRoller._prependValue(existing, value, action.appendMode, action.appendSeparator)
          );
        } else if (action.writeMode === "add") {
          const addend = parseInt(value, 10);
          if (Number.isNaN(addend)) {
            console.warn(`DTM ItemTemplate: "Add (INT)" mode requires a numeric value at "${action.path}"; got "${value}". Skipping.`);
            continue;
          }
          const existingRaw = foundry.utils.getProperty(overrides, action.path)
            ?? foundry.utils.getProperty(baseData, action.path)
            ?? 0;
          const existingNum = Number(existingRaw);
          const safeBase = Number.isFinite(existingNum) ? existingNum : 0;
          foundry.utils.setProperty(overrides, action.path, safeBase + addend);
        } else {
          foundry.utils.setProperty(overrides, action.path, value);
        }
      } else if (action.type === "group") {
        await ItemTemplateRoller._evaluateActions(action.children ?? [], overrides, baseData);
      } else if (action.type === "conditional") {
        // Multi-branch format (current)
        if (action.branches) {
          const die = action.die ?? "d6";
          const roll = await new Roll(`1${die}`).evaluate();
          let executed = false;
          for (const branch of action.branches) {
            if (branch.isElse) continue;
            if (roll.total >= (branch.low ?? 1) && roll.total <= (branch.high ?? 1)) {
              await ItemTemplateRoller._evaluateActions(branch.actions ?? [], overrides, baseData);
              executed = true;
              break;
            }
          }
          if (!executed) {
            const elseBranch = action.branches.find(b => b.isElse);
            if (elseBranch) {
              await ItemTemplateRoller._evaluateActions(elseBranch.actions ?? [], overrides, baseData);
            }
          }
        } else {
          // Legacy format: condition + thenActions/elseActions
          const passes = await ItemTemplateRoller._evaluateCondition(action.condition);
          const branch = passes ? (action.thenActions ?? []) : (action.elseActions ?? []);
          await ItemTemplateRoller._evaluateActions(branch, overrides, baseData);
        }
      }
    }
  }

  static _appendValue(existing, value, appendMode, customSeparator) {
    if (!existing) return (appendMode === "list") ? `- ${value}` : value;
    switch (appendMode ?? "newline") {
      case "space":  return `${existing} ${value}`;
      case "comma":  return `${existing}, ${value}`;
      case "dash":   return `${existing} - ${value}`;
      case "colon":  return `${existing}: ${value}`;
      case "list":   return `${existing}\n- ${value}`;
      case "custom": return `${existing}${customSeparator ?? ""}${value}`;
      // "newline": emit an HTML blank line so it actually shows in rich-text
      // fields (description, notes); plain `\n\n` is invisible whitespace there.
      default:       return `${existing}<br><br>${value}`;
    }
  }

  static _prependValue(existing, value, appendMode, customSeparator) {
    if (!existing) return (appendMode === "list") ? `- ${value}` : value;
    switch (appendMode ?? "newline") {
      case "space":  return `${value} ${existing}`;
      case "comma":  return `${value}, ${existing}`;
      case "dash":   return `${value} - ${existing}`;
      case "colon":  return `${value}: ${existing}`;
      case "list":   return `- ${value}\n${existing}`;
      case "custom": return `${value}${customSeparator ?? ""}${existing}`;
      default:       return `${value}<br><br>${existing}`;
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

      const tableField = action.tableField ?? "name";
      let name, description;
      if (result.type === "text") {
        // Text-type TableResult: pull both the display text and the result's
        // own `description` field (Foundry stores them on the TableResult itself).
        name = result.value ?? "";
        description = result.description ?? "";
      } else {
        // Document-type result: name from the doc, description from the doc's system fields.
        name = result.doc?.name ?? "";
        description = ItemTemplateRoller._getDescription(result.doc);
      }

      if (tableField === "description") return description || name;     // fall back to name if no desc
      if (tableField === "both")        return ItemTemplateRoller._joinNameAndDesc(name, description);
      return name;
    }

    return null;
  }

  /**
   * Pull a description string out of a document. Tries common paths used across systems.
   * Returns the first non-empty STRING found — `??` alone is unsafe here because
   * `system.description.value` is often `""` on fresh items and we want to keep searching.
   */
  static _getDescription(doc) {
    if (!doc) return "";

    const paths = [
      "system.description.value",         // dnd5e, pf2e, swade, dsa5, most modern systems
      "system.description.short",         // some pf2e items
      "system.details.description.value",
      "system.details.biography.value",   // actor biographies
      "system.notes.value",
      "system.notes",
      "system.description",               // simple-worldbuilding style (plain string)
      "description"                       // top-level fallback
    ];

    for (const path of paths) {
      const val = foundry.utils.getProperty(doc, path);
      if (typeof val === "string" && val.trim()) return val;
    }

    console.warn(
      `DTM ItemTemplate: no description found on "${doc.name}". ` +
      `Tried: ${paths.join(", ")}. Inspect doc.system in the console to find the right path.`,
      doc
    );
    return "";
  }

  /**
   * Combine `Name` and `Description` for the "Both" table-field mode with tight spacing.
   * - If the description already starts with a block element (`<p>`, `<div>`, …), the block's
   *   own line-start handles the break — adding `<br>` would stack on top of its margin.
   * - Otherwise emit a single `<br>` so plain-text descriptions still drop to a new line.
   * Result: roughly one visible line gap regardless of whether the source is plain or HTML.
   */
  static _joinNameAndDesc(name, description) {
    if (!description) return name;
    const trimmed = description.replace(/^\s+/, "");
    const startsWithBlock = /^<(p|div|h\d|ul|ol|li|blockquote|pre|figure|table|section|article)\b/i.test(trimmed);
    const sep = startsWithBlock ? "" : "<br>";
    return `${name}:${sep}${trimmed}`;
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
   * a non-table result is reached. Text results carry along the TableResult's
   * own `description` field for use when the row is set to "Desc" or "Both".
   *
   * @param {string} tableUuid
   * @param {number} [depth=0]  guard against infinite loops
   * @returns {Promise<{type:"text",value:string,description:string}|{type:"document",doc:foundry.abstract.Document}|null>}
   */
  static async _rollTableRecursive(tableUuid, depth = 0) {
    if (depth > 20) {
      console.warn("DTM ItemTemplateRoller: recursion depth limit reached");
      return null;
    }

    const table = await fromUuid(tableUuid).catch(() => null);
    if (!(table instanceof RollTable)) return null;

    const draw = await table.draw({ displayChat: false, _dtmBypass: true });
    const result = draw.results?.[0];
    if (!result) return null;

    const resultName = result.name ?? result.text ?? "";
    const resultDesc = result.description ?? "";

    if (result.type === CONST.TABLE_RESULT_TYPES.DOCUMENT) {
      const doc = await fromUuid(result.documentUuid).catch(() => null);
      if (doc instanceof RollTable) {
        return ItemTemplateRoller._rollTableRecursive(doc.uuid, depth + 1);
      }
      return doc ? { type: "document", doc } : { type: "text", value: resultName, description: resultDesc };
    }

    return { type: "text", value: resultName, description: resultDesc };
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
