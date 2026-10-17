import { cva, type VariantProps } from "class-variance-authority";
import type { SelectHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const selectVariants = cva("rounded-md text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", {
  variants: {
    variant: {
      field: "h-8 border border-input bg-card px-2.5 text-foreground",
      ghost:
        "h-7 max-w-[180px] cursor-pointer appearance-none border-0 bg-transparent px-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground focus:bg-muted focus:text-foreground",
    },
  },
  defaultVariants: { variant: "field" },
});

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & VariantProps<typeof selectVariants>;

export function Select({ className, variant, ...props }: SelectProps) {
  return <select className={cn(selectVariants({ variant }), className)} {...props} />;
}
