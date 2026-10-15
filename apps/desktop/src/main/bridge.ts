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
}
