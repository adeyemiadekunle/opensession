# Durable execution: Phase 0 baseline

What happens to a cloud agent run when something fails, measured before building any
durability layer. OpenCode 2.1.2 (the version this repository's packages and the sandbox
image are pinned to), October 2026.

## Method

`scripts/check/durable/` runs one task in the real sandbox image and breaks it at a chosen
point:

- `mock-model.mjs` is a scripted Anthropic Messages API. OpenCode's `anthropic` provider
  points at it (`providers.anthropic.settings.baseURL`, as the gateway's model proxy does),
  so every run is identical and free, and the harness can hold a model request open to kill
  OpenCode at an exact point. Step *k* = the number of tool results the model has seen; a
  step asked for twice is a repeated model call.
- `baseline.mjs` starts the sandbox container (same image, volumes and entrypoint as a
  gateway sandbox), creates a session, sends one prompt and **detaches**: no client is
  connected while the run executes. It then breaks the run, restarts the container where
  the scenario says so, and waits for the session to settle.

The task: write `notes.txt` → shell `echo run >> counter.txt && sleep 25` → `git commit` →
shell `echo after >> after.txt` → answer. The files count side effects: `counter.txt` lines =
times the slow step ran, `git rev-list --count HEAD` = commits, `after.txt` lines = times the
last step ran.

    node scripts/check/durable/mock-model.mjs                # port 4700, leave running
    node scripts/check/durable/baseline.mjs opencode-sandbox:2.1.2 [scenario...]
    SERVE_MODE=service node scripts/check/durable/baseline.mjs ...   # force `serve --service`

Results (every model request, the session's messages, file state):
`scripts/check/durable/results/2.1.2-plain-serve.json` (old entrypoint),
`2.1.2.json` (current entrypoint).

## Results

"Resumed" = the run finished on its own after the failure, with no client and no new prompt.

| Scenario | Old entrypoint (`opencode serve`) | Current entrypoint (`opencode serve --service`) |
|---|---|---|
| No failure, no client attached | finished; 5 model calls | finished; 5 model calls |
| SIGKILL during a model call | **stuck**: never resumed | resumed; 1 repeated model call |
| SIGKILL after a file write, before the model saw it | **stuck** | resumed; write not repeated; 1 repeated model call |
| SIGKILL during a 25 s shell command | **stuck** | resumed; command reported as interrupted, not re-run |
| SIGKILL after `git commit`, before the model saw it | **stuck** (commit done) | resumed; 1 commit, not repeated |
| `docker stop` (SIGTERM, what idle sleep does) during the shell command | **stuck** | resumed; command reported as interrupted |
| Provider answers 500 once | retried, finished | retried, finished |
| Provider stream cut off midway once | retried, finished | retried, finished |

In every resumed case the files show each side effect exactly once (`notes.txt` = v1, slow
step 1×, 1 commit, last step 1×). OpenCode 2.0.0 (the image deployed before this branch)
behaved like the old entrypoint: a run killed during a model call never resumed.

### Why the old entrypoint never resumed

OpenCode writes an execution claim when a turn starts and only clears it at a terminal event.
At boot, a sweep resumes every session whose claim is still set
(`packages/core/src/session/execution/restart.ts`). But only service mode runs that sweep
(`installRestartContinuity` in `packages/server/src/process.ts` needs the service lifecycle);
plain `opencode serve` never does. The sandbox ran plain `opencode serve`, so an interrupted
turn stayed claimed and idle forever.

**Fix (in this branch):** `services/sandbox/entrypoint.sh` now writes `service.json`
(hostname, port, and `OPENCODE_SERVER_PASSWORD` as the password; service mode reads these
from the file instead of flags and the environment) and runs `opencode serve --service`.
The gateway's Basic auth to the sandbox is unchanged.

### What recovery looks like

- OpenCode adds a synthetic message: "The server restarted while you were working. Continue
  from where you left off without repeating completed work." It resumes a turn at most 10
  times, then marks it failed, so a crash loop ends.
- **Completed tool calls are never re-run.** Their results were stored before the crash; the
  model continues from them.
- **A tool call that was running is not re-run either.** The model is told
  `{"error":{"type":"aborted","message":"Tool execution interrupted: shell"}}` and decides what
  to do. In these runs the scripted model moved on; **a real model will often run the command
  again.** That is safe for a test run, not for `git push` or creating a pull request.
- **The model call that was in flight is repeated** (one extra call per crash). Its partial
  output is discarded, but the provider may have billed it.
- Provider failures (500, dropped stream) are retried by OpenCode without any duplicate
  side effects. A gateway restart looks the same from the sandbox, because model calls go
  through the gateway's model proxy.

### Gateway behaviour

- **Idle sleep doesn't interrupt working agents.** Before sleeping a sandbox the gateway asks
  `GET /api/session/active` (`orchestrator.py _busy`); during the slow step OpenCode 2.1.2
  answered `{"ses_…": {"type": "running"}}`, so a running sandbox stays awake (up to
  `max_busy_seconds`).
- **Nothing wakes a stopped sandbox to finish a run.** Recovery happens when OpenCode starts.
  If a sandbox stops mid-run (host restart, `max_busy_seconds` reached, a crash with
  `restart: no`), the run finishes only when the next request for that workspace starts it again.

## Not covered yet

- A real model deciding after an interrupted tool (does it re-run `git push`?).
- E2B sandboxes (`SANDBOX_PROVIDER=e2b`); the entrypoint change applies there too, untested.
- The full stack (gateway + model proxy + egress) killed together; a gateway restart was
  simulated as a dropped model stream.
- Crash loops (the 10-resume budget) and very long runs.

## What this means for the durability plan

OpenCode already provides most of what the plan's run store and worker were for: durable
turn state, automatic resume, at-most-once execution of completed tool calls, a crash-loop
budget, and runs that don't depend on a connected client. One sandbox per workspace means
one process owns each run, so leases and fencing aren't needed yet.

What remains, in order of value:

1. **Interrupted side effects.** Wrap `git push`, pull request creation and other
   external actions so that a retry checks remote state first (the plan's Phase 5).
2. **Wake sandboxes with unfinished runs.** After a host or gateway restart, start sandboxes
   whose OpenCode still has a claimed session, instead of waiting for the user.
3. **Run index and usage per run** in Postgres, mirroring OpenCode's state for listing,
   notifications and cost; not a second source of truth.
4. A real-model test of scenario 4 to see what models do with "Tool execution interrupted".
