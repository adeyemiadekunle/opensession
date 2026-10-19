#!/usr/bin/env node
// The browser's way back into the sandbox when it runs in its own container (the
// gateway's SANDBOX_BROWSER=container, the default with Docker). Chromium there uses
// this as its HTTP proxy for every request (port 9224 on the sandbox's network):
//
// - localhost, 127.x and [::1] are connected to inside the sandbox, so the project's
//   dev servers (localhost:5173 ...) load as if the browser ran here;
// - anything else goes on to the sandbox's own proxy (HTTPS_PROXY: the egress
//   allowlist), so the browser reaches exactly the domains the sandbox can. Without
//   one (local Docker without an allowlist) it connects directly.
//
// Plain-HTTP requests are passed on with "connection: close", so one proxy connection
// carries one request and Chromium can't reuse it for a different host.
// No dependencies.

import net from "node:net";

const PORT = Number(process.env.OPENSESSION_BROWSER_RELAY_PORT ?? 9224);
const UPSTREAM = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
const MAX_HEAD = 64 * 1024;

/** A name or address that means "this machine". */
export function isLocal(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || /^127\./.test(h);
}

/** "host:port" or "[v6]:port" -> { host, port }. */
export function hostPort(text, defaultPort) {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(text) ?? /^([^:[\]]+)(?::(\d+))?$/.exec(text);
  return m ? { host: m[1], port: Number(m[2] ?? defaultPort) } : null;
}

/** The request head with `target` as its request target, and connection: close. */
export function rewriteHead(head, target) {
  const [line, ...headers] = head.split("\r\n");
  const [method, , version] = line.split(" ");
  const kept = headers.filter((h) => !/^(proxy-connection|connection|keep-alive)\s*:/i.test(h));
  return [`${method} ${target} ${version}`, ...kept, "connection: close"].join("\r\n") + "\r\n\r\n";
}

/** Where a request goes: { host, port, write, established } (null = refuse it). */
export function route(head, upstreamUrl = UPSTREAM) {
  const [method = "", target = ""] = head.split("\r\n")[0].split(" ");
  const up = upstreamUrl ? new URL(upstreamUrl) : null;
  const upstream = up ? { host: up.hostname, port: Number(up.port || 80) } : null;
  if (method.toUpperCase() === "CONNECT") {
    const t = hostPort(target, 443);
    if (!t) return null;
    if (isLocal(t.host)) return { host: t.host, port: t.port, write: "", established: true };
    // The upstream proxy answers the CONNECT itself.
    if (upstream) return { ...upstream, write: head + "\r\n\r\n", established: false };
    return { host: t.host, port: t.port, write: "", established: true };
  }
  let url;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  const port = Number(url.port || 80);
  const path = url.pathname + url.search;
  if (isLocal(url.hostname)) return { host: url.hostname, port, write: rewriteHead(head, path), established: false };
  if (upstream) return { ...upstream, write: rewriteHead(head, target), established: false };
  return { host: url.hostname, port, write: rewriteHead(head, path), established: false };
}

function refuse(sock, status) {
  sock.end(`HTTP/1.1 ${status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
}

function handle(sock, head, rest) {
  const r = route(head);
  if (!r) return refuse(sock, "400 Bad Request");
  // Brackets off; "localhost" tries IPv6 and IPv4, as dev servers bind either.
  const host = r.host.replace(/^\[|\]$/g, "");
  let connected = false;
  const up = net.connect({ host, port: r.port, autoSelectFamily: true }, () => {
    connected = true;
    if (r.established) sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (r.write) up.write(r.write);
    if (rest.length) up.write(rest);
    sock.pipe(up).pipe(sock);
    sock.resume();
  });
  const close = () => {
    sock.destroy();
    up.destroy();
  };
  up.on("error", () => (connected ? close() : refuse(sock, "502 Bad Gateway")));
  sock.on("error", close);
  up.on("close", () => connected && close()); // unconnected: the 502 above ends it
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
      handle(sock, buf.subarray(0, end).toString("latin1"), buf.subarray(end + 4));
    };
    sock.on("data", onData);
    sock.on("error", () => sock.destroy());
    sock.setTimeout(30_000, () => buf.indexOf("\r\n\r\n") < 0 && sock.destroy());
  });
  server.listen(port, "0.0.0.0");
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) serve();
