# OpenSession CLI

`opensession`: run the OpenSession coding agent from your terminal, in your cloud
sandboxes or on this computer, with your own model keys.

## Install

Needs [Node.js](https://nodejs.org) 20 or newer.

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

```bash
opensession login                                  # opens the web app to authorize the CLI
opensession keys set anthropic                     # save a model API key
opensession run "fix the failing tests"            # a session in your cloud sandbox
opensession run --local "add a README" -C ./app    # on this computer (needs OpenCode)
opensession --help
```

Local runs use OpenCode on this computer: `curl -fsSL https://opencode.ai/v2/install | bash`.
