import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

/** Header shared by every dock card and full-screen panel, so titles and buttons line up. */
export function PanelHeader({
  title,
  children,
  onClose,
  closeLabel,
  className,
}: {
  /** The panel name, or something in its place (the Files card's open-file tabs). */
  title: ReactNode;
  /** Buttons before the close button. */
  children?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  className?: string;
}) {
  return (
    <header className={cn("flex h-[42px] shrink-0 items-center gap-1 border-b border-border pl-3.5 pr-1.5", className)}>
      <div className="flex min-w-0 flex-1 items-center text-[13.5px] font-semibold">
        {typeof title === "string" ? <span className="truncate">{title}</span> : title}
      </div>
      {children}
      {onClose ? (
        <Button variant="ghost" size="icon-sm" className="text-base text-faint" aria-label={closeLabel ?? "Close panel"} onClick={onClose}>
          ×
        </Button>
      ) : null}
    </header>
  );
}
