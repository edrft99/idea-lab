import { ExistingReview } from "@/components/reviews/workspace";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ExistingReview key={id} id={id} />;
}
