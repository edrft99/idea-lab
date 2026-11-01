import type { ComponentPropsWithoutRef } from "react";

// Use browser navigation: the deployed Vinext client Link runtime currently
// throws before routing. Native anchors also work before hydration and retain
// normal modified-click, download, target, and keyboard behavior.
export default function NavigationLink(props: ComponentPropsWithoutRef<"a">) {
  return <a {...props} />;
}
