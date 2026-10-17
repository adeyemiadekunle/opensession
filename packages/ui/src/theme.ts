import { storageGet, storageSet } from "./hooks";
import { PREF, readPref } from "./prefs";

export type Theme = "light" | "dark" | "system";
export type Accent = "blue" | "clay" | "teal" | "amber";
export type CodeFont = "jetbrains" | "system";

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

/** Accent color and code font, from the saved preferences (styles.css maps the attributes). */
export function applyAppearance() {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  const accent = readPref<Accent>(PREF.accent, "blue");
  if (accent === "blue") delete root.dataset.accent;
  else root.dataset.accent = accent;
  const font = readPref<CodeFont>(PREF.codeFont, "jetbrains");
  if (font === "jetbrains") delete root.dataset.codeFont;
  else root.dataset.codeFont = font;
}

/** Call once before the first render so the saved look shows without a flash. */
export function initTheme() {
  applyTheme(getTheme());
  applyAppearance();
}
