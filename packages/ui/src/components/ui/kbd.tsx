import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** shadcn-style kbd: a keyboard shortcut shown as a key cap ("Ctrl K"). */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd className={cn("rounded-md border border-input px-1.5 py-0.5 font-mono text-[11.5px] text-muted-foreground", className)} {...props} />
  );
}
