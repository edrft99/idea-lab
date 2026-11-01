import { Suspense } from "react";
import { Explorer } from "@/components/ideas/explorer";
export default function Page() {
  return (
    <Suspense fallback={<p>Loading explorer…</p>}>
      <Explorer />
    </Suspense>
  );
}
