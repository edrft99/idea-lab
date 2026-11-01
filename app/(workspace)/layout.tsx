import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { authorizeOwner } from "@/lib/ideas/access";
import { AppError } from "@/lib/ideas/errors";
import { Shell } from "@/components/shell";
export const dynamic = "force-dynamic";
export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireChatGPTUser("/");
  try {
    await authorizeOwner();
  } catch (error) {
    if (error instanceof AppError)
      return (
        <main className="page narrow-page">
          <div className="empty-state" role="alert">
            <h1>Workspace access is restricted.</h1>
            <p>{error.message}</p>
          </div>
        </main>
      );
    throw error;
  }
  return <Shell>{children}</Shell>;
}
