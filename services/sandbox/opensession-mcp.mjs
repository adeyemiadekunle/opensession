#!/usr/bin/env node
// MCP server (stdio) with the tools that need the user, served as "opensession":
//
// - request_access(domain, reason): the agent asks to reach a domain the sandbox can't
//   reach yet. Approving it in OpenSession adds the domain to the user's allowed domains.
// - hand_over(task, url?): the agent needs the user to do something in the sandbox's
//   browser that it shouldn't or can't (sign in, 2FA, a CAPTCHA). The chat shows the
//   task; the user opens the browser on the agent's tab, does it, and clicks Done.
//
// OpenCode asks the user before every call (the gateway's agent config sets both to
// "ask"), and the call waits until they answer, so by the time a tool runs the user has
// already done their part; denying fails the call. No dependencies: newline-delimited
// JSON-RPC, as MCP's stdio transport uses.

import { createInterface } from "node:readline";

const DOMAIN_RE = /^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const INSTRUCTIONS = `Internet: this sandbox reaches localhost and only the domains the user allowed. When a request fails because a domain is blocked (the proxy answers 403 "Access Denied", or the browser shows ERR_TUNNEL_CONNECTION_FAILED or ERR_PROXY_CONNECTION_FAILED), call request_access with that domain and a one-line reason. If approved, retry; if denied, carry on without it. Ask only for domains the task needs, one per call.

The user: never ask for passwords, codes or card numbers in chat, and never type credentials you were not given. When a step needs the user (signing in, two-factor codes, a CAPTCHA, a payment or consent screen), open that page in the browser first, then call hand_over with what they need to do. It returns once they are done; take a snapshot to see where the page is and continue from there.

Browser tabs: the user can open tabs of their own in the same browser. Work in the tabs you opened; leave other tabs alone unless the user asks.`;

const TOOLS = [
  {
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
  },
  {
    name: "hand_over",
    description:
      "Hand the browser to the user for a step only they can do (sign in, 2FA, CAPTCHA, payment). Open the page first; this waits until the user says they are done, then you continue in the same tab. Fails if they could not do it.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the user should do, in one or two sentences, e.g. \"Sign in to GitHub with your account.\"" },
        url: { type: "string", description: "The page it happens on, if useful to show." },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
];

/** "https://Docs.Stripe.com/api" -> "docs.stripe.com" */
export function normalizeDomain(input) {
  let d = String(input ?? "").trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  return DOMAIN_RE.test(d) ? d : null;
}

const text = (t, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: "text", text: t }] });

function call(name, args) {
  if (name === "request_access") {
    const domain = normalizeDomain(args?.domain);
    if (!domain) return text("Give a host name such as docs.stripe.com (no scheme, path or IP address).", true);
    return text(`The user allowed ${domain}. It can take a few seconds to apply; retry the request now.`);
  }
  if (name === "hand_over") {
    return text("The user says they are done. Take a snapshot of the page to see where it is, then continue in the same tab.");
  }
  throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
}

export function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "opensession", version: "1.1.0" },
      instructions: INSTRUCTIONS,
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call") return call(params?.name, params?.arguments);
  if (id === undefined) return undefined; // notifications (initialized, cancelled) need no answer
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
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
