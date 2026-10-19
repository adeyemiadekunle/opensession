import { useState } from "react";
import type { FormRequest, Message, OpenSessionClient, PermissionRequest } from "@opensession/api-client";
import { errText } from "./hooks";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { CopyButton } from "./components/ui/copy-button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { cn } from "./lib/utils";

type Field = {
  key: string;
  title?: string;
  description?: string;
  type?: string;
  options?: Array<string | { value?: unknown; label?: string; title?: string }>;
  default?: unknown;
  required?: boolean;
};

function optValue(o: Field["options"] extends Array<infer T> | undefined ? T : never): string {
  return typeof o === "string" ? o : String(o.value ?? o.label ?? o.title ?? "");
}
function optLabel(o: Field["options"] extends Array<infer T> | undefined ? T : never): string {
  return typeof o === "string" ? o : String(o.label ?? o.title ?? o.value ?? "");
}

/** Pending tool permissions and agent questions for the open session. */
export function Requests({
  client,
  sessionId,
  permissions,
  messages,
  forms,
  onDone,
  allowDomain,
  openBrowser,
}: {
  client: OpenSessionClient;
  sessionId: string;
  permissions: PermissionRequest[];
  messages: Message[];
  forms: FormRequest[];
  onDone: () => void;
  /** Cloud: adds a domain to the sandbox's allowed domains (for the agent's network requests). */
  allowDomain?: (domain: string) => Promise<unknown>;
  /** Cloud: opens the Browser card with control of the agent's tab (for a hand-over). */
  openBrowser?: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const act = async (f: () => Promise<void>) => {
    try {
      setErr(null);
      await f();
      onDone();
    } catch (e) {
      setErr(errText(e));
    }
  };
  const total = permissions.length + forms.length;
  if (!total) return null;
  // Design: approvals float bottom-right as notifications, so they stay visible while typing and
  // don't take space in the conversation column. Requests are answered one at a time, so only the
  // first is shown, with a count of the rest.
  const [first] = permissions;
  const form = first ? undefined : forms[0];
  return (
    <div aria-live="polite" aria-label="Approvals" className="flex w-full flex-col gap-2">
      {err ? <div className="py-1.5 text-[13px] text-destructive">{err}</div> : null}
      {[first].filter((p): p is PermissionRequest => Boolean(p)).map((p) =>
        p.action === HAND_OVER_ACTION ? (
          <HandOverCard
            key={p.id}
            request={p}
            input={requestInput(p, messages)}
            onOpen={openBrowser}
            onDone={() => act(() => client.replyPermission(sessionId, p.id, "once"))}
            onCant={() => act(() => client.replyPermission(sessionId, p.id, "reject", "The user could not do it."))}
          />
        ) : p.action === NETWORK_ACTION && allowDomain ? (
          <DomainCard
            key={p.id}
            request={p}
            input={requestInput(p, messages)}
            onAllow={(domain) =>
              act(async () => {
                await allowDomain(domain); // open first, so the agent's retry works
                await client.replyPermission(sessionId, p.id, "once");
              })
            }
            onDeny={() => act(() => client.replyPermission(sessionId, p.id, "reject"))}
          />
        ) : (
          <PermissionCard
            key={p.id}
            request={p}
            onAllow={(always) => act(() => client.replyPermission(sessionId, p.id, always ? "always" : "once"))}
            onDeny={() => act(() => client.replyPermission(sessionId, p.id, "reject"))}
          />
        ),
      )}
      {form ? <FormCard key={form.id} form={form} onSubmit={(answer) => act(() => client.replyForm(sessionId, form.id, answer))} /> : null}
      {total > 1 ? (
        <div className="px-1 text-xs text-faint">
          {total - 1} more {total - 1 === 1 ? "request" : "requests"} waiting
        </div>
      ) : null}
    </div>
  );
}

const CARD = "flex flex-col gap-2.5 rounded-xl border border-input bg-card p-3.5 shadow-pop";

function PermissionCard({
  request,
  onAllow,
  onDeny,
}: {
  request: PermissionRequest;
  onAllow: (always: boolean) => void;
  onDeny: () => void;
}) {
  const [always, setAlways] = useState(false);
  const resources = (request.resources as string[] | undefined)?.join(", ");
  return (
    <section className={CARD} aria-labelledby={`perm-${request.id}`}>
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
        <h2 id={`perm-${request.id}`} className="text-sm font-semibold">
          Allow {String(request.action ?? "this action")}?
        </h2>
      </div>
      {resources ? (
        <div className="group relative">
          <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-xs leading-[1.6] text-foreground">{resources}</pre>
          <CopyButton getText={() => resources} className="absolute right-1.5 top-1.5" />
        </div>
      ) : null}
      {request.message ? <div className="text-[13px] text-muted-foreground">{String(request.message)}</div> : null}
      <div className="flex items-center gap-2.5">
        <label className="flex flex-1 items-center gap-2 text-xs text-faint">
          <Checkbox checked={always} onCheckedChange={(v) => setAlways(v === true)} />
          Always allow
        </label>
        <Button variant="outline" onClick={onDeny}>
          Deny
        </Button>
        <Button variant="default" onClick={() => onAllow(always)}>
          Allow once
        </Button>
      </div>
    </section>
  );
}

/** The sandbox's tools that need the user (services/sandbox/opensession-mcp.mjs). */
const NETWORK_ACTION = "opensession_request_access";
const HAND_OVER_ACTION = "opensession_hand_over";
const DOMAIN_RE = /^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function requestInput(request: PermissionRequest, messages: Message[]): Record<string, unknown> {
  const source = request.source as { type?: string; messageID?: string; id?: string } | undefined;
  const message = source?.type === "tool" && source.messageID && source.id ? messages.find((m) => m.id === source.messageID) : undefined;
  const part = message?.content?.find((p) => p.type === "tool" && p.id === source?.id && p.name === request.action);
  const input =
    (request.metadata as { input?: unknown } | undefined)?.input ??
    (part?.state as { input?: unknown } | undefined)?.input;
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

/** "https://Docs.Stripe.com/api" -> "docs.stripe.com"; null for anything that isn't a host name. */
export function requestedDomain(input: unknown): string | null {
  const d = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .split(/[/?#]/)[0]!
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  return DOMAIN_RE.test(d) ? d : null;
}

/** Design (approvals): the agent asks to reach a domain; allowing it adds the domain for this account. */
function DomainCard({
  request,
  input,
  onAllow,
  onDeny,
}: {
  request: PermissionRequest;
  input: Record<string, unknown>;
  onAllow: (domain: string) => void;
  onDeny: () => void;
}) {
  const domain = requestedDomain(input.domain);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  return (
    <section className={CARD} aria-labelledby={`perm-${request.id}`}>
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
        <h2 id={`perm-${request.id}`} className="text-sm font-semibold">
          {domain ? (
            <>
              Allow internet access to <span className="font-mono">{domain}</span>?
            </>
          ) : (
            "The agent asked for internet access"
          )}
        </h2>
      </div>
      {reason ? <div className="text-[13px] text-foreground/85">{reason}</div> : null}
      <div className="text-xs text-faint">
        {domain
          ? "The sandbox's shell and browser can then reach it, in every project. Pages there can show the agent text it may act on; allow sites you trust. Remove it any time in Settings."
          : `"${String(input.domain ?? "")}" isn't a domain name, so it can't be allowed.`}
      </div>
      <div className="flex items-center justify-end gap-2.5">
        <Button variant="outline" onClick={onDeny}>
          Deny
        </Button>
        {domain ? (
          <Button variant="default" onClick={() => onAllow(domain)}>
            Allow {domain}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/** The agent hands the browser over for a step only the user can do (sign in, 2FA, CAPTCHA). */
function HandOverCard({
  request,
  input,
  onOpen,
  onDone,
  onCant,
}: {
  request: PermissionRequest;
  input: Record<string, unknown>;
  onOpen?: () => void;
  onDone: () => void;
  onCant: () => void;
}) {
  const task = typeof input.task === "string" && input.task.trim() ? input.task.trim() : "The agent needs you to do a step in the browser.";
  const url = typeof input.url === "string" ? input.url.trim() : "";
  return (
    <section className={CARD} aria-labelledby={`perm-${request.id}`}>
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
        <h2 id={`perm-${request.id}`} className="text-sm font-semibold">
          The agent needs you in the browser
        </h2>
      </div>
      <div className="text-[13.5px] text-foreground">{task}</div>
      {url ? <div className="truncate font-mono text-xs text-faint">{url}</div> : null}
      <div className="text-xs text-faint">
        It's waiting on its tab. Do it there yourself (it never sees what you type), then click Done or just tell it in the chat, and it carries on.
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2.5">
        <Button variant="ghost" onClick={onCant}>
          I can't do it
        </Button>
        {onOpen ? (
          <Button variant="outline" onClick={onOpen}>
            Open the browser
          </Button>
        ) : null}
        <Button variant="default" onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}

/** An "array" question field: several options to tick, shown as checkboxes in a menu. */
function MultiPick({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: string[]) => void }) {
  const chosen = Array.isArray(value) ? (value as string[]) : [];
  const toggle = (v: string, on: boolean) => onChange(on ? [...chosen, v] : chosen.filter((x) => x !== v));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-8 w-full items-center rounded-md border border-input bg-card px-2.5 text-left text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0 flex-1 truncate">{chosen.length ? chosen.join(", ") : "Choose…"}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)]">
        {(field.options ?? []).map((o) => (
          <DropdownMenuCheckboxItem key={optValue(o)} checked={chosen.includes(optValue(o))} onCheckedChange={(v) => toggle(optValue(o), v === true)} onSelect={(e) => e.preventDefault()}>
            {optLabel(o)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FormCard({ form, onSubmit }: { form: FormRequest; onSubmit: (a: Record<string, unknown>) => void }) {
  const fields = ((form.fields ?? []) as Field[]).filter((f) => f && f.key);
  const [vals, setVals] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.default ?? (f.type === "boolean" ? false : "")])),
  );
  const set = (k: string, v: unknown) => setVals((s) => ({ ...s, [k]: v }));
  return (
    <form
      className={cn(CARD, "gap-3")}
      onSubmit={(e) => {
        e.preventDefault();
        const out: Record<string, unknown> = {};
        for (const f of fields) {
          const v = vals[f.key];
          out[f.key] = f.type === "number" || f.type === "integer" ? Number(v) : v;
        }
        onSubmit(out);
      }}
    >
      <h2 className="text-sm font-semibold">{form.title ?? "The agent has a question"}</h2>
      {fields.map((f) => (
        <label key={f.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>{f.title ?? f.key}</span>
          {f.description ? <span className="text-faint">{f.description}</span> : null}
          {f.type === "boolean" ? (
            <Checkbox checked={Boolean(vals[f.key])} onCheckedChange={(v) => set(f.key, v === true)} />
          ) : f.options?.length ? (
            f.type === "array" ? (
              <MultiPick field={f} value={vals[f.key]} onChange={(v) => set(f.key, v)} />
            ) : (
              <Select name={f.key} required={f.required} value={String(vals[f.key] ?? "")} onValueChange={(v) => set(f.key, v)}>
                <SelectTrigger className="w-full" aria-label={f.title ?? f.key}>
                  <SelectValue placeholder="Choose…" />
                </SelectTrigger>
                <SelectContent>
                  {f.options.map((o) => (
                    <SelectItem key={optValue(o)} value={optValue(o)}>
                      {optLabel(o)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )
          ) : (
            <input
              className="h-8 rounded-md border border-input bg-card px-2.5 text-sm text-foreground"
              type={f.type === "number" || f.type === "integer" ? "number" : "text"}
              value={String(vals[f.key] ?? "")}
              required={f.required}
              onChange={(e) => set(f.key, e.target.value)}
            />
          )}
        </label>
      ))}
      <div className="flex justify-end">
        <Button type="submit" variant="default">
          Answer
        </Button>
      </div>
    </form>
  );
}
