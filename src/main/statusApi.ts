import { ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { checkRuntime } from "./runtimeCheck";
import { logFile, userDataDir } from "./paths";
import { onUpdateState, getUpdateState, checkForUpdates, installUpdateNow } from "./updater";
import { setAuthToken } from "./authToken";
import { listLibrary } from "./renderLibrary";
import { DEFAULT_PORT } from "../shared/protocol";
import { isFirebaseConfigured, SITE_API_BASE } from "../shared/firebaseConfig";

/**
 * IPC surface for the status window. Deliberately narrow: runtime/log
 * queries, update state/actions, and a couple of static config values the
 * renderer's own Firebase module needs (isFirebaseConfigured, SITE_API_BASE)
 * — sign-in itself happens entirely in the renderer (see renderer/firebase.ts)
 * since that's the only process with a real browser `window`. All real
 * control of RENDERING happens over the WebSocket from the website, not
 * from this window; this stays a diagnostics + account/update surface.
 */
export function registerStatusApi(mainWindowSender: () => Electron.WebContents | null): void {
  ipcMain.handle("status:get", async () => {
    const runtime = await checkRuntime();
    return { runtime, port: DEFAULT_PORT };
  });

  ipcMain.handle("status:tailLog", async () => {
    try {
      const content = fs.readFileSync(logFile(), "utf8");
      return content.split(/\r?\n/).filter(Boolean).slice(-200).join("\n");
    } catch {
      return "";
    }
  });

  ipcMain.handle("status:config", () => ({
    firebaseConfigured: isFirebaseConfigured(),
    siteApiBase: SITE_API_BASE,
  }));

  // Render stats for the status window — derived live from the local
  // render-library manifest (renderLibrary.ts), never from any server.
  ipcMain.handle("status:stats", () => {
    const entries = listLibrary();
    const totalSeconds = entries.reduce((sum, e) => sum + (e.durationSeconds || 0), 0);
    const totalBytes = entries.reduce((sum, e) => sum + (e.fileSizeBytes || 0), 0);
    const last = entries[0]?.createdAt ?? null; // manifest keeps newest first
    return { totalRenders: entries.length, totalSeconds, totalBytes, lastRenderAt: last };
  });

  ipcMain.handle("auth:push-token", (_event, token: string | null) => {
    setAuthToken(token);
  });

  ipcMain.handle("shell:open-logs", () => {
    try {
      shell.showItemInFolder(path.join(userDataDir(), "agent.log"));
    } catch { /* opening a folder failing is never worth surfacing */ }
  });

  ipcMain.handle("shell:open-external", (_event, url: string) => {
    // only ever open http(s) — never let the renderer hand us a file:// or
    // other scheme that could launch a local program.
    if (typeof url === "string" && /^https?:\/\//.test(url)) {
      void shell.openExternal(url);
    }
  });

  ipcMain.handle("update:check", async () => {
    await checkForUpdates();
    return getUpdateState();
  });
  ipcMain.handle("update:state", () => getUpdateState());
  ipcMain.handle("update:install", () => {
    installUpdateNow();
  });

  onUpdateState((state) => {
    mainWindowSender()?.send("update:state-changed", state);
  });
}
