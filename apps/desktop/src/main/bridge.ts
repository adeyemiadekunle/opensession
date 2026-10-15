/** What the preload script exposes to the window as `window.opensession`. */
export interface LocalStatus {
  folder: string | null;
  running: boolean;
  error: string | null;
}

import type { AgentConfig, AgentConfigResponse } from "@opensession/api-client";

export interface DesktopBridge {
  status(): Promise<LocalStatus>;
  getAgentConfig(): Promise<AgentConfigResponse>;
  /** Writes OpenCode's config on this computer and restarts the local server. */
  saveAgentConfig(config: AgentConfig): Promise<AgentConfigResponse>;
  chooseFolder(): Promise<LocalStatus>;
  restart(): Promise<LocalStatus>;
  openCloud(): Promise<void>;
  /** Local git in the open folder (uses your own git credentials). */
  gitCheckout(branch: string, create?: boolean): Promise<void>;
  gitPush(): Promise<{ branch: string }>;
  /** Opens GitHub's "compare & pull request" page for the current branch. */
  gitPullRequest(title: string, body: string): Promise<{ url: string }>;
}
