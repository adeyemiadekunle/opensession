import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ContentPart, Message } from "@opensession/api-client";
import { MessageView } from "../src/Messages";

const command = "cd /workspace && npm install -D eslint && npx eslint .";
const tool = (status: string): ContentPart => ({ type: "tool", name: "shell", state: { status, input: { command } } });
const render = (over: Partial<Message> = {}) =>
  renderToStaticMarkup(createElement(MessageView, { m: { id: "msg_1", type: "assistant", ...over } }));
const dotCount = (html: string) => (html.match(/\banimate-pulse\b/g) ?? []).length;

describe("message activity", () => {
  it.each(["pending", "running", "streaming"])("shows only the tool's indicator while it is %s", (status) => {
    const html = render({ content: [tool(status)] });
    expect(dotCount(html)).toBe(3);
    expect(html).toContain("Running");
    expect(html).not.toContain("Working");
    expect(html.split(command.replaceAll("&", "&amp;"))).toHaveLength(2);
  });

  it("recognizes tool states encoded as strings", () => {
    const html = render({ content: [{ type: "tool", name: "shell", state: "running" }] });
    expect(dotCount(html)).toBe(3);
    expect(html).not.toContain("Working");
  });

  it("keeps one indicator per tool when several tools run together", () => {
    const html = render({ content: [tool("running"), { type: "tool", name: "read", state: { status: "pending" } }] });
    expect(dotCount(html)).toBe(6);
    expect(html).not.toContain("Working");
  });

  it("still detects an active tool before later completed parts", () => {
    const html = render({ content: [tool("running"), tool("completed"), { type: "text", text: "Checking output." }] });
    expect(dotCount(html)).toBe(3);
    expect(html).not.toContain("Working");
  });

  it.each<{ name: string; content: ContentPart[] }>([
    { name: "empty content", content: [] },
    { name: "streaming text", content: [{ type: "text", text: "I am checking the result." }] },
    { name: "reasoning", content: [{ type: "reasoning", text: "Consider the next step." }] },
    { name: "completed tool", content: [tool("completed")] },
    { name: "failed tool", content: [tool("error")] },
  ])("shows working activity between tool calls ($name)", ({ content }) => {
    const html = render({ content });
    expect(html).toContain("Working…");
    expect(dotCount(html)).toBe(3);
  });

  it("uses staggered pulsing dots instead of a ring, with a reduced-motion fallback", () => {
    const html = render({ content: [tool("running")] });
    expect(dotCount(html)).toBe(3);
    expect(html).not.toContain("animate-spin");
    expect(html).toContain("[animation-delay:150ms]");
    expect(html).toContain("[animation-delay:300ms]");
    expect(html.match(/motion-reduce:animate-none/g)).toHaveLength(3);
  });

  it("removes working activity once the assistant finishes", () => {
    const html = render({ content: [tool("completed")], time: { created: 1, completed: 2 } });
    expect(dotCount(html)).toBe(0);
    expect(html).not.toContain("Working");
  });

  it("preserves the retry status instead of a generic working indicator", () => {
    const html = render({ retry: { attempt: 2, at: Date.now() + 60_000, error: { message: "Service unavailable" } } });
    expect(html).toContain('role="status"');
    expect(html).toContain("Service unavailable");
    expect(html).toContain("retrying in");
    expect(html).toContain("attempt 2");
    expect(dotCount(html)).toBe(3);
    expect(html).not.toContain("Working");
  });

  it("does not show working activity after an assistant error", () => {
    const html = render({ error: { message: "Request failed" } });
    expect(html).toContain("Request failed");
    expect(dotCount(html)).toBe(0);
    expect(html).not.toContain("Working");
  });

  it("uses the same dots for a running shell message", () => {
    const html = render({ type: "shell", status: "running", command });
    expect(dotCount(html)).toBe(3);
    expect(html).not.toContain("Working");
  });

  it("shows a system message label instead of the raw injected context", () => {
    const html = render({
      type: "system",
      text: "<mcp_instructions>\n  <server name=\"opensession\">…</server>\n</mcp_instructions>",
      description: "Instructions updated: core/mcp-guidance",
    });
    expect(html).toContain("Instructions updated: core/mcp-guidance");
    expect(html).not.toContain("mcp_instructions");
  });

  it("keeps showing synthetic text that has no label", () => {
    const html = render({ type: "synthetic", text: "Summary of earlier conversation." });
    expect(html).toContain("Summary of earlier conversation.");
  });
});
