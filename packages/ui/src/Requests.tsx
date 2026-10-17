import { useState } from "react";
import type { FormRequest, OpenSessionClient, PermissionRequest } from "@opensession/api-client";
import { errText } from "./hooks";
import { Button } from "./components/ui/button";
import { Select } from "./components/ui/select";
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
  forms,
  onDone,
}: {
  client: OpenSessionClient;
  sessionId: string;
  permissions: PermissionRequest[];
  forms: FormRequest[];
  onDone: () => void;
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
  if (!permissions.length && !forms.length) return null;
  // Design: approvals float above the composer, so they stay visible while typing.
  return (
    <div aria-live="polite" aria-label="Approvals" className="absolute inset-x-0 bottom-full z-10 flex max-w-[640px] flex-col gap-2 pb-2 pl-10 pr-7">
      {err ? <div className="os-error">{err}</div> : null}
      {permissions.map((p) => (
        <PermissionCard
          key={p.id}
          request={p}
          onAllow={(always) => act(() => client.replyPermission(sessionId, p.id, always ? "always" : "once"))}
          onDeny={() => act(() => client.replyPermission(sessionId, p.id, "reject"))}
        />
      ))}
      {forms.map((f) => (
        <FormCard key={f.id} form={f} onSubmit={(answer) => act(() => client.replyForm(sessionId, f.id, answer))} />
      ))}
    </div>
  );
}

const CARD = "flex flex-col gap-2.5 rounded-xl border border-input bg-card p-3.5 shadow-[0_12px_32px_rgba(0,0,0,0.45)]";

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
      {resources ? <pre className="os-pre whitespace-pre-wrap">{resources}</pre> : null}
      {request.message ? <div className="text-[13px] text-muted-foreground">{String(request.message)}</div> : null}
      <div className="flex items-center gap-2.5">
        <label className="flex flex-1 items-center gap-2 text-xs text-faint">
          <input type="checkbox" className="accent-primary" checked={always} onChange={(e) => setAlways(e.target.checked)} />
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
            <input type="checkbox" checked={Boolean(vals[f.key])} onChange={(e) => set(f.key, e.target.checked)} />
          ) : f.options?.length ? (
            <Select
              className="h-auto text-sm"
              multiple={f.type === "array"}
              value={vals[f.key] as string | string[]}
              onChange={(e) =>
                set(f.key, f.type === "array" ? Array.from(e.target.selectedOptions).map((o) => o.value) : e.target.value)
              }
            >
              {f.type !== "array" ? <option value="">Choose…</option> : null}
              {f.options.map((o) => (
                <option key={optValue(o)} value={optValue(o)}>
                  {optLabel(o)}
                </option>
              ))}
            </Select>
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
