# shadcn-solid components

OpenSession's own screens use [shadcn-solid](https://shadcn-solid.com) (the SolidJS port
of shadcn/ui, built on Kobalte like the rest of the app). opencode's screens keep their own
components (`@opencode/ui`), so upstream updates still merge cleanly.

- Components are copied in, shadcn style: one file each in this folder. Source:
  `github.com/hngngn/shadcn-solid`, `apps/docs/src/registry/ui/<name>.tsx`, at the commit
  noted in each file's header. Change the import of `cx` to `@/opensession/lib/cva`.
- Colors: `theme.css` maps shadcn's names (`bg-popover`, `text-muted-foreground`, ...) onto
  opencode's tokens, so components follow every opencode theme. Font, type scale and radii
  are opencode's already.
- Borders: add the component's `data-slot` prefix to the `@layer base` rule in `theme.css`
  (shadcn sets border colors globally; here it is scoped so opencode's own UI is unchanged).
- `cva` is pinned to the version shadcn-solid uses (1.0.0-beta.4): later betas changed the
  `defineConfig` API that `lib/cva.ts` relies on.
- Visible text comes from the app's i18n dictionary (`runtime/i18n/en.ts`, `opensession.*`
  keys), per `packages/app/AGENTS.md`.

Components so far: `dropdown-menu` (the sidebar profile menu, `../sidebar.tsx`).
