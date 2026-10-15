import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@opensession/ui/components/sidebar";
import { TooltipProvider } from "@opensession/ui/components/tooltip";

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  active?: boolean;
  onSelect: () => void;
}

/** What the app (web or desktop) puts around every page. */
export interface ShellSlots {
  /** Top of the sidebar: brand, project picker, "This computer / Cloud" switch. */
  header?: ReactNode;
  /** Main navigation (Projects, Agent setup, Settings ...). */
  nav?: NavItem[];
  /** Bottom of the sidebar: account, sign out. */
  footer?: ReactNode;
}

export interface AppShellProps {
  slots?: ShellSlots;
  /** Extra sidebar content under the navigation, e.g. the project's sessions. */
  sidebar?: ReactNode;
  /** Top bar: the page or session title. */
  title?: ReactNode;
  /** Top bar, right side: panel toggles. */
  toolbar?: ReactNode;
  children: ReactNode;
}

/** The app frame from the design: a collapsible sidebar (navigation, sessions,
 *  account), a top bar (title, panel toggles) and the page below it. */
export function AppShell({ slots = {}, sidebar, title, toolbar, children }: AppShellProps) {
  return (
    <TooltipProvider>
      <SidebarProvider className="h-svh min-h-0">
        <Sidebar collapsible="offcanvas">
          {slots.header ? <SidebarHeader>{slots.header}</SidebarHeader> : null}
          <SidebarContent>
            {slots.nav?.length ? (
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {slots.nav.map((n) => (
                      <SidebarMenuItem key={n.id}>
                        <SidebarMenuButton isActive={n.active} onClick={n.onSelect} tooltip={n.label}>
                          <n.icon />
                          <span>{n.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ) : null}
            {sidebar}
          </SidebarContent>
          {slots.footer ? <SidebarFooter>{slots.footer}</SidebarFooter> : null}
        </Sidebar>
        <SidebarInset className="min-h-0 overflow-hidden">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <SidebarTrigger className="-ml-1" />
            <div className="min-w-0 flex-1 truncate text-sm font-medium">{title}</div>
            {toolbar ? <div className="flex items-center gap-1">{toolbar}</div> : null}
          </header>
          <div className="min-h-0 flex-1">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
