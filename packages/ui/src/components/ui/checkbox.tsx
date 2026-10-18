import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import type { ComponentProps } from "react";
import { Icon, icons } from "../../icons";
import { cn } from "../../lib/utils";

/** shadcn-style checkbox (on Radix): a ticked box for forms and "always allow". */
export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-[4px] border border-input bg-card p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <Icon className="size-3">{icons.check}</Icon>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
