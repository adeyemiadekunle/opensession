# OpenCode versions: pinned, checked, then approved

OpenSession talks to OpenCode V2's HTTP API, which OpenCode still calls
experimental, and new releases change it. So OpenSession uses exactly one
approved release, and a new one is only approved after it passes a check.

## The approved version

`opencode-version.json` (currently **2.0.0**). The same value is in:

| Where | What it does |
|---|---|
| `services/sandbox/Dockerfile` (`ARG OPENCODE_VERSION`) | installs exactly that release; the build **fails** if it can't (no fallback to the newest) and checks `opencode --version` |
| `docker-compose.dokploy.yml` | builds and tags the image `opencode-sandbox:<version>` and tells the gateway to use that tag |
| `services/gateway/src/opensession/opencode_version.py` | the gateway refuses a sandbox reporting any other version (with a clear error) |
| `packages/api-client/src/types.ts` (`SUPPORTED_OPENCODE_VERSIONS`) | the desktop app and CLI refuse a locally installed OpenCode of another version and show how to install the right one |

`tests/test_opencode_version.py` fails if any copy differs, and cloud sandboxes
run with OpenCode's self-update off. To try another release by hand, set
`OPENCODE_SUPPORTED_VERSIONS=*` (gateway or local mode); never in production.

## Approving a new release

`.github/workflows/opencode-update.yml` runs every Monday (or by hand from the
Actions tab, optionally with a version):

1. reads the latest release from `https://opencode.ai/update/api/latest/cli/npm`;
2. builds the sandbox image with it;
3. **API check** (`scripts/opencode/api_check.py`): every endpoint OpenSession calls
   must exist in the release's own OpenAPI document; also lists what was added or
   removed;
4. moves every pin to it (`scripts/opencode/bump.py`) and runs the gateway tests;
5. runs the **Docker smoke test** against it (sandboxes, isolation, egress, agent
   setup, sleep/resume, terminal);
6. all green: opens a pull request "Approve OpenCode X" with the API changes.
   Anything red: opens (or comments on) an issue "OpenCode X failed the update
   check" with the logs.

Nothing changes until someone merges that pull request. Before merging, read the
API changes and try local mode in the desktop app with that release.

Pull requests opened with the default `GITHUB_TOKEN` don't start other workflows
(GitHub's rule), so the PR's own CI won't run by itself; the update check already
ran the same tests. To have CI run on it too, add a fine-grained token with
contents, pull requests and issues write access as the `OPENCODE_UPDATE_TOKEN`
repository secret.

## Record

- **2.0.30** (checked 15 Oct 2026, by hand with the same script): **not
  compatible**. 4 of the 38 endpoints OpenSession uses are gone: `GET /api/health`
  (sandbox start-up depends on it; `GET /api/info` looks like its replacement),
  `POST /api/session/{id}/wait` and `/skill` (moved under `/api/experimental/...`),
  and `GET /api/vcs/branches` (now `/api/vcs/branch`); 29 other endpoints were
  removed and 31 added. Moving to it needs code changes first.
