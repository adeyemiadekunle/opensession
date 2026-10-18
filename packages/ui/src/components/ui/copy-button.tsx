import { useState } from "react";
import { NamedIcon } from "../../icons";
import { cn } from "../../lib/utils";

/** Hover-revealed copy icon for code and output blocks; shows a check briefly on success. */
export function CopyButton({ getText, className }: { getText: () => string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy"}
      className={cn(
        "grid size-6 place-items-center rounded-md border border-input bg-card text-faint shadow-sm transition-opacity",
        "opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
        className,
      )}
      onClick={async () => {
        const t = getText();
        if (!t) return;
        try {
          await navigator.clipboard.writeText(t);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable (permission denied or insecure context) */
        }
      }}
    >
      <NamedIcon name={copied ? "check" : "copy"} className="size-3" />
    </button>
  );
}
