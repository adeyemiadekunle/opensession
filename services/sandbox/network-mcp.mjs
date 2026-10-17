#!/usr/bin/env node
// MCP server (stdio) with one tool, request_access: the agent asks to reach a domain
// the sandbox can't reach yet. OpenCode asks the user before every call (the gateway's
// agent config sets network_request_access to "ask"); approving it in OpenSession adds
// the domain to the user's allowed domains, so by the time this runs the domain is open.
// No dependencies: newline-delimited JSON-RPC, as MCP's stdio transport uses.

import { createInterface } from "node:readline";

const DOMAIN_RE = /^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const INSTRUCTIONS = `This sandbox has no internet access except domains the user allowed; localhost is always reachable.
When a request fails because a domain is blocked (the proxy answers 403 "Access Denied", or the browser shows ERR_TUNNEL_CONNECTION_FAILED or ERR_PROXY_CONNECTION_FAILED), call request_access with that domain and a one-line reason. The user approves or denies it. If approved, retry the request; if denied, carry on without it.
Ask only for domains the task needs, one per call.`;

const TOOL = {
  name: "request_access",
  description:
    "Ask the user to let this sandbox (shell and browser) reach a domain it can't reach yet. Returns once the user approved; fails if they denied.",
  inputSchema: {
    type: "object",
    properties: {
      domain: { type: "string", description: "Host name, e.g. docs.stripe.com (no scheme or path)." },
      reason: { type: "string", description: "One line: why the task needs it." },
    },
    required: ["domain", "reason"],
    additionalProperties: false,
  },
};

/** "https://Docs.Stripe.com/api" -> "docs.stripe.com" */
export function normalizeDomain(input) {
  let d = String(input ?? "").trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  return DOMAIN_RE.test(d) ? d : null;
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

export function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "opensession-network", version: "1.0.0" },
      instructions: INSTRUCTIONS,
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: [TOOL] };
  if (method === "tools/call") {
    if (params?.name !== TOOL.name) throw Object.assign(new Error(`unknown tool ${params?.name}`), { code: -32602 });
    const domain = normalizeDomain(params?.arguments?.domain);
    if (!domain) {
      return { isError: true, content: [{ type: "text", text: "Give a host name such as docs.stripe.com (no scheme, path or IP address)." }] };
    }
    return {
      content: [{ type: "text", text: `The user allowed ${domain}. It can take a few seconds to apply; retry the request now.` }],
    };
  }
  if (id === undefined) return undefined; // notifications (initialized, cancelled) need no answer
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return fail(null, -32700, "parse error");
    }
    try {
      const result = handle(msg);
      if (msg.id !== undefined && result !== undefined) reply(msg.id, result);
    } catch (e) {
      if (msg.id !== undefined) fail(msg.id, e.code ?? -32603, e.message);
    }
  });
}
