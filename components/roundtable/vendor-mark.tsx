export type ReviewerId = "gpt" | "claude" | "grok" | "copilot";
export function VendorMark({ id }: { id: ReviewerId }) {
  return (
    <span className={"rt-vendor-mark rt-vendor-" + id} aria-hidden="true" />
  );
}
