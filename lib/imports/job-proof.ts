import { commandSchema } from "../ideas/domain";
import { sha256, sourceKey, sourceRevision } from "./provenance";
import type { Proposal } from "./model";
import type { ImportJobView } from "./job-model";
// A restored file supplies draft text, never proof that that text was saved.
export async function matchesJobResult(
  item: ImportJobView["items"][number],
  proposal: Proposal,
) {
  if (
    item.status !== "done" ||
    !item.ideaId ||
    !item.payloadHash ||
    item.id !== proposal.id ||
    proposal.ai
  )
    return false;
  const parsed = commandSchema.safeParse({
    action: "create",
    data: proposal.data,
    source: proposal.source,
  });
  return (
    parsed.success &&
    (await sourceKey(proposal.source)) === item.sourceKey &&
    (await sourceRevision(proposal.source)) === item.sourceRevision &&
    (await sha256(JSON.stringify(parsed.data))) === item.payloadHash
  );
}
