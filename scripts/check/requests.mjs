// Run inside a sandbox: docker exec -i SANDBOX node --input-type=module < scripts/check/requests.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const cfg = JSON.parse(await readFile(`${process.env.HOME}/.config/opencode/opencode.json`, "utf8"));
assert.equal(cfg.mcp.servers.opensession.codemode, false, "user tools must expose their inputs directly");
const home = await mkdtemp(join(tmpdir(), "opensession-requests-"));
let scenario;
let catalogReady = false;
let fixtureError;
let sequence = 0;
// A local Responses API fixture drives real OpenCode tool calls without a model key.
const model = http.createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (!raw) { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(raw);
    const call = scenario && body.tools?.length && !body.input.some((p) => p.type === "function_call_output");
    if (body.tools?.length) {
      catalogReady = ["opensession_request_access", "opensession_hand_over"].every((name) => body.tools.some((t) => t.name === name));
      if (scenario) assert.ok(catalogReady, JSON.stringify(body.tools.map((t) => t.name)));
    }
    const id = ++sequence;
    const item = call
      ? { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: scenario.action, arguments: JSON.stringify(scenario.input), status: "completed" }
      : { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture finished.", annotations: [] }] };
    const response = {
      id: `resp_${id}`, object: "response", created_at: 1, model: body.model, status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("response.created", { response: { ...response, status: "in_progress", output: [] } });
    event("response.output_item.added", { output_index: 0, item: call ? { ...item, arguments: "" } : { ...item, content: [] } });
    if (call) event("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: item.arguments });
    else {
      event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "Fixture finished." });
    }
    event("response.output_item.done", { output_index: 0, item });
    event("response.completed", { response });
    res.end();
  } catch (error) {
    fixtureError = error;
    res.writeHead(500); res.end();
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const reserve = http.createServer();
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const env = { ...process.env, HOME: home, OPENCODE_SERVER_PASSWORD: "opensession-request-fixture" };
for (const dir of ["CONFIG", "DATA", "CACHE", "STATE"]) env[`XDG_${dir}_HOME`] = join(home, dir.toLowerCase());
await mkdir(join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true });
await writeFile(join(env.XDG_CONFIG_HOME, "opencode/opencode.json"), JSON.stringify({
  update: "disable", agents: cfg.agents, permissions: cfg.permissions,
  mcp: { servers: { opensession: cfg.mcp.servers.opensession } },
  providers: { openai: { websocket: false, settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "fixture-not-a-real-key" } } },
}));
const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { logs = (logs + data).slice(-2000); });
child.on("error", (error) => { fixtureError = error; });
const deadline = AbortSignal.timeout(90_000);
async function api(path, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Basic ${Buffer.from("opencode:opensession-request-fixture").toString("base64")}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
  });
  const text = await res.text();
  assert.ok(res.ok, `${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text).data : undefined;
}
async function waitFor(check) {
  while (true) {
    deadline.throwIfAborted();
    if (fixtureError) throw fixtureError;
    const result = await check();
    if (result) return result;
    await delay(100);
  }
}

try {
  await waitFor(async () => {
    try { await api("/health"); return true; } catch { return false; }
  });
  await waitFor(async () => (await api("/mcp")).some((s) => s.name === "opensession" && s.status.status === "connected"));
  // A connected MCP transport can precede its lazy tool catalog.
  await waitFor(async () => {
    const warmup = await api("/session", { model: { providerID: "openai", id: "gpt-4o" }, location: { directory: home } });
    await api(`/session/${warmup.id}/prompt`, { text: "Warm the tool catalog." });
    await api(`/session/${warmup.id}/wait`, {});
    return catalogReady;
  });
  for (scenario of [
    { action: "opensession_request_access", input: { domain: "docs.example.com", reason: "Read documentation" }, reply: "once", result: /The user allowed docs.example.com/ },
    { action: "opensession_request_access", input: { domain: "denied.example.com", reason: "Read documentation" }, reply: "reject" },
    { action: "opensession_hand_over", input: { task: "Sign in to the test account", url: "https://example.com/login" }, reply: "once", result: /The user says they are done/ },
  ]) {
    const session = await api("/session", { model: { providerID: "openai", id: "gpt-4o" }, location: { directory: home } });
    const path = `/session/${session.id}`;
    await api(`${path}/prompt`, { text: "Call the fixture tool." });
    const request = await waitFor(async () => (await api(`${path}/permission`))[0]);
    assert.equal(request.action, scenario.action);
    const messages = await api(`${path}/message`);
    const part = messages.find((m) => m.id === request.source.messageID)?.content.find((p) => p.id === request.source.id);
    assert.equal(part?.name, scenario.action);
    assert.deepEqual(part.state.input, scenario.input);
    assert.equal(part.state.status, "running");
    await api(`${path}/permission/${request.id}/reply`, { reply: scenario.reply });
    await api(`${path}/wait`, {});
    const completed = (await api(`${path}/message`)).flatMap((m) => m.content ?? []).find((p) => p.id === part.id);
    assert.equal(completed.state.status, scenario.reply === "reject" ? "error" : "completed");
    if (scenario.result) assert.match(JSON.stringify(completed), scenario.result);
    else assert.doesNotMatch(JSON.stringify(completed), /The user allowed/);
    assert.deepEqual(await api(`${path}/permission`), []);
    console.log(`${scenario.action}: ${scenario.reply} resolves the linked tool correctly`);
  }
} catch (error) {
  throw new Error(`${error.stack}\nOpenCode: ${logs}`);
} finally {
  const exited = once(child, "exit");
  child.kill();
  await Promise.race([exited, delay(3000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  model.closeAllConnections(); model.close();
  await rm(home, { recursive: true, force: true });
}
