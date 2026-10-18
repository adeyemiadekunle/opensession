import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

const badgeVariants = cva("inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      default: "bg-primary/15 text-primary",
      success: "bg-success/15 text-success",
      warning: "bg-warning/15 text-warning",
      danger: "bg-destructive/15 text-destructive",
      muted: "bg-sunken text-muted-foreground",
      outline: "border border-input bg-transparent text-muted-foreground",
    },
  },
  defaultVariants: { variant: "default" },
});

/** shadcn-style badge: a small status chip ("This device", a session's status). */
export function Badge({ className, variant, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
