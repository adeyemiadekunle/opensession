import { useSyncExternalStore } from "react";
import { Icon, icons } from "../../icons";
import { cn } from "../../lib/utils";

/** A transient notification. Actions (session deleted, push succeeded, an action failed)
 *  surface here rather than as persistent banners: bottom-right, content-width, self-dismissing. */
export interface ToastItem {
  id: number;
  tone: "default" | "success" | "error";
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

const MAX_TOASTS = 4;
const MS = { default: 4200, success: 4200, error: 6500 };

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

function push(tone: ToastItem["tone"], title: string, o: Omit<ToastItem, "id" | "tone" | "title"> = {}) {
  const t: ToastItem = { id: ++seq, tone, title, ...o };
  items = [...items.slice(-(MAX_TOASTS - 1)), t];
  emit();
  setTimeout(() => dismissToast(t.id), MS[tone]);
  return t.id;
}

/** Show a toast from anywhere: `toast.success("Session deleted")`. */
export const toast = Object.assign(
  (title: string, o?: Omit<ToastItem, "id" | "tone" | "title">) => push("default", title, o),
  {
    success: (title: string, o?: Omit<ToastItem, "id" | "tone" | "title">) => push("success", title, o),
    error: (title: string, o?: Omit<ToastItem, "id" | "tone" | "title">) => push("error", title, o),
  },
);

const TONE_ICON: Record<ToastItem["tone"], { icon: React.ReactNode; cls: string } | null> = {
  default: { icon: icons.info, cls: "text-muted-foreground" },
  success: { icon: icons.check, cls: "text-success" },
  error: { icon: icons.close, cls: "text-destructive" },
};

/** Just the toast items; the Workspace places them under the approval stack in one overlay column. */
export function ToastStack() {
  const shown = useSyncExternalStore(subscribe, () => items, () => items);
  return (
    <>
      {shown.map((t) => {
        const tone = TONE_ICON[t.tone];
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex w-fit max-w-full animate-pop items-start gap-2.5 self-end rounded-lg border border-input bg-popover py-2.5 pr-2 pl-3 shadow-pop"
          >
            {tone ? <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone.cls)}>{tone.icon}</Icon> : null}
            <div className="min-w-0 text-[13px] leading-snug">
              <div className="text-foreground">{t.title}</div>
              {t.description ? <div className="mt-0.5 text-xs text-muted-foreground">{t.description}</div> : null}
              {t.action ? (
                <button
                  className="mt-1 border-0 bg-transparent p-0 text-xs font-medium text-primary hover:underline"
                  onClick={() => {
                    t.action!.onClick();
                    dismissToast(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              ) : null}
            </div>
            <button
              aria-label="Dismiss"
              className="grid size-5 shrink-0 place-items-center rounded border-0 bg-transparent text-faint hover:bg-sunken hover:text-foreground"
              onClick={() => dismissToast(t.id)}
            >
              <Icon className="size-3">{icons.close}</Icon>
            </button>
          </div>
        );
      })}
    </>
  );
}

/** Standalone toast stack, fixed bottom-right. The Workspace composes its own overlay column. */
export function Toaster() {
  return (
    <div
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-fit max-w-[min(24rem,calc(100vw-2rem))] flex-col items-end gap-2 [&>*]:pointer-events-auto"
    >
      <ToastStack />
    </div>
  );
}
