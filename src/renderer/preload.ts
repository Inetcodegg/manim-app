import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agentStatus", {
  get: () => ipcRenderer.invoke("status:get"),
  tailLog: () => ipcRenderer.invoke("status:tailLog"),
  config: () => ipcRenderer.invoke("status:config"),
  stats: () => ipcRenderer.invoke("status:stats"),
});

contextBridge.exposeInMainWorld("agentAuth", {
  pushToken: (token: string | null) => ipcRenderer.invoke("auth:push-token", token),
});

contextBridge.exposeInMainWorld("agentShell", {
  openLogsFolder: () => ipcRenderer.invoke("shell:open-logs"),
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),
});

contextBridge.exposeInMainWorld("agentUpdate", {
  check: () => ipcRenderer.invoke("update:check"),
  getState: () => ipcRenderer.invoke("update:state"),
  install: () => ipcRenderer.invoke("update:install"),
  onStateChanged: (fn: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => fn(state);
    ipcRenderer.on("update:state-changed", listener);
    return () => ipcRenderer.removeListener("update:state-changed", listener);
  },
});
