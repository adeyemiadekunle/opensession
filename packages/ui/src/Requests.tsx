import { useState } from "react";
import type { FormRequest, OpenSessionClient, PermissionRequest } from "@opensession/api-client";
import { errText } from "./hooks";

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
  return (
    <div className="os-requests">
      {err ? <div className="os-error">{err}</div> : null}
      {permissions.map((p) => {
        const resources = (p.resources as string[] | undefined)?.join(", ");
        return (
          <div key={p.id} className="os-request">
            <div>
              <strong>Allow {String(p.action ?? "this action")}?</strong>
              {resources ? <div className="os-path">{resources}</div> : null}
              {p.message ? <div className="os-muted">{String(p.message)}</div> : null}
            </div>
            <div className="os-row">
              <button onClick={() => act(() => client.replyPermission(sessionId, p.id, "once"))}>Allow once</button>
              <button onClick={() => act(() => client.replyPermission(sessionId, p.id, "always"))}>Always</button>
              <button className="os-danger" onClick={() => act(() => client.replyPermission(sessionId, p.id, "reject"))}>
                Deny
              </button>
            </div>
          </div>
        );
      })}
      {forms.map((f) => (
        <FormCard key={f.id} form={f} onSubmit={(answer) => act(() => client.replyForm(sessionId, f.id, answer))} />
      ))}
    </div>
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
      className="os-request os-form"
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
      <strong>{form.title ?? "The agent has a question"}</strong>
      {fields.map((f) => (
        <label key={f.key} className="os-field">
          <span>{f.title ?? f.key}</span>
          {f.description ? <span className="os-muted">{f.description}</span> : null}
          {f.type === "boolean" ? (
            <input type="checkbox" checked={Boolean(vals[f.key])} onChange={(e) => set(f.key, e.target.checked)} />
          ) : f.options?.length ? (
            <select
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
            </select>
          ) : (
            <input
              type={f.type === "number" || f.type === "integer" ? "number" : "text"}
              value={String(vals[f.key] ?? "")}
              required={f.required}
              onChange={(e) => set(f.key, e.target.value)}
            />
          )}
        </label>
      ))}
      <div className="os-row">
        <button type="submit">Answer</button>
      </div>
    </form>
  );
}
