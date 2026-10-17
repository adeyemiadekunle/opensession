#!/usr/bin/env node
// The Browser card's way into the sandbox's Chromium. Chromium's debugging port only
// listens on 127.0.0.1; this listens on the sandbox network (OPENSESSION_BROWSER_VIEW_PORT,
// default 9223), checks the same password as the OpenCode server, starts Chromium if it
// isn't running (chromium.sh), and then passes the WebSocket straight through to
// Chromium's browser endpoint. The gateway relays it to the app behind a ticket.
//
//   GET /health     200 once signed in (does not start Chromium)
//   GET /cdp        WebSocket: Chromium DevTools Protocol, browser level
//
// It reads only the HTTP request head; after that the bytes are Chromium's.
// No dependencies.

import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import net from "node:net";

const PORT = Number(process.env.OPENSESSION_BROWSER_VIEW_PORT ?? 9223);
const CDP_PORT = Number(process.env.OPENSESSION_BROWSER_PORT ?? 9222);
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const USERNAME = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const NO_AUTH = process.env.OPENSESSION_BROWSER_VIEW_NO_AUTH === "1"; // local tests only
const CHROMIUM = process.env.OPENSESSION_CHROMIUM ?? "opensession-chromium";
const MAX_HEAD = 16 * 1024;

function same(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Basic opencode:<password> (as OpenCode's server takes it) or Bearer <password>. */
export function authorized(header) {
  if (NO_AUTH) return true;
  if (!PASSWORD || !header) return false;
  const [scheme, value = ""] = header.split(" ", 2);
  if (/^bearer$/i.test(scheme)) return same(value, PASSWORD);
  if (/^basic$/i.test(scheme)) return same(Buffer.from(value, "base64").toString(), `${USERNAME}:${PASSWORD}`);
  return false;
}

export function parseHead(text) {
  const [line, ...rest] = text.split("\r\n");
  const [method, path] = line.split(" ");
  const headers = new Map();
  for (const h of rest) {
    const i = h.indexOf(":");
    if (i > 0) headers.set(h.slice(0, i).trim().toLowerCase(), h.slice(i + 1).trim());
  }
  return { method, path, headers };
}

function answer(sock, status, text) {
  sock.end(`HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`);
}

async function browserPath() {
  const started = spawnSync(CHROMIUM, { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 });
  if (started.status !== 0) throw new Error(started.stderr?.toString().trim() || "Chromium did not start");
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const url = new URL((await r.json()).webSocketDebuggerUrl);
  return url.pathname; // /devtools/browser/<id>
}

async function handle(sock, head, rest) {
  const req = parseHead(head);
  if (!authorized(req.headers.get("authorization"))) return answer(sock, "401 Unauthorized", "unauthorized");
  if (req.method === "GET" && req.path === "/health") return answer(sock, "200 OK", "ok");
  if (req.method !== "GET" || req.path !== "/cdp" || req.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return answer(sock, "404 Not Found", "not found");
  let path;
  try {
    path = await browserPath();
  } catch (e) {
    return answer(sock, "503 Service Unavailable", String(e.message ?? e));
  }
  // Chromium accepts a localhost Host and no Origin; the rest of the handshake is the client's.
  const keep = ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"];
  const lines = [`GET ${path} HTTP/1.1`, `host: 127.0.0.1:${CDP_PORT}`];
  for (const k of keep) if (req.headers.has(k)) lines.push(`${k}: ${req.headers.get(k)}`);
  const up = net.connect(CDP_PORT, "127.0.0.1", () => {
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (rest.length) up.write(rest);
    sock.pipe(up).pipe(sock);
  });
  const close = () => {
    sock.destroy();
    up.destroy();
  };
  up.on("error", close);
  sock.on("error", close);
  up.on("close", close);
  sock.on("close", close);
}

export function serve(port = PORT) {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > MAX_HEAD) sock.destroy();
        return;
      }
      sock.off("data", onData);
      sock.pause();
      void handle(sock, buf.subarray(0, end).toString("latin1"), buf.subarray(end + 4)).finally(() => sock.resume());
    };
    sock.on("data", onData);
    sock.on("error", () => sock.destroy());
    sock.setTimeout(30_000, () => buf.indexOf("\r\n\r\n") < 0 && sock.destroy());
  });
  server.listen(port, "0.0.0.0");
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!PASSWORD && !NO_AUTH) {
    console.error("browser-view: OPENCODE_SERVER_PASSWORD is not set; not starting");
    process.exit(1);
  }
  serve();
}
