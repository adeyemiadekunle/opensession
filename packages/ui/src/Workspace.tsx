import { useState, type ReactNode } from "react";
import { FolderTree, GitCompareArrows, Globe, PanelRight, Plus, SquareTerminal, Trash2, X, type LucideIcon } from "lucide-react";
import type { GitActions, OpenSessionClient, TerminalApi } from "@opensession/api-client";
import { Button } from "@opensession/ui/components/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@opensession/ui/components/resizable";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@opensession/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@opensession/ui/components/tooltip";
import { cn } from "@opensession/ui/lib/utils";
import { storageGet, storageSet } from "./hooks";
import { DiffPanel, FilesPanel } from "./Panels";
import { GitPanel } from "./GitPanel";
import { TerminalPanel } from "./TerminalPanel";
import { AppShell, type ShellSlots } from "./shell/AppShell";
import { ChatView } from "./workspace/ChatView";
import { SessionRail, type EnvironmentInfo } from "./workspace/SessionRail";
import { useWorkspace } from "./workspace/useWorkspace";

export interface WorkspaceProps {
  client: OpenSessionClient;
  /** Shown when no models are available (e.g. "add an API key in Settings"). */
  noModels?: ReactNode;
  /** Skill ids from the agent setup, for @mentions and suggestions. */
  skills?: string[];
  /** Primary agents defined in the agent setup (built-ins are always offered). */
  agents?: string[];
  /** Commands from the agent setup; shown even before OpenCode has listed them. */
  commands?: { name: string; description?: string | null }[];
  /** A shell in the workspace (Terminal panel). */
  terminal?: TerminalApi;
  /** Branch actions (commit, push, pull request, CI) for the Changes panel. */
  git?: GitActions;
  /** The app's sidebar header, navigation and footer. */
  shell?: ShellSlots;
  /** Where this workspace runs, for the session rail. */
  environment?: EnvironmentInfo;
}

type PanelId = "rail" | "terminal" | "changes" | "files";
const PANELS_KEY = "opensession.panels";

function savedPanels(): PanelId[] {
  try {
    const v = JSON.parse(storageGet(PANELS_KEY) ?? "null");
    if (Array.isArray(v)) return v.filter((x): x is PanelId => ["rail", "terminal", "changes", "files"].includes(x));
  } catch {
    /* default below */
  }
  return ["rail"];
}

function ToolbarToggle({ icon: Icon, label, on, onClick, disabled }: { icon: LucideIcon; label: string; on?: boolean; onClick?: () => void; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            aria-pressed={on}
            disabled={disabled}
            className={cn(on && "bg-accent text-accent-foreground")}
            onClick={onClick}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function PanelFrame({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm font-medium">
        {title}
        <Button size="icon-xs" variant="ghost" className="ml-auto" aria-label={`Close ${title}`} onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="os-legacy min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

/** The workspace from the design: sessions in the sidebar, the chat in the middle,
 *  the session rail and resizable Terminal / Changes / Files panels on the right.
 *  Works for cloud and local alike. */
export function Workspace({ client, noModels, skills = [], agents = [], commands = [], git, terminal, shell, environment }: WorkspaceProps) {
  const w = useWorkspace(client, { skills, agents, commands });
  const [open, setOpen] = useState<PanelId[]>(savedPanels);
  const toggle = (p: PanelId, force?: boolean) =>
    setOpen((cur) => {
      const on = force ?? !cur.includes(p);
      const next = on ? [...cur.filter((x) => x !== p), p] : cur.filter((x) => x !== p);
      storageSet(PANELS_KEY, JSON.stringify(next));
      return next;
    });
  const is = (p: PanelId) => open.includes(p);
  const tools = (["terminal", "changes", "files"] as const).filter((p) => is(p) && (p !== "terminal" || terminal));
  const activeSession = w.sessionList.find((s) => s.id === w.active);

  const sessions = (
    <SidebarGroup>
      <SidebarGroupLabel>Sessions</SidebarGroupLabel>
      <SidebarGroupAction title="New session" onClick={() => void w.newSession()} disabled={!w.chosen}>
        <Plus />
      </SidebarGroupAction>
      <SidebarGroupContent>
        <SidebarMenu>
          {w.sessionList.map((s) => (
            <SidebarMenuItem key={s.id}>
              <SidebarMenuButton isActive={s.id === w.active} onClick={() => w.setActive(s.id)} title={s.title}>
                <span className="truncate">{s.title || new Date(s.time?.created ?? 0).toLocaleString()}</span>
              </SidebarMenuButton>
              <SidebarMenuAction
                showOnHover
                title="Delete session"
                onClick={() => {
                  if (globalThis.confirm?.("Delete this session?") ?? true) void w.removeSession(s.id);
                }}
              >
                <Trash2 />
              </SidebarMenuAction>
            </SidebarMenuItem>
          ))}
          {!w.sessionList.length ? <div className="px-2 py-1 text-xs text-muted-foreground">No sessions yet</div> : null}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );

  const toolbar = (
    <>
      <ToolbarToggle icon={PanelRight} label="Session details" on={is("rail")} onClick={() => toggle("rail")} />
      {terminal ? <ToolbarToggle icon={SquareTerminal} label="Terminal" on={is("terminal")} onClick={() => toggle("terminal")} /> : null}
      <ToolbarToggle icon={GitCompareArrows} label="Changes" on={is("changes")} onClick={() => toggle("changes")} />
      <ToolbarToggle icon={FolderTree} label="Files" on={is("files")} onClick={() => toggle("files")} />
      <ToolbarToggle icon={Globe} label="Browser (coming later)" disabled />
    </>
  );

  return (
    <AppShell slots={shell} sidebar={sessions} title={activeSession?.title || (w.active ? "Session" : "New session")} toolbar={toolbar}>
      <ResizablePanelGroup orientation="horizontal" className="h-full">
        <ResizablePanel id="chat" minSize="360px">
          <ChatView w={w} noModels={noModels} />
        </ResizablePanel>
        {is("rail") ? (
          <>
            <ResizableHandle />
            <ResizablePanel id="rail" defaultSize="24" minSize="260px" maxSize="40">
              <SessionRail
                w={w}
                git={git}
                environment={environment}
                onOpenChanges={() => toggle("changes", true)}
                onOpenFile={() => toggle("files", true)}
              />
            </ResizablePanel>
          </>
        ) : null}
        {tools.length ? (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel id="tools" defaultSize="36" minSize="280px">
              <ResizablePanelGroup orientation="vertical">
                {tools.map((p, i) => (
                  <ToolPanel key={p} id={p} first={i === 0}>
                    <PanelFrame
                      title={p === "terminal" ? "Terminal" : p === "changes" ? "Changes" : "Files"}
                      onClose={() => toggle(p, false)}
                    >
                      {p === "terminal" && terminal ? (
                        <TerminalPanel api={terminal} />
                      ) : p === "changes" ? (
                        <div className="space-y-2">
                          <GitPanel client={client} actions={git} refreshKey={w.refreshKey} />
                          <DiffPanel client={client} refreshKey={w.refreshKey} />
                        </div>
                      ) : (
                        <FilesPanel client={client} refreshKey={w.refreshKey} />
                      )}
                    </PanelFrame>
                  </ToolPanel>
                ))}
              </ResizablePanelGroup>
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
    </AppShell>
  );
}

function ToolPanel({ id, first, children }: { id: string; first: boolean; children: ReactNode }) {
  return (
    <>
      {first ? null : <ResizableHandle />}
      <ResizablePanel id={id} minSize="15">
        {children}
      </ResizablePanel>
    </>
  );
}
