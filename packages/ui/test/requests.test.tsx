import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, OpenSessionClient, PermissionRequest } from "@opensession/api-client";
import { Requests, requestedDomain } from "../src/Requests";

const clicks = vi.hoisted(() => new Map<string, () => unknown>());
vi.mock("../src/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => unknown }) => {
    if (onClick) clicks.set(Array.isArray(children) ? children.join("") : String(children), onClick);
    return createElement("button", { onClick }, children);
  },
}));

const input = { domain: "docs.example.com", reason: "Read the API documentation" };
const permission: PermissionRequest = {
  id: "per_1",
  sessionID: "ses_1",
  action: "opensession_request_access",
  resources: ["*"],
  metadata: {},
  source: { type: "tool", messageID: "msg_1", id: "call_1" },
};
const message: Message = {
  id: "msg_1",
  type: "assistant",
  content: [{ type: "tool", id: "call_1", name: "opensession_request_access", state: { status: "running", input } }],
};

function render(request = permission, messages = [message], allowDomain = vi.fn(async (_domain: string) => {})) {
  const replyPermission = vi.fn(async () => {});
  const onDone = vi.fn();
  const html = renderToStaticMarkup(createElement(Requests, {
    client: { replyPermission } as unknown as OpenSessionClient,
    sessionId: "ses_1",
    permissions: [request],
    messages,
    forms: [],
    onDone,
    allowDomain,
  }));
  return { html, allowDomain, replyPermission, onDone };
}

beforeEach(() => clicks.clear());

describe("network approvals", () => {
  it("gets the domain and reason from the linked tool when V2 sends empty metadata", () => {
    const { html } = render();
    expect(html).toContain("Allow internet access to");
    expect(html).toContain("Read the API documentation");
    expect(clicks.has("Allow docs.example.com")).toBe(true);
  });

  it("still supports input supplied in permission metadata", () => {
    const { html } = render({ ...permission, metadata: { input } }, []);
    expect(html).toContain(input.reason);
    expect(clicks.has("Allow docs.example.com")).toBe(true);
  });

  it("opens the domain before resuming the waiting tool", async () => {
    let release!: () => void;
    const allowDomain = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const { replyPermission, onDone } = render(permission, [message], allowDomain);
    const pending = clicks.get("Allow docs.example.com")!();
    expect(allowDomain).toHaveBeenCalledWith("docs.example.com");
    expect(replyPermission).not.toHaveBeenCalled();
    release();
    await pending;
    expect(replyPermission).toHaveBeenCalledWith("ses_1", "per_1", "once");
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("does not resume the tool when allowing the domain fails", async () => {
    const allowDomain = vi.fn(async () => { throw new Error("proxy unavailable"); });
    const { replyPermission, onDone } = render(permission, [message], allowDomain);
    await clicks.get("Allow docs.example.com")!();
    expect(replyPermission).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("denies the request without opening the domain", async () => {
    const { allowDomain, replyPermission } = render();
    await clicks.get("Deny")!();
    expect(replyPermission).toHaveBeenCalledWith("ses_1", "per_1", "reject");
    expect(allowDomain).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing message", messages: [] },
    { name: "different message", messages: [{ ...message, id: "msg_other" }] },
    { name: "different call", messages: [{ ...message, content: [{ ...message.content![0]!, id: "call_other" }] }] },
    { name: "different tool", messages: [{ ...message, content: [{ ...message.content![0]!, name: "execute" }] }] },
    { name: "missing input", messages: [{ ...message, content: [{ ...message.content![0]!, state: "running" }] }] },
  ])("does not guess a domain with $name", ({ messages }) => {
    render(permission, messages);
    expect([...clicks.keys()]).toEqual(["Deny"]);
  });

  it("does not allow invalid domain input", () => {
    render({ ...permission, metadata: { input: { domain: "127.0.0.1" } } });
    expect([...clicks.keys()]).toEqual(["Deny"]);
  });

  it("resolves browser hand-over details through the same source link", () => {
    const action = "opensession_hand_over";
    const { html } = render({ ...permission, action }, [{ ...message, content: [{
      type: "tool", id: "call_1", name: action,
      state: { status: "running", input: { task: "Sign in to the test account", url: "https://example.com/login" } },
    }] }]);
    expect(html).toContain("Sign in to the test account");
    expect(html).toContain("https://example.com/login");
  });
});

describe("requestedDomain", () => {
  it("normalizes URLs and wildcard host names", () => {
    expect(requestedDomain("https://Docs.Example.com:443/api?q=x")).toBe("docs.example.com");
    expect(requestedDomain("*.example.com")).toBe("*.example.com");
  });
  it.each([undefined, "", "localhost", "127.0.0.1", "[::1]", "example.com; bad"])("rejects %s", (domain) => {
    expect(requestedDomain(domain)).toBeNull();
  });
});
