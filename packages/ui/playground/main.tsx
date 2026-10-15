import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Bot, MessageSquare, Settings } from "lucide-react";
import "../src/styles/globals.css";
import { ThemeToggle, Workspace, useTheme } from "../src";
import { FakeClient, fakeGit, fakeTerminal } from "./fake";

const client = new FakeClient();

function Playground() {
  useTheme();
  return (
    <Workspace
      client={client}
      git={fakeGit}
      terminal={fakeTerminal}
      skills={["git-release"]}
      commands={[{ name: "review", description: "Review a file" }]}
      environment={{ kind: "local", label: "This computer", detail: "~/Desktop/Kunemi/open-session" }}
      shell={{
        header: (
          <div className="px-1 pt-1 text-sm font-semibold">
            OpenSession <span className="text-xs font-normal text-muted-foreground">playground</span>
          </div>
        ),
        nav: [
          { id: "w", label: "Workspace", icon: MessageSquare, active: true, onSelect: () => undefined },
          { id: "a", label: "Agent setup", icon: Bot, onSelect: () => undefined },
          { id: "s", label: "Settings", icon: Settings, onSelect: () => undefined },
        ],
        footer: (
          <div className="flex items-center px-1 text-xs text-muted-foreground">
            Adeyemi · Pro
            <span className="ml-auto">
              <ThemeToggle />
            </span>
          </div>
        ),
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Playground />
  </StrictMode>,
);
