import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { authorizeOwner } from "@/lib/ideas/access";
import { hashSchema } from "@/lib/claude-auth/model";
import { ClaudeConsent } from "@/components/claude-auth/consent";
import { Shell } from "@/components/shell";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  hashSchema.parse(id);
  return <OwnerConsent id={id} />;
}
async function OwnerConsent({ id }: { id: string }) {
  await requireChatGPTUser("/claude/connect/" + id);
  await authorizeOwner();
  return (
    <Shell>
      <ClaudeConsent id={id} />
    </Shell>
  );
}
