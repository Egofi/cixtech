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

  // Class names here are the design system's own vocabulary (`app/design-system.css`),
  // which came over from the previous consoles unchanged. This component had been
  // inventing its own -- `navitem`, `sidefoot`, `envchip`, and a bare `<main>` --
  // none of which the stylesheet defines, so the nav links, the footer, the
  // environment badge and the content gutter all rendered unstyled. The
  // stylesheet also carries the ≤820px and print rules keyed on `.nav`,
  // `.side-foot`, `.side` and `.main`, so matching it fixes those too.
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <div className="mark">C</div>
          <div>
            <b>cixtech</b>
            <small>{brand}</small>
          </div>
        </div>

        {env ? (
          <div
            className={env === "testnet" ? "env-pill testnet" : "env-pill"}
            title="Network this deployment is pointed at"
          >
            {env}
          </div>
        ) : null}

        <nav>
          {nav.map((item) => {
            const current = here === norm(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={current ? "nav active" : "nav"}
                aria-current={current ? "page" : undefined}
              >
                {/* Decorative: the label beside it already names the destination. */}
                <span className="navicon" aria-hidden="true">
                  {item.icon}
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* `.side` is a flex column; this is what holds the footer at the bottom. */}
        <div className="spacer" />

        <div className="side-foot">
          <ThemeToggle />
          <div className="spacer" />
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main" id="main">
        {children}
      </main>
    </div>
  );
}
