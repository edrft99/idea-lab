import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { authorizeOwner } from "@/lib/ideas/access";
import { captureId } from "@/lib/assistant-capture/model";
import { Shell } from "@/components/shell";
import { AssistantCaptureReview } from "@/components/assistant-capture/review";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  captureId.parse(id);
  await requireChatGPTUser("/capture/assistant/" + id);
  await authorizeOwner();
  return (
    <Shell>
      <AssistantCaptureReview id={id} />
    </Shell>
  );
}
