export const snapshotActions = [
  "semantic-snapshot-plan",
  "semantic-snapshot-batch",
  "semantic-snapshot-activate",
  "semantic-snapshot-discard",
] as const;
export const semanticActions = [
  "semantic-index",
  "semantic-query",
  "semantic-clear",
  ...snapshotActions,
] as const;
