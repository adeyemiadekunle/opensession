# OpenSession CLI

`opensession`: run the OpenSession coding agent from your terminal, in your cloud
sandboxes or on this computer, with your own model keys.

## Install

Needs [Node.js](https://nodejs.org) 20 or newer. The install also downloads OpenCode,
the agent runtime for local mode (only the build for this computer), so nothing else
is needed.

```bash
npm install -g opensession-cli
```

Or without npm, from your OpenSession web app:

```bash
curl -fsSL https://app.yourdomain.com/install.sh | sh        # macOS, Linux
irm https://app.yourdomain.com/install.ps1 | iex             # Windows PowerShell
```

The install script's build has your deployment's addresses built in. With the npm
package, point it at your servers once:

```bash
opensession config --gateway https://api.yourdomain.com --web https://app.yourdomain.com
```

## Use

In a terminal in any project folder:

```bash
opensession local key anthropic                    # once: a model API key, kept on this computer
opensession                                        # chat with the agent in this folder
opensession run --local "add a README"             # one prompt, then exit
```

With your cloud account:

```bash
opensession login                                  # opens the web app to authorize the CLI
opensession keys set anthropic                     # save a model API key in your account
opensession run "fix the failing tests"            # a session in your cloud sandbox
opensession attach                                 # chat with your cloud project
opensession --help
```

OpenCode is downloaded to `~/.local/share/opensession/opencode` (Windows:
`%LOCALAPPDATA%\opensession\opencode`); `opensession opencode path` shows which one is
used. `OPENCODE_VERSION` picks another version (downloaded the same way) and
`OPENCODE_BIN` another OpenCode executable.
