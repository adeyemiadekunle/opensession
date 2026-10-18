import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** shadcn-style card: the bordered panel used for settings sections, stats and grouped content. */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-3 rounded-lg border border-input bg-card p-[18px] text-foreground", className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("m-0 text-[15px] font-semibold", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("m-0 text-[13px] text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex min-w-0 flex-col gap-3", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex justify-end gap-2", className)} {...props} />;
}
