import { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import { AgentServer } from "./wsServer";
import { checkRuntime } from "./runtimeCheck";
import { registerStatusApi } from "./statusApi";
import { initAutoUpdate } from "./updater";
import { log } from "./logger";
import { userDataDir, jobsDir } from "./paths";
import { DEFAULT_PORT } from "../shared/protocol";

/**
 * Entry point. This app has no "main window" in the usual sense — it's a
 * background agent the site talks to over WebSocket, so the primary UI is
 * a system tray icon (Windows norm for a background helper) plus a small
 * status window you can open from it. Closing the status window never
 * quits the app; only "Quit" in the tray menu does, so a render already in
 * progress can't be killed by an accidental window close.
 *
 * Every failure mode this process can hit — a crash in a background
 * promise, a truly uncaught exception, the WebSocket port already being in
 * use — is caught here and turned into a visible tray tooltip / log entry
 * instead of the process silently dying. A background agent that vanishes
 * without a trace is much worse than one that stays up and says "there's a
 * problem, here's what."
 */

let tray: Tray | null = null;
let statusWindow: BrowserWindow | null = null;
let agent: AgentServer | null = null;

/** The tray/window icon. In the PACKAGED app only dist/ ships (build/ is a
 *  build-resources dir left out of the installer), so copy-static.js drops
 *  a copy at dist/assets/tray-icon.png — __dirname is dist/main/ at runtime,
 *  so that's ../assets. The build/ path is the dev (unpackaged) fallback. */
function trayIconPath(): string {
  const packaged = path.join(__dirname, "..", "assets", "tray-icon.png");
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, "..", "..", "build", "tray-icon.png");
}

process.on("uncaughtException", (err) => {
  log.error("uncaughtException:", err.stack ?? String(err));
  updateTrayTooltip("Manim Studio Render Agent — an unexpected error occurred, see logs");
});

process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection:", reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
});

// Single-instance lock — a second launch (e.g. the user double-clicking the
// desktop shortcut again) should focus the existing agent's status window,
// never start a second WebSocket server fighting the first for the port.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showStatusWindow();
  });

  app.whenReady().then(main).catch((err) => {
    log.error("fatal startup error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    try {
      dialog.showErrorBox(
        "Manim Studio Render Agent",
        "The render agent could not start. Check agent.log in the app's data folder for details, or try reinstalling the app.",
      );
    } catch {
      /* dialog itself failing is not worth crashing over */
    }
  });
}

async function main(): Promise<void> {
  fs.mkdirSync(userDataDir(), { recursive: true });
  fs.mkdirSync(jobsDir(), { recursive: true });

  registerStatusApi(() => (statusWindow && !statusWindow.isDestroyed() ? statusWindow.webContents : null));
  createTray();
  initAutoUpdate();

  agent = new AgentServer();
  try {
    await agent.start(DEFAULT_PORT);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("failed to start WebSocket agent:", message);
    updateTrayTooltip(
      message.includes("EADDRINUSE")
        ? "Manim Studio Render Agent — port already in use (another copy running?)"
        : "Manim Studio Render Agent — failed to start, see logs",
    );
    showStatusWindow();
    return;
  }

  let status;
  try {
    status = await checkRuntime();
  } catch (err) {
    log.error("runtime check threw during startup:", String(err));
    updateTrayTooltip("Manim Studio Render Agent — could not verify install, see logs");
    return;
  }
  updateTrayTooltip(
    status.ready
      ? "Manim Studio Render Agent — ready"
      : "Manim Studio Render Agent — install problem, click for details",
  );
  if (!status.ready) showStatusWindow();

  // don't show a window on a healthy launch — this runs quietly in the
  // tray: open manim-std.vercel.app in your normal browser and it just
  // connects. window-all-closed intentionally does nothing, since this is
  // a background agent, not a document-style app.
  app.on("window-all-closed", () => {
    // no-op by design
  });
}

function createTray(): void {
  try {
    const iconPath = trayIconPath();
    const image = fs.existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();
    tray = new Tray(image);
    tray.setToolTip("Manim Studio Render Agent");
    tray.on("click", showStatusWindow);
    rebuildTrayMenu();
  } catch (err) {
    // a tray icon failing to create (rare, but has happened on some Windows
    // configs with a locked icon cache) shouldn't take the whole agent down
    // — the WebSocket server is what actually matters functionally.
    log.error("failed to create tray icon:", String(err));
  }
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: "Open status window", click: showStatusWindow },
    {
      label: "Open logs folder",
      click: () => {
        try {
          shell.showItemInFolder(path.join(userDataDir(), "agent.log"));
        } catch (err) {
          log.warn("failed to open logs folder:", String(err));
        }
      },
    },
    { type: "separator" },
    {
      label: "Verify install",
      click: async () => {
        try {
          const status = await checkRuntime();
          updateTrayTooltip(
            status.ready
              ? "Manim Studio Render Agent — ready"
              : `Manim Studio Render Agent — problem: ${status.detail.join(" ")}`,
          );
        } catch (err) {
          log.error("verify install failed:", String(err));
        }
        showStatusWindow();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: async () => {
        try {
          await agent?.stop();
        } catch (err) {
          log.warn("error during shutdown:", String(err));
        }
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function updateTrayTooltip(text: string): void {
  try {
    tray?.setToolTip(text);
  } catch {
    /* tooltip update failing is cosmetic, never worth surfacing further */
  }
}

function showStatusWindow(): void {
  try {
    if (statusWindow && !statusWindow.isDestroyed()) {
      statusWindow.show();
      statusWindow.focus();
      return;
    }
    statusWindow = new BrowserWindow({
      width: 460,
      height: 720,
      resizable: true,
      minWidth: 400,
      minHeight: 500,
      minimizable: true,
      maximizable: false,
      title: "Manim Studio Render Agent",
      icon: trayIconPath(),
      backgroundColor: "#0d0d10",
      webPreferences: {
        preload: path.join(__dirname, "..", "renderer", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    statusWindow.setMenuBarVisibility(false);
    void statusWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
    statusWindow.on("close", (e) => {
      // hide, don't destroy — keeps the render agent alive in the tray
      e.preventDefault();
      statusWindow?.hide();
    });
    statusWindow.webContents.on("render-process-gone", (_e, details) => {
      log.error("status window renderer process gone:", JSON.stringify(details));
    });
  } catch (err) {
    log.error("failed to open status window:", String(err));
  }
}
