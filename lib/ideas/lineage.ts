import { AppError } from "./errors";
type Entry = { id: string; canonicalIdeaId: string | null };
export function canonicalLineage(records: Entry[]) {
  const children = new Map<string, string[]>();
  for (const i of records)
    if (i.canonicalIdeaId) {
      const entries = children.get(i.canonicalIdeaId) ?? [];
      entries.push(i.id);
      children.set(i.canonicalIdeaId, entries);
    }
  for (const values of children.values()) values.sort();
  return (root: string, limit = 100) => {
    const seen = new Set<string>(),
      queue = [root],
      ids: string[] = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const id = queue[cursor];
      if (seen.has(id))
        throw new AppError(
          "CANONICAL_LINEAGE_INVALID",
          "The canonical lineage contains a cycle or duplicate record. Inspect it in Notion.",
          503,
        );
      seen.add(id);
      ids.push(id);
      if (ids.length > limit)
        throw new AppError(
          "CANONICAL_LINEAGE_LIMIT",
          "This canonical lineage is too large for the bounded history view. Open Notion for the complete history.",
          503,
        );
      queue.push(...(children.get(id) ?? []));
    }
    return ids;
  };
}
export const lineageIds = (root: string, records: Entry[], limit = 100) =>
  canonicalLineage(records)(root, limit);
