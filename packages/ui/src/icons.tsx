import type { ReactNode } from "react";
import { cn } from "./lib/utils";

/** Stroke icon in the design's style (24px grid, 1.8 stroke), sized by the caller or 16px. */
export function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={cn("size-4 shrink-0", className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const icons = {
  terminal: <path d="M4 7l5 5-5 5M12 18h8" />,
  changes: (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <path d="M6 8v8M8 6h4a6 6 0 0 1 6 6" />
    </>
  ),
  git: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v6M12 15v6" />
    </>
  ),
  files: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  expand: <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />,
  list: <path d="M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof icons;

export function NamedIcon({ name, className }: { name: IconName; className?: string }) {
  return <Icon className={className}>{icons[name]}</Icon>;
}
