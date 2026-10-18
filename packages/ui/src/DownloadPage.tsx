import { useEffect, useState } from "react";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import { PageHeader } from "./PageHeader";

type Os = "mac" | "win" | "linux";

interface Installer {
  os: Os;
  label: string;
  file: string;
  note?: string;
}

// Stable names from the Release workflow (apps/desktop/package.json "artifactName").
const INSTALLERS: Installer[] = [
  { os: "mac", label: "macOS, Apple silicon", file: "OpenSession-mac-arm64.dmg", note: "M1 and later" },
  { os: "mac", label: "macOS, Intel", file: "OpenSession-mac-x64.dmg" },
  { os: "win", label: "Windows, x64", file: "OpenSession-win-x64.exe" },
  { os: "win", label: "Windows, Arm", file: "OpenSession-win-arm64.exe" },
  { os: "linux", label: "Linux, AppImage", file: "OpenSession-linux-x86_64.AppImage", note: "any distribution" },
  { os: "linux", label: "Linux, .deb", file: "OpenSession-linux-amd64.deb", note: "Debian, Ubuntu" },
];

const OS_NAME: Record<Os, string> = { mac: "macOS", win: "Windows", linux: "Linux" };

function detectOs(): Os {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Windows/i.test(ua)) return "win";
  if (/Mac/i.test(ua)) return "mac";
  return "linux";
}

function Command({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2 rounded-md border border-input bg-code py-1.5 pl-3 pr-1.5">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px]">{command}</code>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Copy: ${command}`}
          onClick={() => {
            void navigator.clipboard?.writeText(command).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Download page (public): the desktop app for this computer's OS (and the others), and
 * how to install the CLI. Installers come from the repository's latest GitHub release;
 * the install scripts are served by this web app (apps/web/public).
 */
export function DownloadPage({ repo, origin, gatewayUrl, onBack }: { repo: string; origin: string; gatewayUrl: string; onBack?: () => void }) {
  const [os, setOs] = useState<Os>(detectOs);
  const [intelMac, setIntelMac] = useState(false);
  useEffect(() => {
    // Chromium browsers can say whether a Mac is Intel; others default to Apple silicon.
    const uad = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<{ architecture?: string }> } }).userAgentData;
    void uad?.getHighEntropyValues(["architecture"]).then((v) => setIntelMac(v.architecture === "x86")).catch(() => {});
  }, []);
  const base = `https://github.com/${repo}/releases/latest/download`;
  const primary = INSTALLERS.filter((i) => i.os === os)[os === "mac" && intelMac ? 1 : 0]!;
  const host = origin.replace(/\/+$/, "");
  const phone = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PageHeader title="Download" onBack={onBack} />
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-6 px-6 pb-12 pt-8 max-[700px]:px-4">
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[28px] font-semibold tracking-[-0.01em]">Get OpenSession</h1>
            <p className="m-0 text-muted-foreground">
              The desktop app runs the agent on your own folders or in your cloud sandboxes. The CLI does the same from a terminal.
            </p>
          </div>

          <section aria-labelledby="dl-desktop" className="flex flex-col gap-4 rounded-xl border border-input bg-card p-5">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="dl-desktop" className="m-0 flex-1 text-[17px] font-semibold">
                Desktop app
              </h2>
              <div role="radiogroup" aria-label="Operating system" className="inline-flex gap-0.5 rounded-md border border-input p-[3px]">
                {(["mac", "win", "linux"] as Os[]).map((o) => (
                  <button
                    key={o}
                    role="radio"
                    aria-checked={os === o}
                    className={cn("h-7 rounded border-0 px-3 text-[13px]", os === o ? "bg-sunken text-foreground" : "bg-transparent text-faint hover:text-foreground")}
                    onClick={() => setOs(o)}
                  >
                    {OS_NAME[o]}
                  </button>
                ))}
              </div>
            </div>
            {phone ? (
              <p className="m-0 rounded-md border border-input bg-sunken px-3 py-2 text-[13px] text-muted-foreground">
                The desktop app is for computers: open this page on your Mac, Windows or Linux computer, or pick one below.
              </p>
            ) : null}
            <a
              href={`${base}/${primary.file}`}
              className="inline-flex h-11 w-fit items-center rounded-lg bg-primary px-5 text-[15px] font-semibold text-primary-foreground no-underline hover:opacity-90"
            >
              Download for {primary.label}
            </a>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13.5px]">
              {INSTALLERS.filter((i) => i.os === os && i !== primary).map((i) => (
                <li key={i.file}>
                  <a className="text-primary" href={`${base}/${i.file}`}>
                    {i.label}
                  </a>
                  {i.note ? <span className="text-faint"> · {i.note}</span> : null}
                </li>
              ))}
              <li>
                <a className="text-primary" href={`https://github.com/${repo}/releases/latest`}>
                  All files and release notes
                </a>
              </li>
            </ul>
            <p className="m-0 text-[13px] text-muted-foreground">
              {os === "mac"
                ? "Open the .dmg and drag OpenSession to Applications. If macOS says it can't check the app, right-click it, choose Open, then Open again."
                : os === "win"
                  ? "Run the installer. If Windows SmartScreen appears, choose More info, then Run anyway."
                  : "AppImage: make it executable (chmod +x) and run it. .deb: sudo apt install ./OpenSession-linux-amd64.deb"}{" "}
              The first time you open a folder, the app downloads the agent runtime (about 100 MB).
            </p>
          </section>

          <section aria-labelledby="dl-cli" className="flex flex-col gap-4 rounded-xl border border-input bg-card p-5">
            <div className="flex flex-col gap-1">
              <h2 id="dl-cli" className="m-0 text-[17px] font-semibold">
                Command line (CLI)
              </h2>
              <p className="m-0 text-[13.5px] text-muted-foreground">
                Needs Node.js 20 or newer. Installs the agent runtime too; the install script also sets it up for this server.
              </p>
            </div>
            <Command label="macOS and Linux" command={`curl -fsSL ${host}/install.sh | sh`} />
            <Command label="Windows (PowerShell)" command={`irm ${host}/install.ps1 | iex`} />
            <Command label="Or with npm, then point it at this server" command="npm install -g opensession-cli" />
            <Command label="" command={`opensession config --gateway ${gatewayUrl.replace(/\/+$/, "")} --web ${host}`} />
            <p className="m-0 text-[13.5px] text-muted-foreground">
              Then, in a terminal in your project folder, add a model key once with{" "}
              <code className="font-mono text-xs">opensession local key anthropic</code> and run{" "}
              <code className="font-mono text-xs">opensession</code> to chat with the agent there. For your cloud projects, sign in with{" "}
              <code className="font-mono text-xs">opensession login</code>.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
