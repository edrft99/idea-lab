import { ProposalReview } from "@/components/proposals/workspace";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <ProposalReview id={(await params).id} />;
}
