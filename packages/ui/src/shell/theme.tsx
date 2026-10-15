import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@opensession/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@opensession/ui/components/tooltip";
import { storageGet, storageSet } from "../hooks";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "opensession.theme";
const QUERY = "(prefers-color-scheme: dark)";

function apply(choice: ThemeChoice) {
  const dark = choice === "dark" || (choice === "system" && globalThis.matchMedia?.(QUERY).matches);
  document.documentElement.classList.toggle("dark", Boolean(dark));
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

/** Dark or light following the OS unless the user picked one; keeps <html class="dark"> in sync. */
export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => (storageGet(KEY) as ThemeChoice | null) ?? "system");
  useEffect(() => {
    apply(choice);
    if (choice !== "system") return;
    const mq = globalThis.matchMedia?.(QUERY);
    const on = () => apply("system");
    mq?.addEventListener("change", on);
    return () => mq?.removeEventListener("change", on);
  }, [choice]);
  return [
    choice,
    (t) => {
      storageSet(KEY, t);
      setChoice(t);
    },
  ];
}

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: "dark", dark: "light", light: "system" };
const ICON = { system: Monitor, dark: Moon, light: Sun };

/** One button cycling System → Dark → Light. */
export function ThemeToggle() {
  const [choice, setChoice] = useTheme();
  const Icon = ICON[choice];
  return (
    <Tooltip>
      <TooltipTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Theme: ${choice}`} onClick={() => setChoice(NEXT[choice])} />}>
        <Icon />
      </TooltipTrigger>
      <TooltipContent>Theme: {choice}</TooltipContent>
    </Tooltip>
  );
}
