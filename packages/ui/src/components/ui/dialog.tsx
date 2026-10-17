import { useEffect, useId, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Actions shown in the footer strip. */
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Modal dialog (shadcn-style): scrim, title row with close, body and an optional footer. Esc closes. */
export function Dialog({ open, onClose, title, footer, className, children }: DialogProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div aria-hidden="true" className="absolute inset-0 bg-[rgba(10,10,9,0.6)]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          "relative flex w-[540px] max-w-full flex-col rounded-lg border border-input bg-popover shadow-[0_24px_64px_rgba(0,0,0,0.55)]",
          className,
        )}
      >
        <div className="flex items-center gap-2.5 px-[18px] pb-3 pt-4">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <button
            aria-label="Close"
            className="ml-auto size-7 border-0 bg-transparent p-0 text-faint hover:bg-sunken hover:text-foreground"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="flex flex-col gap-3.5 px-[18px] pb-4">{children}</div>
        {footer ? <div className="flex items-center gap-2 border-t border-border px-[18px] py-3">{footer}</div> : null}
      </div>
    </div>
  );
}
