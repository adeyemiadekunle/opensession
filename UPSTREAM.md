# Upstream

`packages/`, `patches/`, `script/` and the Bun root files (`bun.lock`, `bunfig.toml`,
`turbo.json`, `tsconfig.json`, `.oxlintrc.json`, `AGENTS.md`, `LICENSE`) come from
OpenCode, MIT licensed:

- repository: https://github.com/anomalyco/opencode
- branch: `dev`
- commit: `da871773084921ad3c167c0b17b2cd4ba8e570b3` (version 2.1.2)

Imported packages (the web app, desktop app and CLI, every workspace package they depend on, and storybook, which the web app's component tests import):
ai, app, cli, client, codemode, core, desktop, gui-extensions, http-recorder, httpapi-codegen,
latex, merman, plugin, plugin-browser, protocol, schema, script, server, session-ui, simulation,
storybook, theme, tui, ui, util.

Root `package.json` is upstream's with OpenSession's name, `packages/*` as the only workspace
glob and scripts trimmed to the packages above.

To compare with a newer upstream: diff `packages/<name>` against the same path at the new commit.
