import { useEffect, useState } from "react";
import { storageGet, storageSet } from "./hooks";

/** UI preferences kept in this browser or app (Settings writes them, the workspace reads them). */
export const PREF = {
  editor: "opensession.editor",
  accent: "opensession.accent",
  codeFont: "opensession.codeFont",
  openTerminal: "opensession.openTerminal",
  notifyCi: "opensession.notifyCi",
} as const;

/** The default model ("provider/model") and the chosen effort per model; the composer reads and changes them too. */
export const MODEL_KEY = "opensession.model";
export const VARIANT_KEY = "opensession.variant";

export interface EditorPrefs {
  fontSize: number;
  lineNumbers: boolean;
  wrap: boolean;
}
export const EDITOR_DEFAULTS: EditorPrefs = { fontSize: 12, lineNumbers: true, wrap: false };

const EVENT = "opensession:pref";

export function readPref<T>(key: string, fallback: T): T {
  try {
    const v = storageGet(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function writePref<T>(key: string, value: T) {
  storageSet(key, JSON.stringify(value));
  globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: key }));
}

/** A preference as state; every component using the same key updates when one changes it. */
export function usePref<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, fallback));
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === key) setValue(readPref(key, fallback));
    };
    globalThis.addEventListener?.(EVENT, on);
    return () => globalThis.removeEventListener?.(EVENT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [
    value,
    (v: T) => {
      setValue(v);
      writePref(key, v);
    },
  ];
}
