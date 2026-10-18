import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** shadcn-style empty state: an optional icon and a title, centered in the space it gets. */
export function Empty({ icon, title, children, className }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-muted-foreground", className)}>
      {icon ? <span className="text-faint [&_svg]:size-6">{icon}</span> : null}
      <p className="m-0 text-sm font-semibold text-foreground">{title}</p>
      {children}
    </div>
  );
}
