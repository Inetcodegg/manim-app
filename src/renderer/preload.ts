import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agentStatus", {
  get: () => ipcRenderer.invoke("status:get"),
  tailLog: () => ipcRenderer.invoke("status:tailLog"),
  config: () => ipcRenderer.invoke("status:config"),
});

contextBridge.exposeInMainWorld("agentAuth", {
  pushToken: (token: string | null) => ipcRenderer.invoke("auth:push-token", token),
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
