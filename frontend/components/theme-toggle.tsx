"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const KEY = "cx_theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    let stored: Theme = "system";
    try {
      stored = (window.localStorage.getItem(KEY) as Theme) ?? "system";
    } catch {}
    setTheme(stored);
    apply(stored);
  }, []);

  function apply(next: Theme) {
    const root = document.documentElement;
    if (next === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);
  }

  function cycle() {
    const order: Theme[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(theme) + 1) % order.length] as Theme;
    setTheme(next);
    apply(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {}
  }

  const icon = theme === "light" ? "☀" : theme === "dark" ? "☾" : "◐";
  // Glyph only: the label does not fit beside Sign out in the sidebar footer, and
  // `title`/`aria-label` carry the current theme for anyone who needs it named.
  const label = `Theme: ${theme}. Click to change.`;
  return (
    <button type="button" className="icon-button" onClick={cycle} title={label} aria-label={label}>
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}
