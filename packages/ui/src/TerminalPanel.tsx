import { useEffect, useRef, useState } from "react";
import type { TerminalApi } from "@opensession/api-client";
import "@xterm/xterm/css/xterm.css";

/**
 * A shell in the project's cloud sandbox (OpenCode PTY over the gateway's WebSocket).
 * Reconnects with the last output cursor, so a dropped connection replays what was
 * missed. The terminal survives page reloads while the sandbox is awake; it ends
 * when the sandbox goes to sleep (files are kept).
 */
export function TerminalPanel({ api }: { api: TerminalApi }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Connecting…");
  const [gen, setGen] = useState(0); // bump to start a fresh shell

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let cursor: number | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ro: ResizeObserver | undefined;
    let cleanupTerm = () => {};

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !host.current) return;
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        theme: { background: "#0f1115" },
        convertEol: false,
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host.current);
      fit.fit();
      cleanupTerm = () => term.dispose();

      // Reuse a running shell (e.g. after a reload), else start one.
      let id: string;
      try {
        const existing = (await api.list()).find((t) => t.status === "running");
        id = gen === 0 && existing ? existing.id : (await api.create({ cols: term.cols, rows: term.rows })).id;
      } catch (e) {
        setStatus(`Could not start a terminal: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (disposed) return;

      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      const sendSize = () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          try {
            fit.fit();
          } catch {
            /* hidden */
          }
          api.resize(id, { cols: term.cols, rows: term.rows }).catch(() => {});
        }, 120);
      };
      ro = new ResizeObserver(sendSize);
      ro.observe(host.current);
      sendSize();

      term.onData((d) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(d);
      });

      const decoder = new TextDecoder();
      const connect = async (attempt: number) => {
        let url: string;
        try {
          url = await api.socketUrl(id, cursor);
        } catch (e) {
          setStatus(`Disconnected: ${e instanceof Error ? e.message : String(e)}`);
          retry = setTimeout(() => connect(attempt + 1), Math.min(10_000, 1000 * 2 ** attempt));
          return;
        }
        if (disposed) return;
        ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
          setStatus("");
          attempt = 0;
        };
        ws.onmessage = (ev) => {
          if (typeof ev.data === "string") return term.write(ev.data);
          const bytes = new Uint8Array(ev.data as ArrayBuffer);
          if (bytes[0] === 0) {
            try {
              cursor = JSON.parse(decoder.decode(bytes.subarray(1))).cursor;
            } catch {
              /* ignore */
            }
            return;
          }
          term.write(bytes);
        };
        ws.onclose = (ev) => {
          if (disposed) return;
          if (ev.code === 1000 || ev.code === 4404) {
            setStatus("The shell has exited.");
            return;
          }
          setStatus("Reconnecting…");
          retry = setTimeout(() => connect(attempt + 1), Math.min(10_000, 1000 * 2 ** attempt));
        };
      };
      connect(0);
      term.focus();
    })();

    return () => {
      disposed = true;
      clearTimeout(retry);
      ro?.disconnect();
      ws?.close();
      cleanupTerm();
    };
  }, [api, gen]);

  return (
    <div className="terminal-panel">
      {status ? (
        <div className="terminal-status">
          {status}
          {status === "The shell has exited." ? (
            <button onClick={() => setGen((g) => g + 1)}>New shell</button>
          ) : null}
        </div>
      ) : null}
      <div className="terminal-host" ref={host} />
    </div>
  );
}
