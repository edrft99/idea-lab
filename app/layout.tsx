import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: { default: "Idea Lab", template: "%s · Idea Lab" },
  description:
    "Your private idea workspace. Notion is the authoritative record.",
  icons: { icon: "/favicon.svg" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
