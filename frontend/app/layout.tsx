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
        {/*
          Runtime configuration, loaded before anything else.

          `/config.js` is written by the container entrypoint from
          CIXTECH_API_BASE at start-up, which is what lets ONE built image serve
          every environment. A NEXT_PUBLIC_* variable would be inlined at build
          time instead, so an image promoted from staging to production would
          still be pointing at staging.

          Plain <script src> rather than next/script: this must be evaluated
          before any component reads window.CIXTECH, and it must not be bundled.
        */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/config.js" />
      </head>
      <body>{children}</body>
    </html>
  );
}
