// Run inside a sandbox as its agent user: docker exec -i SANDBOX node --input-type=module < scripts/check/browser.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createInterface } from "node:readline";

const page = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>OpenSession browser smoke</title><h1>Browser reached the sandbox localhost</h1>");
});
await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));

const mcp = spawn("opensession-browser", [], { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let next = 0;
let stderr = "";
mcp.stderr.on("data", (data) => { stderr = (stderr + data).slice(-2000); });
function fail(error) {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
}
mcp.on("error", fail);
mcp.on("exit", (code) => fail(new Error(`Browser MCP exited (${code}): ${stderr}`)));
const lines = createInterface({ input: mcp.stdout });
lines.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  } catch (error) {
    fail(error);
  }
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
async function call(name, args) {
  const result = await request("tools/call", { name, arguments: args });
  const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  assert.ok(!result.isError, `${name}: ${text}`);
  return text;
}

const timeout = setTimeout(() => fail(new Error("Browser MCP smoke test timed out")), 60_000);
try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "opensession-browser-smoke", version: "1.0.0" },
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const { tools } = await request("tools/list");
  assert.ok(tools.some((t) => t.name === "browser_navigate"));
  assert.ok(tools.some((t) => t.name === "browser_snapshot"));
  await call("browser_navigate", { url: `http://localhost:${page.address().port}` });
  const snapshot = await call("browser_snapshot", {});
  assert.match(snapshot, /OpenSession browser smoke/);
  assert.match(snapshot, /Browser reached the sandbox localhost/);
  console.log("Browser MCP navigated to sandbox localhost and read its page snapshot");
} finally {
  clearTimeout(timeout);
  lines.close();
  mcp.kill();
  page.closeAllConnections();
  page.close();
}
