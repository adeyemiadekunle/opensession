import { storageGet, storageSet } from "./hooks";

export type Theme = "light" | "dark" | "system";

const THEME_KEY = "opensession.theme";

export function getTheme(): Theme {
  const t = storageGet(THEME_KEY);
  return t === "light" || t === "dark" ? t : "system";
}

/** Applies a theme: light or dark is pinned on <html data-theme>; system follows the OS. */
export function setTheme(t: Theme) {
  storageSet(THEME_KEY, t);
  applyTheme(t);
}

function applyTheme(t: Theme) {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (t === "system") delete root.dataset.theme;
  else root.dataset.theme = t;
}

/** Call once before the first render so the saved theme shows without a flash. */
export function initTheme() {
  applyTheme(getTheme());
}
