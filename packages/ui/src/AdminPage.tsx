import { useEffect, useState, type ReactNode } from "react";
import type { AdminLimits, AdminModelUsage, AdminOverview, AdminRoute, CloudClient } from "@opensession/api-client";
import { Meter } from "./AccountPages";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { errText, useAsync } from "./hooks";
import { cn } from "./lib/utils";
import { PageHeader } from "./PageHeader";
import { Switch } from "./SettingsUi";

const REFRESH_MS = 10_000;

function duration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

function ago(t: number): string {
  return `${duration(Math.max(0, Math.round(Date.now() / 1000 - t)))} ago`;
}

/** 1234567 -> "1.2M" */
function tokens(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
  return String(v);
}

function mb(v: number | null | undefined): string {
  if (v == null) return "—";
  return v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${v} MB`;
}

/** A headline number (dataviz: a stat tile, not a chart). Text stays in text colors. */
function Tile({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: "warning" | "danger" }) {
  return (
    <Card className="min-w-0 gap-1 px-4 py-3.5">
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      <span className="text-[24px] font-semibold leading-tight tabular-nums">{value}</span>
      {detail ? (
        <span className="flex items-center gap-1.5 text-xs text-faint">
          {tone ? <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", tone === "danger" ? "bg-destructive" : "bg-warning")} /> : null}
          {detail}
        </span>
      ) : null}
    </Card>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <Card role="region" aria-label={title}>
      <div className="flex items-center gap-3">
        <h2 className="m-0 flex-1 text-[15px] font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </Card>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (!rows.length) return <p className="m-0 text-[13px] text-faint">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="whitespace-nowrap border-b border-border px-2 py-1.5 text-left text-xs font-medium text-muted-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              {r.map((c, j) => (
                <td key={j} className="whitespace-nowrap px-2 py-1.5 align-middle">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** State with a word next to the dot, never color alone. */
function State({ running }: { running: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cn("size-2 rounded-full", running ? "bg-success" : "bg-faint")} />
      {running ? "Running" : "Asleep"}
    </span>
  );
}

const EVENT_LABEL: Record<string, string> = {
  started: "Started",
  slept: "Put to sleep",
  destroyed: "Deleted",
  user_limit: "Hit the user's limit",
  capacity: "Server full",
  start_failed: "Failed to start",
  model_usage_high: "Used 80% of daily model tokens",
  model_limit: "Hit the daily model limit",
};

function eventDetail(e: AdminOverview["events"][number]): string {
  if (e.kind === "slept") {
    const r = String(e.reason ?? "");
    return r === "idle" ? "idle" : r === "make_room" ? "to make room" : r === "manual" ? "by the user" : r.startsWith("admin:") ? `by admin ${r.slice(6)}` : r;
  }
  if (e.kind === "started" && typeof e.seconds === "number") return `in ${e.seconds} s`;
  if (e.kind === "capacity" && typeof e.running === "number") return `${e.running} running`;
  if (e.kind === "start_failed") return String(e.error ?? "");
  if (e.kind === "destroyed") return e.data_deleted ? "with its data" : "data kept";
  if (e.kind === "model_usage_high" || e.kind === "model_limit") return `${tokens(Number(e.tokens))} of ${tokens(Number(e.limit))} tokens`;
  return "";
}

function RouteTable({ routes, empty }: { routes: AdminRoute[] | undefined; empty: string }) {
  return (
    <Table
      head={["Route", "Requests", "p95"]}
      empty={empty}
      rows={(routes ?? []).map((r) => [<code className="font-mono text-xs">{r.route}</code>, r.count, `${r.p95_ms} ms`])}
    />
  );
}

/** Today's heaviest model users (UTC day), against their daily token limit. */
function ModelUsage({ models }: { models: NonNullable<AdminOverview["models"]> }) {
  if (!models.proxy) {
    return (
      <Section title="Model usage">
        <p className="m-0 text-[13px] text-muted-foreground">
          The model proxy is off, so usage isn't measured and provider keys are inside the sandboxes. See the warning above.
        </p>
      </Section>
    );
  }
  const dflt = models.defaults;
  return (
    <Section
      title="Model usage today"
      aside={
        dflt ? (
          <span className="text-xs text-faint">
            Per user: {dflt.tokens_per_day ? `${tokens(dflt.tokens_per_day)} tokens a day` : "no daily limit"} · {dflt.requests_per_minute || "∞"}/min ·{" "}
            {dflt.max_concurrent || "∞"} at once
          </span>
        ) : undefined
      }
    >
      <Table
        head={["User", "Requests", "Input", "Output", "Daily limit", "Now"]}
        empty="No model calls yet today."
        rows={(models.top ?? []).map((u: AdminModelUsage) => {
          const used = u.input_tokens + u.output_tokens;
          return [
            <code className="font-mono text-xs">{u.user}</code>,
            u.requests,
            tokens(u.input_tokens),
            tokens(u.output_tokens),
            u.limit ? (
              <div className="min-w-[140px]">
                <Meter label={`${u.user} daily tokens`} value={used} max={u.limit} detail={`${tokens(used)} of ${tokens(u.limit)}`} />
              </div>
            ) : (
              "No limit"
            ),
            u.active ? `${u.active} streaming` : "—",
          ];
        })}
      />
    </Section>
  );
}

/** Per-user limits: look a user up, override their running projects and disk, or reset. */
function UserLimits({ client }: { client: CloudClient }) {
  const [user, setUser] = useState("");
  const [data, setData] = useState<AdminLimits | null>(null);
  const [form, setForm] = useState({ max_running: "", disk_mb: "", model_tokens_per_day: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = async (u = user) => {
    setMsg(null);
    try {
      const d = await client.adminLimits(u.trim());
      setData(d);
      setForm({
        max_running: d.override.max_running?.toString() ?? "",
        disk_mb: d.override.disk_mb?.toString() ?? "",
        model_tokens_per_day: d.override.model_tokens_per_day?.toString() ?? "",
      });
    } catch (e) {
      setData(null);
      setMsg({ ok: false, text: errText(e) });
    }
  };
  const save = async (reset = false) => {
    const num = (v: string) => (v.trim() === "" ? null : Number(v));
    try {
      const model = data?.defaults.model_tokens_per_day !== undefined;
      const limits = reset
        ? { max_running: null, disk_mb: null, ...(model ? { model_tokens_per_day: null } : {}) }
        : { max_running: num(form.max_running), disk_mb: num(form.disk_mb), ...(model ? { model_tokens_per_day: num(form.model_tokens_per_day) } : {}) };
      await client.adminSetLimits(user.trim(), limits);
      await load();
      setMsg({ ok: true, text: reset ? "Back to the defaults." : "Saved." });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  };
  const field = "h-8 w-full rounded-md border border-input bg-card px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <Section title="User limits">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (user.trim()) void load();
        }}
      >
        <input aria-label="User id" placeholder="User id, e.g. user_2abc…" value={user} onChange={(e) => setUser(e.target.value)} className={cn(field, "max-w-[320px] font-mono")} />
        <Button type="submit" disabled={!user.trim()}>
          Look up
        </Button>
      </form>
      {data ? (
        <div className="grid gap-3 text-[13px] [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
          <label className="flex flex-col gap-1 text-muted-foreground">
            Projects running at once (default {data.defaults.max_running || "no limit"}, now {data.effective.max_running || "no limit"})
            <input inputMode="numeric" placeholder="Default" value={form.max_running} onChange={(e) => setForm((f) => ({ ...f, max_running: e.target.value }))} className={field} />
          </label>
          <label className="flex flex-col gap-1 text-muted-foreground">
            Disk per project in MB (default {data.defaults.disk_mb || "no limit"}, now {data.effective.disk_mb || "no limit"})
            <input inputMode="numeric" placeholder="Default" value={form.disk_mb} onChange={(e) => setForm((f) => ({ ...f, disk_mb: e.target.value }))} className={field} />
          </label>
          {data.defaults.model_tokens_per_day !== undefined ? (
            <label className="flex flex-col gap-1 text-muted-foreground">
              Model tokens a day (default {data.defaults.model_tokens_per_day ? tokens(data.defaults.model_tokens_per_day) : "no limit"}, now{" "}
              {data.effective.model_tokens_per_day ? tokens(data.effective.model_tokens_per_day) : "no limit"}; used today{" "}
              {tokens((data.model_usage_today?.input_tokens ?? 0) + (data.model_usage_today?.output_tokens ?? 0))})
              <input
                inputMode="numeric"
                placeholder="Default"
                value={form.model_tokens_per_day}
                onChange={(e) => setForm((f) => ({ ...f, model_tokens_per_day: e.target.value }))}
                className={field}
              />
            </label>
          ) : null}
          <div className="flex items-end gap-2">
            <Button variant="default" onClick={() => void save()}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => void save(true)}>
              Use defaults
            </Button>
          </div>
        </div>
      ) : null}
      {msg ? <p className={cn("m-0 text-[13px]", msg.ok ? "text-success" : "text-destructive")}>{msg.text}</p> : null}
    </Section>
  );
}

/**
 * Platform admin (ADMIN_USER_IDS): how the gateway and its sandboxes are doing, what went
 * wrong recently, and the controls an operator needs (sleep a sandbox, per-user limits).
 * Everything comes from GET /admin/overview and covers the gateway since it started.
 */
export function AdminPage({ client, onBack }: { client: CloudClient; onBack?: () => void }) {
  const [live, setLive] = useState(true);
  const [tick, setTick] = useState(0);
  const o = useAsync(() => client.adminOverview(), [client, tick]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(t);
  }, [live]);

  const d = o.data;
  const sleep = async (user: string, ws: string) => {
    setBusy(`${user}/${ws}`);
    setErr(null);
    try {
      await client.adminSleep(user, ws);
      setTick((n) => n + 1);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const errorRate = d ? d.requests.error_rate * 100 : 0;
  const mem = d?.host.memory_mb;
  const disk = d?.host.disk_mb;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PageHeader
        title="Admin"
        onBack={onBack}
        aside={
          <span className="flex items-center gap-2.5">
            {d ? `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : null}
            <Switch label="Refresh every 10 seconds" checked={live} onChange={setLive} />
            <span className="text-muted-foreground">Live</span>
          </span>
        }
      />
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-6 pb-12 pt-7 max-[700px]:px-4">
          <div className="flex flex-col gap-1">
            <h1 className="m-0 text-[22px] font-semibold">Platform</h1>
            <p className="m-0 text-sm text-muted-foreground">
              This gateway since it started{d ? ` ${duration(d.gateway.uptime_seconds)} ago` : ""}: requests, sandboxes, errors and events. Figures are for the last 5 minutes
              unless marked. Prometheus can scrape <code className="font-mono text-xs">/admin/metrics</code> with an admin's access token.
            </p>
          </div>

          {o.error ? (
            <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-del-bg px-3.5 py-3 text-[13px]">
              <span className="flex-1">Couldn't load the overview: {o.error}</span>
              <Button size="sm" onClick={() => setTick((n) => n + 1)}>
                Try again
              </Button>
            </div>
          ) : null}
          {err ? <p role="alert" className="m-0 text-[13px] text-destructive">{err}</p> : null}

          {d?.warnings.length ? (
            <div className="flex flex-col gap-2">
              {d.warnings.map((w) => (
                <div
                  key={w.text}
                  role={w.level === "danger" ? "alert" : "status"}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-[13px]",
                    w.level === "danger" ? "border-destructive/40 bg-del-bg" : w.level === "warning" ? "border-warning/40 bg-warning/10" : "border-input bg-card",
                  )}
                >
                  <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", w.level === "danger" ? "bg-destructive" : w.level === "warning" ? "bg-warning" : "bg-faint")} />
                  <span className="sr-only">{w.level === "danger" ? "Danger:" : w.level === "warning" ? "Warning:" : "Note:"}</span>
                  {w.text}
                </div>
              ))}
            </div>
          ) : null}

          {d ? (
            <>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(170px,1fr))]">
                <Tile label="Requests per minute" value={String(d.requests.per_minute)} detail={`${d.requests_hour.requests} in the last hour`} />
                <Tile
                  label="Errors"
                  value={String(d.requests.errors)}
                  detail={`${errorRate.toFixed(1)}% of requests${d.requests.limited ? ` · ${d.requests.limited} rate-limited` : ""}`}
                  tone={errorRate >= 5 ? "danger" : errorRate >= 1 ? "warning" : undefined}
                />
                <Tile label="Latency p95" value={`${d.requests.p95_ms} ms`} detail={`p50 ${d.requests.p50_ms} ms`} />
                <Tile
                  label="Sandboxes running"
                  value={`${d.counts.running} / ${d.counts.max_running || "∞"}`}
                  detail={`${d.counts.sleeping} asleep`}
                  tone={d.counts.max_running && d.counts.running >= d.counts.max_running ? "warning" : undefined}
                />
                <Tile label="Users" value={String(d.counts.users)} detail={`${d.counts.projects} projects`} />
                <Tile label="Uptime" value={duration(d.gateway.uptime_seconds)} detail={`${d.gateway.provider} sandboxes · ${d.gateway.auth_mode} sign-in`} />
              </div>

              <Section title="Server">
                <div className="grid gap-4 text-[13px] [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
                  <div className="flex flex-col gap-2">
                    <span className="text-muted-foreground">Load (1, 5, 15 min)</span>
                    <span className="font-mono">
                      {d.host.load?.join("  ") ?? "—"}
                      {d.host.cpus ? <span className="text-faint"> on {d.host.cpus} CPUs</span> : null}
                    </span>
                  </div>
                  {mem?.total ? (
                    <div className="flex flex-col gap-2">
                      <span className="text-muted-foreground">Memory</span>
                      <Meter label="Memory used" value={mem.total - (mem.available ?? 0)} max={mem.total} detail={`${mb(mem.available)} free of ${mb(mem.total)}`} />
                    </div>
                  ) : null}
                  {disk ? (
                    <div className="flex flex-col gap-2">
                      <span className="text-muted-foreground">Gateway disk</span>
                      <Meter label="Disk used" value={disk.total - disk.free} max={disk.total} detail={`${mb(disk.free)} free of ${mb(disk.total)}`} />
                    </div>
                  ) : null}
                </div>
              </Section>

              <Section title="Sandboxes" aside={<span className="text-xs text-faint">Idle ones sleep after {duration(d.limits.idle_seconds)}</span>}>
                <Table
                  head={["User", "Project", "State", "Open connections", "Idle", "Disk", ""]}
                  empty="No sandboxes yet."
                  rows={d.sandboxes.map((s) => [
                    <code className="font-mono text-xs">{s.user}</code>,
                    s.workspace,
                    <State running={s.state === "running"} />,
                    s.connections,
                    s.busy_seconds != null ? `working ${duration(s.busy_seconds)}` : duration(s.idle_seconds),
                    s.disk_mb != null ? `${mb(s.disk_mb)}${s.disk_limit_mb ? ` of ${mb(s.disk_limit_mb)}` : ""}` : "—",
                    s.state === "running" ? (
                      <Button size="sm" disabled={busy === `${s.user}/${s.workspace}`} onClick={() => void sleep(s.user, s.workspace)}>
                        {busy === `${s.user}/${s.workspace}` ? "Sleeping…" : "Sleep"}
                      </Button>
                    ) : (
                      ""
                    ),
                  ])}
                />
              </Section>

              {d.models ? <ModelUsage models={d.models} /> : null}

              <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(420px,1fr))] max-[700px]:grid-cols-1">
                <Section title="Recent errors" aside={<span className="text-xs text-faint">Server errors and rate limits</span>}>
                  <Table
                    head={["When", "Status", "Request", "User"]}
                    empty="No errors since the gateway started."
                    rows={d.errors.map((e) => [
                      <span className="text-muted-foreground">{ago(e.time)}</span>,
                      <span className="font-mono">{e.status}</span>,
                      <code className="font-mono text-xs">
                        {e.method} {e.route}
                      </code>,
                      e.user ? <code className="font-mono text-xs">{e.user}</code> : "—",
                    ])}
                  />
                </Section>
                <Section title="Events">
                  <Table
                    head={["When", "Event", "User / project", "Detail"]}
                    empty="Nothing yet."
                    rows={d.events.map((e) => [
                      <span className="text-muted-foreground">{ago(e.time)}</span>,
                      EVENT_LABEL[e.kind] ?? e.kind,
                      <code className="font-mono text-xs">
                        {e.workspace ? `${e.user}/${e.workspace}` : e.user}
                      </code>,
                      <span className="text-muted-foreground">{eventDetail(e)}</span>,
                    ])}
                  />
                </Section>
              </div>

              <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(420px,1fr))] max-[700px]:grid-cols-1">
                <Section title="Busiest routes">
                  <RouteTable routes={d.requests.busiest} empty="No requests in the last 5 minutes." />
                </Section>
                <Section title="Slowest routes" aside={<span className="text-xs text-faint">p95, 3 or more requests</span>}>
                  <RouteTable routes={d.requests.slowest} empty="Not enough requests in the last 5 minutes." />
                </Section>
              </div>
            </>
          ) : o.loading ? (
            <div aria-hidden="true" className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(170px,1fr))]">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-[92px] animate-pulse rounded-lg border border-input bg-card motion-reduce:animate-none" />
              ))}
            </div>
          ) : null}

          <UserLimits client={client} />
        </div>
      </main>
    </div>
  );
}
