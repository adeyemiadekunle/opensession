import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "./bridge";

const bridge: DesktopBridge = {
  status: () => ipcRenderer.invoke("local:status"),
  getAgentConfig: () => ipcRenderer.invoke("agent:get"),
  saveAgentConfig: (config) => ipcRenderer.invoke("agent:save", config),
  chooseFolder: () => ipcRenderer.invoke("local:chooseFolder"),
  restart: () => ipcRenderer.invoke("local:restart"),
  openCloud: () => ipcRenderer.invoke("open:cloud"),
  gitCheckout: (branch, create) => ipcRenderer.invoke("git:checkout", branch, Boolean(create)),
  gitPush: () => ipcRenderer.invoke("git:push"),
  gitPullRequest: (title, body) => ipcRenderer.invoke("git:pr", title, body),
  gitCommit: (message) => ipcRenderer.invoke("git:commit", message),
  gitOutgoing: () => ipcRenderer.invoke("git:outgoing"),
  gitChecks: () => ipcRenderer.invoke("git:checks"),
  cloudStatus: () => ipcRenderer.invoke("cloud:status"),
  cloudLogin: () => ipcRenderer.invoke("cloud:login"),
  cloudLogout: () => ipcRenderer.invoke("cloud:logout"),
  cloudHandoff: (commit) => ipcRenderer.invoke("cloud:handoff", commit),
  notify: (title, body) => ipcRenderer.invoke("notify", title, body),
};
contextBridge.exposeInMainWorld("opensession", bridge);
