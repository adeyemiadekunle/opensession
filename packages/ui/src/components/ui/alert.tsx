import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";

const alertVariants = cva("flex w-full gap-2.5 rounded-lg border px-3.5 py-2.5 text-[13px]", {
  variants: {
    tone: {
      danger: "border-destructive/40 bg-del-bg",
      warning: "border-warning/40 bg-warning/10",
      info: "border-primary/40 bg-primary/10",
    },
    layout: {
      row: "items-center",
      stack: "flex-col py-3",
    },
  },
  defaultVariants: { tone: "warning", layout: "row" },
});

export type AlertTone = "danger" | "warning" | "info";

const DOT: Record<AlertTone, string> = { danger: "bg-destructive", warning: "bg-warning", info: "bg-primary" };
const TITLE: Record<AlertTone, string> = { danger: "text-destructive", warning: "text-warning", info: "text-primary" };

export interface AlertProps extends Omit<ComponentProps<"div">, "title">, Omit<VariantProps<typeof alertVariants>, "tone"> {
  tone?: AlertTone;
  title?: ReactNode;
  /** Right-aligned (row) or bottom (stack) control, e.g. a Retry button. */
  action?: ReactNode;
}

/** shadcn-style alert in the design's voice: a status dot, a bold title, then the detail.
 *  `row` keeps everything on one line (banners); `stack` puts the detail and action below (cards). */
export function Alert({ className, tone = "warning", layout = "row", title, action, children, role = "alert", ...props }: AlertProps) {
  const dot = <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[tone])} />;
  const heading = title ? <strong className={cn("font-semibold", TITLE[tone])}>{title}</strong> : null;
  if (layout === "stack") {
    return (
      <div role={role} className={cn(alertVariants({ tone, layout }), className)} {...props}>
        {heading ? (
          <div className="flex items-center gap-2.5">
            {dot}
            {heading}
          </div>
        ) : null}
        {children}
        {action}
      </div>
    );
  }
  return (
    <div role={role} className={cn(alertVariants({ tone, layout }), className)} {...props}>
      {dot}
      <span className="min-w-0 flex-1">
        {heading}
        {heading && children ? " " : null}
        {children}
      </span>
      {action}
    </div>
  );
}
