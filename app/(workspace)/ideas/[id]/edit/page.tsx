import { IdeaEditor } from "@/components/ideas/editor";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <IdeaEditor key={id} id={id} />;
}
