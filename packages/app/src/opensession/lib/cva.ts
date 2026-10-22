// From shadcn-solid (MIT, github.com/hngngn/shadcn-solid @ 4c75b892148d,
// apps/docs/src/registry/lib/cva.ts): class variants with conflicting Tailwind classes merged.
import { defineConfig } from "cva"
import { twMerge } from "tailwind-merge"

export const { cva, cx, compose } = defineConfig({
  hooks: {
    onComplete: (className) => twMerge(className),
  },
})
