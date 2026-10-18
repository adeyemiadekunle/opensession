import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
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

/** Modal dialog (shadcn-style, on Radix): portal, scrim, focus trap and focus restore; Esc and
 *  clicking the scrim close it. */
export function Dialog({ open, onClose, title, footer, className, children }: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade bg-[rgba(10,10,9,0.6)]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-32px)] w-[540px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 animate-pop flex-col overflow-auto rounded-lg border border-input bg-popover shadow-[0_24px_64px_rgba(0,0,0,0.55)]",
            className,
          )}
        >
          <div className="flex items-center gap-2.5 px-[18px] pt-4 pb-3">
            <DialogPrimitive.Title className="m-0 text-base font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="Close"
              className="ml-auto grid size-7 place-items-center rounded-md border-0 bg-transparent p-0 text-faint hover:bg-sunken hover:text-foreground"
            >
              ×
            </DialogPrimitive.Close>
          </div>
          <div className="flex flex-col gap-3.5 px-[18px] pb-4">{children}</div>
          {footer ? <div className="flex items-center gap-2 border-t border-border px-[18px] py-3">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
