# Workspace harness

Renders the real `Workspace` and `ReviewView` from `@opensession/ui` with a fixture
client (`mock.ts`), so the UI can be checked without Clerk, the gateway or a sandbox.
Nothing is sent anywhere.

```sh
pnpm --filter @opensession/web harness   # http://localhost:5180
```

Query flags:

| Flag | Shows |
| --- | --- |
| `?dark`, `?light` | pin the theme |
| `?empty` | no sessions (the start screen) |
| `?notice` | the disk-limit notice in the conversation |
| `?noperm` | hide the pending approval card |
| `?move` | desktop's Move to cloud actions |
| `?review` | the full-screen Review |
| `?account=profile`, `usage`, `connected`, `keys`, `devices` | the Profile pages |
| `?settings=cloud`, `?settings=local` | the settings pages (web and cloud, or this computer) |

`design/` (git-ignored) is for local copies of design artboards to compare against.
