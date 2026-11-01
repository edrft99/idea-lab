import { Detail } from "@/components/ideas/detail";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <Detail key={id} id={id} />;
}
