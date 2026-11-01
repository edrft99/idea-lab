import {
  MAX_FILE_BYTES,
  MAX_TURNS,
  type ParsedImport,
  type Conversation,
  type Turn,
} from "./model";
type Obj = Record<string, any>;
function obj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function id(v: unknown, label: string): string {
  if (typeof v !== "string" || !v || v.length > 300)
    throw new Error("Missing or unsupported " + label + ".");
  return v;
}
function date(v: unknown) {
  const n =
    typeof v === "number"
      ? v * 1000
      : typeof v === "string"
        ? Date.parse(v)
        : NaN;
  return Number.isFinite(n) && Math.abs(n) < 8640000000000000
    ? new Date(n).toISOString()
    : null;
}
function safeUrl(v: unknown) {
  try {
    const u = new URL(String(v));
    return ["https:", "http:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
function textBlocks(v: unknown, types: string[]): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return v
    .filter(
      (p) => obj(p) && types.includes(p.type) && typeof p.text === "string",
    )
    .map((p) => p.text)
    .join("\n");
}
function bounded(turns: Turn[]) {
  if (turns.length > MAX_TURNS)
    throw new Error(
      "Too many turns. Split the export into smaller selected files.",
    );
  if (turns.some((t) => t.text.length > 200000))
    throw new Error("A turn is too large. Export a smaller excerpt.");
}
export function parseImport(
  raw: string,
  format: "chatgpt" | "claude" | "codex",
): ParsedImport {
  if (new TextEncoder().encode(raw).byteLength > MAX_FILE_BYTES)
    throw new Error("Choose a file smaller than 10 MB.");
  if (!raw.trim()) throw new Error("The selected file is empty.");
  try {
    return format === "chatgpt" ? chatgpt(JSON.parse(raw)) : jsonl(raw, format);
  } catch (e) {
    if (e instanceof SyntaxError)
      throw new Error(
        "Invalid JSON. Choose a supported JSON export or JSONL session.",
      );
    throw e;
  }
}
function chatgpt(raw: unknown): ParsedImport {
  const rows = Array.isArray(raw)
    ? raw
    : obj(raw) && Array.isArray(raw.conversations)
      ? raw.conversations
      : obj(raw) && obj(raw.mapping)
        ? [raw]
        : null;
  if (!rows || rows.length > 1000)
    throw new Error(
      "Unsupported ChatGPT export. Expected a conversation array with message mappings.",
    );
  const conversations: Conversation[] = [],
    warnings: string[] = [];
  let ignored = 0,
    total = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    if (!obj(row) || !obj(row.mapping))
      throw new Error("A conversation has no supported message mapping.");
    const cid = id(row.id ?? row.conversation_id, "conversation ID");
    if (seen.has(cid))
      throw new Error("Duplicate conversation IDs in the export.");
    seen.add(cid);
    const entries = Object.entries(row.mapping);
    if (entries.length > MAX_TURNS)
      throw new Error("Conversation mapping exceeds the turn limit.");
    const turns: Turn[] = [];
    const graph = new Map<
      string,
      { parent: string | null; children: string[] }
    >();
    const messageIds = new Set<string>();
    for (const [nodeId, n] of entries) {
      if (!obj(n)) throw new Error("Invalid conversation node.");
      graph.set(nodeId, {
        parent: typeof n.parent === "string" ? n.parent : null,
        children: [],
      });
      const m = n.message;
      if (!obj(m)) {
        ignored++;
        continue;
      }
      const role = m.author?.role;
      if (
        !["user", "assistant"].includes(role) ||
        m.metadata?.is_visually_hidden_from_conversation
      ) {
        ignored++;
        continue;
      }
      const content = m.content;
      if (
        !obj(content) ||
        !["text", "multimodal_text"].includes(content.content_type) ||
        !Array.isArray(content.parts)
      ) {
        ignored++;
        continue;
      }
      const text = content.parts
        .filter((p: unknown) => typeof p === "string")
        .join("\n")
        .trim();
      if (content.parts.some((p: unknown) => typeof p !== "string")) ignored++;
      if (!text) {
        ignored++;
        continue;
      }
      const mid = id(m.id ?? nodeId, "message ID");
      if (messageIds.has(mid))
        throw new Error("Duplicate message IDs in a conversation.");
      messageIds.add(mid);
      turns.push({
        id: nodeId,
        messageId: mid,
        parentId: typeof n.parent === "string" ? n.parent : null,
        role,
        text,
        date: date(m.create_time),
      });
    }
    for (const [nodeId, n] of graph) {
      if (n.parent) {
        const parent = graph.get(n.parent);
        if (!parent) throw new Error("A branch references a missing parent.");
        parent.children.push(nodeId);
      }
    }
    const checked = new Set<string>();
    for (const [key] of graph) {
      let cursor: string | null = key;
      const visited = new Set<string>();
      while (cursor && !checked.has(cursor)) {
        if (visited.has(cursor)) throw new Error("Cyclic conversation branch.");
        visited.add(cursor);
        cursor = graph.get(cursor)?.parent ?? null;
      }
      for (const key of visited) checked.add(key);
    }
    let pathBudget = 0;
    function ancestry(nodeId: string): string[] {
      const chain: string[] = [];
      let cursor: string | null = nodeId;
      while (cursor) {
        if (++pathBudget > 200000 || chain.length > 4096)
          throw new Error(
            "Conversation branches are too deep or numerous. Choose a smaller excerpt.",
          );
        chain.push(cursor);
        cursor = graph.get(cursor)?.parent ?? null;
      }
      return chain.reverse();
    }
    const turnIds = new Set(turns.map((t) => t.id)),
      leaves = [...graph].filter(([, n]) => !n.children.length);
    if (leaves.length > 1000)
      throw new Error("Too many branches. Choose a smaller export.");
    const current =
      typeof row.current_node === "string" ? row.current_node : null;
    const branches = leaves.map(([key], index) => ({
      id: key,
      label: "Branch " + (index + 1),
      turnIds: ancestry(key).filter((t) => turnIds.has(t)),
      current: !!current && ancestry(key).includes(current),
    }));
    bounded(turns);
    total += turns.length;
    if (total > MAX_TURNS)
      throw new Error(
        "Export exceeds the turn limit. Select fewer conversations.",
      );
    if (turns.length)
      conversations.push({
        id: cid,
        title:
          typeof row.title === "string"
            ? row.title.slice(0, 200)
            : "Untitled conversation",
        system: "ChatGPT",
        url: safeUrl(row.url),
        adapterVersion: "chatgpt-mapping-v1",
        turns,
        branches,
      });
  }
  if (ignored)
    warnings.push(
      "Skipped " +
        ignored +
        " non-text, hidden, metadata or tool records. Attachments are not imported.",
    );
  if (!conversations.length)
    throw new Error("No supported user or assistant text was found.");
  return { conversations, warnings, ignored };
}
function jsonl(raw: string, format: "claude" | "codex"): ParsedImport {
  const lines = raw.split(/\r?\n/);
  if (lines.length > 50000)
    throw new Error("Too many JSONL records. Split the selected session.");
  const rows: { row: Obj; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      const r: unknown = JSON.parse(lines[i]);
      if (!obj(r)) throw new Error();
      rows.push({ row: r, line: i + 1 });
    } catch {
      throw new Error(
        "Invalid JSONL record at line " + (i + 1) + ". No records were staged.",
      );
    }
  }
  const groups = new Map<string, Conversation>(),
    warnings: string[] = [];
  let ignored = 0,
    session: string | null = null,
    positional = false;
  function group(cid: string) {
    let c = groups.get(cid);
    if (!c) {
      c = {
        id: cid,
        title: (format === "claude" ? "Claude Code" : "Codex") + " session",
        system: format === "claude" ? "Claude Code" : "Codex",
        url: null,
        adapterVersion: format + "-jsonl-v1",
        turns: [],
        branches: [],
      };
      groups.set(cid, c);
    }
    return c;
  }
  for (const { row: r, line } of rows) {
    if (format === "codex" && r.type === "session_meta") {
      session = id(r.payload?.id ?? r.payload?.session_id, "Codex session ID");
      continue;
    }
    let role: unknown,
      text = "",
      mid: string,
      cid: string,
      parentId: string | null = null;
    if (format === "claude") {
      if (!["user", "assistant"].includes(r.type) || r.isMeta) {
        ignored++;
        continue;
      }
      role = r.message?.role ?? r.type;
      if (role !== r.type) {
        ignored++;
        continue;
      }
      cid = id(r.sessionId, "Claude Code session ID");
      mid = id(r.uuid, "Claude Code message UUID");
      text = textBlocks(r.message?.content, ["text"]).trim();
      parentId = typeof r.parentUuid === "string" ? r.parentUuid : null;
    } else {
      if (r.type !== "response_item" || r.payload?.type !== "message") {
        ignored++;
        continue;
      }
      if (!session) throw new Error("A Codex response precedes session_meta.");
      cid = session;
      role = r.payload.role;
      text = textBlocks(r.payload.content, [
        "input_text",
        "output_text",
      ]).trim();
      if (typeof r.payload.id === "string" && r.payload.id)
        mid = id(r.payload.id, "Codex message ID");
      else {
        mid = "line:" + line;
        positional = true;
      }
    }
    if (!["user", "assistant"].includes(String(role)) || !text) {
      ignored++;
      continue;
    }
    const c = group(cid),
      prior = c.turns.find((t) => t.messageId === mid);
    if (prior) {
      if (prior.text !== text || prior.role !== role)
        throw new Error("Conflicting records reuse a message ID.");
      ignored++;
      continue;
    }
    c.turns.push({
      id: mid,
      messageId: mid,
      parentId,
      role: role as "user" | "assistant",
      text,
      date: date(r.timestamp),
    });
  }
  const conversations = [...groups.values()];
  let total = 0;
  for (const c of conversations) {
    bounded(c.turns);
    total += c.turns.length;
    c.branches = [
      {
        id: "session",
        label: "Selected session order",
        turnIds: c.turns.map((t) => t.id),
        current: true,
      },
    ];
  }
  if (total > MAX_TURNS) throw new Error("Too many turns. Split the export.");
  if (!conversations.length)
    throw new Error(
      "No supported session messages. Choose a Claude Code transcript or Codex rollout, not a history/index file.",
    );
  if (ignored)
    warnings.push(
      "Skipped " +
        ignored +
        " metadata, tool, non-text or event records. Tool results and reasoning are excluded.",
    );
  if (positional)
    warnings.push(
      "Some Codex messages have no stable ID. Their original line numbers identify them: retain the original file and do not reorder its lines before reimport.",
    );
  warnings.push(
    "Local session formats are version-sensitive. Only the displayed user/assistant text is supported; inspect it before selection.",
  );
  return { conversations, warnings, ignored };
}
