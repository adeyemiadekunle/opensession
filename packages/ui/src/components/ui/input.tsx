import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const field =
  "w-full min-w-0 rounded-md border border-input bg-card px-2.5 text-sm text-foreground placeholder:text-faint outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** shadcn-style text input: the same height and border as Select (field) and Button. */
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(field, "h-8", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(field, "min-h-20 py-2", className)} {...props} />;
}
