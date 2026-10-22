// Scripted Anthropic Messages API for the durability baseline (Phase 0).
//
// OpenCode in a sandbox points its "anthropic" provider here. Every model call is
// answered from a fixed script, so a run is repeatable and costs nothing, and the
// harness can stop OpenCode at an exact point:
//
//   step k = number of tool results already in the conversation
//   script[k] = what the "model" does at step k: call a tool or answer with text
//
// After a crash, OpenCode asking for step k again shows up as a repeated step in the
// log (GET /_log), which is how replays are counted.
//
// Control endpoints (harness only):
//   POST /_control/reset   {script, hold?, fail?}   new run; hold: step to hang on,
//                                                   fail: {step, mode: "500"|"drop"}
//   GET  /_control/held                            {held: step|null}
//   POST /_control/release                         let a held request finish
//   GET  /_log                                     every model request seen
//
// Usage: node mock-model.mjs [port]   (default 4700)

import http from "node:http"

const port = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 4700)

let script = []
let hold = null // step number to hang on (once)
let fail = null // { step, mode } (once)
let held = null // { step, release }
let log = []

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

const readBody = (req) =>
  new Promise((resolve) => {
    let data = ""
    req.on("data", (chunk) => (data += chunk))
    req.on("end", () => resolve(data))
  })

const blocks = (message) => (Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }])

const toolResults = (messages) =>
  messages.flatMap((m) => blocks(m).filter((b) => b.type === "tool_result"))

const lastUserText = (messages) => {
  const user = messages.findLast((m) => m.role === "user")
  if (!user) return ""
  return blocks(user)
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
}

// Picks the request's tool for a script action by name, so the script works with
// whatever OpenCode version calls its tools.
const TOOL_PATTERNS = {
  write: /^(write|file_write|create)$/i,
  shell: /^(bash|shell|run|exec)$/i,
  read: /^(read|file_read|view)$/i,
}

function findTool(tools, kind) {
  const pattern = TOOL_PATTERNS[kind]
  return tools.find((t) => pattern.test(t.name)) ?? tools.find((t) => new RegExp(kind, "i").test(t.name))
}

// Fills the tool's input from the script's args, mapping by property name and filling
// any other required string field so the call validates.
function toolInput(tool, kind, args) {
  const props = tool.input_schema?.properties ?? {}
  const required = tool.input_schema?.required ?? []
  const input = {}
  for (const name of Object.keys(props)) {
    if (kind === "write" && /path|file/i.test(name)) input[name] = args.path
    else if (kind === "write" && /content|text/i.test(name)) input[name] = args.content
    else if (kind === "read" && /path|file/i.test(name)) input[name] = args.path
    else if (kind === "shell" && /^(command|cmd|script)$/i.test(name)) input[name] = args.command
    else if (kind === "shell" && /timeout/i.test(name) && args.timeout) input[name] = args.timeout
    else if (kind === "shell" && /description/i.test(name)) input[name] = args.description ?? "baseline step"
    else if (required.includes(name) && props[name]?.type === "string") input[name] = "baseline"
  }
  return input
}

// One response as Anthropic SSE events.
function* events(content, usage) {
  const id = `msg_mock_${Date.now()}`
  yield ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, usage: { input_tokens: usage.input, output_tokens: 0 } } }]
  for (const [index, block] of content.entries()) {
    if (block.type === "text") {
      yield ["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]
      yield ["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]
    } else {
      yield ["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }]
      yield ["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]
    }
    yield ["content_block_stop", { type: "content_block_stop", index }]
  }
  const stop = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"
  yield ["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output } }]
  yield ["message_stop", { type: "message_stop" }]
}

function respond(res, body, content, { drop = false } = {}) {
  const usage = { input: 100, output: 20 }
  if (!body.stream) {
    const stop = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"
    return json(res, 200, {
      id: `msg_mock_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: "mock",
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: usage.input, output_tokens: usage.output },
    })
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  const all = [...events(content, usage)]
  // "drop": the provider sends part of the stream and the connection dies.
  const send = drop ? all.slice(0, 3) : all
  for (const [event, data] of send) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  if (drop) return res.destroy()
  res.end()
}

async function handleModel(req, res) {
  const body = JSON.parse((await readBody(req)) || "{}")
  const messages = body.messages ?? []
  const tools = body.tools ?? []
  const step = toolResults(messages).length
  const text = lastUserText(messages)
  const entry = {
    n: log.length,
    at: new Date().toISOString(),
    step,
    tools: tools.length,
    // Side requests (titles, summaries) come without tools.
    kind: tools.length ? "agent" : "side",
    restartNotice: /server restarted/i.test(JSON.stringify(messages)),
    lastUserText: text.slice(0, 200),
    // What the model was told the last tool did (e.g. how an interrupted command is reported).
    lastToolResult: JSON.stringify(toolResults(messages).at(-1)?.content ?? null).slice(0, 300),
    outcome: "answered",
  }
  log.push(entry)

  if (!tools.length) return respond(res, body, [{ type: "text", text: "Baseline run" }])

  if (hold !== null && step === hold) {
    hold = null
    entry.outcome = "held"
    await new Promise((release) => {
      held = { step, release }
      req.on("close", release)
    })
    held = null
    if (res.destroyed || res.writableEnded) {
      entry.outcome = "held, connection closed"
      return
    }
    entry.outcome = "held, released"
  }

  if (fail && fail.step === step) {
    const mode = fail.mode
    fail = null
    entry.outcome = `failed (${mode})`
    if (mode === "500") return json(res, 500, { type: "error", error: { type: "api_error", message: "mock failure" } })
  }

  const action = script[step] ?? { type: "text", text: "Done." }
  let content
  if (action.type === "text") content = [{ type: "text", text: action.text }]
  else {
    const tool = findTool(tools, action.type)
    if (!tool) {
      entry.outcome = `no ${action.type} tool in [${tools.map((t) => t.name).join(", ")}]`
      content = [{ type: "text", text: `Mock could not find a ${action.type} tool.` }]
    } else {
      entry.tool = tool.name
      content = [{ type: "tool_use", id: `toolu_mock_${step}_${log.length}`, name: tool.name, input: toolInput(tool, action.type, action) }]
    }
  }
  respond(res, body, content, { drop: entry.outcome === "failed (drop)" })
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://mock")
      if (req.method === "POST" && url.pathname.endsWith("/messages")) return await handleModel(req, res)
      if (url.pathname === "/_control/reset" && req.method === "POST") {
        const cfg = JSON.parse((await readBody(req)) || "{}")
        held?.release()
        script = cfg.script ?? []
        hold = cfg.hold ?? null
        fail = cfg.fail ?? null
        log = []
        return json(res, 200, { ok: true })
      }
      if (url.pathname === "/_control/held") return json(res, 200, { held: held?.step ?? null })
      if (url.pathname === "/_control/release" && req.method === "POST") {
        held?.release()
        return json(res, 200, { ok: true })
      }
      if (url.pathname === "/_log") return json(res, 200, log)
      // Model listing, count_tokens and anything else: harmless defaults.
      if (url.pathname.endsWith("/count_tokens")) return json(res, 200, { input_tokens: 100 })
      json(res, 404, { type: "error", error: { type: "not_found_error", message: url.pathname } })
    } catch (error) {
      json(res, 500, { type: "error", error: { type: "api_error", message: String(error) } })
    }
  })
  .listen(port, () => console.log(`mock model on :${port}`))
