import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./design-system.css";

export const metadata: Metadata = {
  title: "cixtech",
  description: "Multi-tenant crypto-custody engine",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/config.js" />
      </head>
      <body>{children}</body>
    </html>
  );
}
