import { AssessmentReview } from "@/components/evaluations/proposals";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <AssessmentReview id={(await params).id} />;
}
