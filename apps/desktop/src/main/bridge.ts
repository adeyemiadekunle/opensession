/** What the preload script exposes to the window as `window.opensession`. */
export interface LocalStatus {
  folder: string | null;
  running: boolean;
  error: string | null;
}

export interface CloudStatus {
  signedIn: boolean;
  /** OpenSession user id once checked with the gateway. */
  user: string | null;
  /** The real gateway URL (terminal WebSockets connect there with a one-time ticket). */
  gatewayUrl: string;
  webUrl: string;
}

import type { AgentConfig, AgentConfigResponse, CiChecks, OutgoingChanges } from "@opensession/api-client";
import type { HandoffResult } from "@opensession/local-runner";
export type { OutgoingChanges };

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
  gitCommit(message: string, paths?: string[]): Promise<{ committed: boolean; head: string | null }>;
  gitOutgoing(): Promise<OutgoingChanges>;
  /** CI for the open folder's branch, through the cloud account (needs sign-in). */
  gitChecks(): Promise<CiChecks>;
  /** Cloud account: browser sign-in; the token stays in the main process. */
  cloudStatus(): Promise<CloudStatus>;
  cloudLogin(): Promise<CloudStatus>;
  cloudLogout(): Promise<CloudStatus>;
  /** Push the open folder's branch (committing first if a message is given) and bring it into the cloud project. */
  cloudHandoff(commit?: string): Promise<HandoffResult>;
  /** OS notification. */
  notify(title: string, body: string): Promise<void>;
}
