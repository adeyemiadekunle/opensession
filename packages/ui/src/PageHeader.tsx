import type { ReactNode } from "react";
import { Button } from "./components/ui/button";

/** Header of pages outside the workspace (design: "← Workspace", the title, a note on the right). */
export function PageHeader({ title, onBack, aside }: { title: string; onBack?: () => void; aside?: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3.5 border-b border-border bg-sidebar px-6">
      {onBack ? (
        <Button size="sm" variant="outline" onClick={onBack}>
          ← Workspace
        </Button>
      ) : null}
      <span className="text-[15px] font-semibold">{title}</span>
      {aside ? <span className="ml-auto text-[13px] text-faint">{aside}</span> : null}
    </header>
  );
}
