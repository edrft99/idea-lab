import { editableIdeaSchema } from "../ideas/domain";
import {
  importSourceSchema,
  type Conversation,
  type Turn,
  type Proposal,
} from "./model";
export function redact(text: string, extra: string[] = []) {
  let result = text
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|ntn_[A-Za-z0-9_-]{16,}|secret_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g,
      "[REDACTED TOKEN]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED EMAIL]")
    .replace(
      /(?:[A-Z]:\\(?:Users|Code Projects)\\[^\r\n\t"<>]+|\/(?:Users|home)\/[^\s"<>]+)/gi,
      "[REDACTED PATH]",
    );
  for (const phrase of extra.map((v) => v.trim()).filter(Boolean))
    result = result.split(phrase).join("[REDACTED]");
  return result;
}
export function suggestion(
  text: string,
): "Possible idea" | "Routine or uncertain" {
  const routine =
    /\b(error|exception|stack trace|not working|fails? to|build fail|fix this|what is|how do i|why does)\b/i.test(
      text,
    );
  return !routine &&
    /\b(idea|i (?:want|would like) to (?:build|create)|we (?:could|should) (?:build|create)|let.s (?:build|create)|a (?:tool|app|dashboard|system) (?:that|to|for))\b/i.test(
      text,
    )
    ? "Possible idea"
    : "Routine or uncertain";
}
export function makeProposal(
  conversation: Conversation,
  turn: Turn,
  evidence: string,
): Proposal {
  if (!evidence.trim() || evidence.length > 6000)
    throw new Error(
      "Shorten each selected excerpt to 1–6000 characters before staging it.",
    );
  const source = importSourceSchema.parse({
    system: conversation.system,
    conversationId: conversation.id,
    messageId: turn.messageId,
    locator:
      turn.locator ??
      conversation.system +
        ":" +
        conversation.id +
        "/message/" +
        turn.messageId,
    originalUrl: turn.originalUrl ?? conversation.url,
    ...(turn.originRevision ? { originRevision: turn.originRevision } : {}),
    conversationDate: turn.date,
    adapterVersion: conversation.adapterVersion,
    role: turn.role,
    evidence,
  });
  const title =
    evidence
      .split(/[\n.!?]/)
      .find((t) => t.trim())
      ?.trim()
      .slice(0, 200) || "Untitled idea";
  return {
    id: crypto.randomUUID(),
    source,
    decision: "draft",
    canonicalId: null,
    data: editableIdeaSchema.parse({
      title,
      summary: evidence.slice(0, 2000),
      context: "",
      category: /\b(sensor|hardware|iot|device)\b/i.test(evidence)
        ? "Hardware & IoT"
        : /\b(automat|workflow)\w*/i.test(evidence)
          ? "Automation"
          : "AI & Agents",
    }),
  };
}
