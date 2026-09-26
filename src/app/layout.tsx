import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Handoff Board",
  description: "Synthetic nursing shift handoff demonstration",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
