import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Join class names and let later Tailwind utilities override earlier ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
