import type { LogEvent } from "./types";

/** Parse a text/event-stream body into events. Works in browsers, Node and Electron. */
export async function* parseSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<LogEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let ev: { id?: string; event?: string; data: string[] } = { data: [] };
  const flush = (): LogEvent | undefined => {
    if (!ev.data.length && !ev.event) return undefined;
    const raw = ev.data.join("\n");
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* plain text */
    }
    const out: LogEvent = { data };
    if (ev.id !== undefined) out.id = ev.id;
    if (ev.event !== undefined) out.event = ev.event;
    ev = { data: [] };
    return out;
  };
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          const out = flush();
          if (out) yield out;
          continue;
        }
        if (line.startsWith(":")) continue;
        const i = line.indexOf(":");
        const field = i < 0 ? line : line.slice(0, i);
        const val = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
        if (field === "data") ev.data.push(val);
        else if (field === "event") ev.event = val;
        else if (field === "id") ev.id = val;
      }
    }
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

/** The event's sequence number (OpenCode log events carry `seq`), for resuming. */
export function eventCursor(e: LogEvent): string | undefined {
  if (e.id) return e.id;
  const d = e.data as { seq?: unknown } | null;
  return d && typeof d === "object" && d.seq !== undefined ? String(d.seq) : undefined;
}
