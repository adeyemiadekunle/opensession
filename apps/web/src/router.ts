import { useEffect, useState } from "react";

/** Minimal path router: three pages don't need a routing library. */
export function usePath(): [string, (to: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const go = (to: string) => {
    window.history.pushState(null, "", to);
    setPath(new URL(to, window.location.origin).pathname);
  };
  return [path, go];
}
