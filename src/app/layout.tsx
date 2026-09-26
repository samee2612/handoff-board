import type { Metadata } from "next";
import "./globals.css";
import { SyntheticDemoNotice } from "@/components/synthetic-demo-notice";

export const metadata: Metadata = {
  title: "Synthetic Handoff Board Demo",
  description: "Synthetic-only nursing shift handoff demonstration. Not for clinical use.",
  robots: { index: false, follow: false, nocache: true },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <SyntheticDemoNotice />
        {children}
      </body>
    </html>
  );
}
