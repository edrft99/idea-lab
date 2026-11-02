import { RoundtableWorkspace } from "@/components/roundtable/workspace";
export const metadata = { title: "Idea roundtable" };
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <RoundtableWorkspace key={id} id={id} />;
}
