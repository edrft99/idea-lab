import { AIAssessment } from "@/components/intelligence/assessment";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <AIAssessment id={(await params).id} />;
}
