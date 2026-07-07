/**
 * Pure static utility for matching RollTable result names against a source
 * collection of documents (compendium pack or world folder).
 *
 * Three match tiers:
 *   perfect — exact name match (case/punctuation insensitive)
 *   decent  — all keywords match but different order (handles "Dragon, Silver" ↔ "Silver Dragon")
 *   loose   — at least one non-trivial keyword (≥3 chars) shared
 */
export class LinkMatcher {

  /**
   * Build SourceEntry[] from a compendium pack.
   * Calls pack.getIndex() to ensure the index is loaded.
   * @param {CompendiumCollection} pack
   * @returns {Promise<{name:string, uuid:string, img:string|null}[]>}
   */
  static async entriesFromPack(pack) {
    await pack.getIndex();
    return pack.index.contents.map(e => ({
      name: e.name,
      uuid: pack.getUuid ? pack.getUuid(e._id) : `Compendium.${pack.collection}.${e._id}`,
      img:  e.img ?? null
    }));
  }

  /**
   * Build SourceEntry[] from a world folder and all its subfolders (synchronous).
   * @param {Folder} folder
   * @returns {{name:string, uuid:string, img:string|null}[]}
   */
  static entriesFromFolder(folder) {
    // BFS: collect all folder IDs in the subtree rooted at `folder`
    const folderIds = new Set([folder.id]);
    let added = true;
    while (added) {
      added = false;
      for (const f of game.folders.contents) {
        if (!folderIds.has(f.id) && folderIds.has(f.folder?.id)) {
          folderIds.add(f.id);
          added = true;
        }
      }
    }

    const collection = {
      Actor:        game.actors,
      Item:         game.items,
      JournalEntry: game.journal
    }[folder.type];

    if (!collection) return [];

    return collection.contents
      .filter(doc => folderIds.has(doc.folder?.id))
      .map(doc => ({ name: doc.name, uuid: doc.uuid, img: doc.img ?? null }));
  }

  /**
   * Match TEXT-type results against source entries.
   * Returns one RowMatchResult per result that has at least one candidate,
   * sorted perfect → decent → loose within each row.
   *
   * @param {TableResult[]} results
   * @param {{name:string, uuid:string, img:string|null}[]} sourceEntries
   * @returns {{ resultId:string, resultName:string, candidates:{name,uuid,img,tier}[] }[]}
   */
  static match(results, sourceEntries) {
    // Precompute normalized forms once per entry/result — #scorePair runs
    // O(results × entries) times and the regex/Set work dominates otherwise.
    const prepped = sourceEntries.map(entry => ({ entry, ...LinkMatcher.#prep(entry.name) }));

    const out = [];
    for (const result of results) {
      if (result.type !== CONST.TABLE_RESULT_TYPES.TEXT) continue;
      const resultPrep = LinkMatcher.#prep(result.name);
      const buckets = { perfect: [], decent: [], loose: [] };
      for (const p of prepped) {
        const tier = LinkMatcher.#scorePair(resultPrep, p);
        if (tier) buckets[tier].push({ ...p.entry, tier });
      }
      const candidates = [...buckets.perfect, ...buckets.decent, ...buckets.loose];
      if (candidates.length) {
        out.push({ resultId: result.id, resultName: result.name, candidates });
      }
    }
    return out;
  }

  // ---- Private helpers ----

  /**
   * Precompute the normalized string and keyword Set for a name.
   */
  static #prep(name) {
    const norm = LinkMatcher.#normalize(name);
    return { norm, keywords: new Set(norm.split(" ").filter(Boolean)) };
  }

  /**
   * Return the best match tier between two prepped names, or null if no match.
   */
  static #scorePair(a, b) {
    if (a.norm === b.norm) return "perfect";
    const ka = a.keywords;
    const kb = b.keywords;
    if (ka.size > 0 && ka.size === kb.size && [...ka].every(k => kb.has(k))) return "decent";
    const shared = [...ka].filter(k => k.length >= 3 && kb.has(k));
    if (shared.length >= 1) return "loose";
    return null;
  }

  /**
   * Lowercase, strip non-alphanumeric (except spaces), collapse whitespace.
   * "Dragon, Silver" → "dragon silver"
   */
  static #normalize(s) {
    return String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .replace(/\s+/g, " ");
  }

}
