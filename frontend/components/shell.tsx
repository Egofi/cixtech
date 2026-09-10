"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ThemeToggle } from "./theme-toggle";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

export function Shell({
  brand,
  env,
  nav,
  onSignOut,
  children,
}: {
  brand: string;
  env?: string | null;
  nav: readonly NavItem[];
  onSignOut: () => void;
  children: ReactNode;
}) {
  const pathname = usePathname();

  const norm = (p: string) => (p.endsWith("/") ? p : `${p}/`);
  const here = norm(pathname);

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <div className="mark">C</div>
          <div>
            <strong>cixtech</strong>
            <span className="muted"> {brand}</span>
          </div>
        </div>

        {env ? (
          <div
            className={`envchip ${env === "mainnet" ? "bad" : "warn"}`}
            title="Network this deployment is pointed at"
          >
            {env}
          </div>
        ) : null}

        <nav>
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={here === norm(item.href) ? "navitem active" : "navitem"}
            >
              <span className="navicon">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="sidefoot">
          <ThemeToggle />
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </aside>

      <main id="main">{children}</main>
    </div>
  );
}
