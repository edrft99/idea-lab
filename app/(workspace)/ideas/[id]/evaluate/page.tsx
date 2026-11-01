import { EvaluationWorkspace } from "@/components/evaluations/workspace";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EvaluationWorkspace key={id} id={id} />;
}
