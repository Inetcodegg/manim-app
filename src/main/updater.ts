import { autoUpdater } from "electron-updater";
import { UPDATE_REPO } from "../shared/firebaseConfig";
import { log } from "./logger";

/**
 * Auto-update via electron-updater against GitHub Releases. When a new
 * version is published there, running agents notice within a few hours
 * (and immediately on launch), download it in the background, and prompt
 * to restart-and-install — the "we send something to the user to update
 * the app" the whole feature is about. Every step is wrapped so a check
 * failing (no internet, GitHub unreachable, no releases yet) just logs and
 * moves on; it must never be able to crash or hang the agent.
 */

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "available"; version: string }
  | { phase: "not-available" }
  | { phase: "downloading"; percent: number }
  | { phase: "downloaded"; version: string }
  | { phase: "error"; message: string };

type Listener = (state: UpdateState) => void;
const listeners = new Set<Listener>();
let lastState: UpdateState = { phase: "idle" };

function setState(state: UpdateState): void {
  lastState = state;
  for (const fn of listeners) fn(state);
}

export function onUpdateState(fn: Listener): () => void {
  listeners.add(fn);
  fn(lastState);
  return () => listeners.delete(fn);
}

export function getUpdateState(): UpdateState {
  return lastState;
}

let wired = false;

function wireEvents(): void {
  if (wired) return;
  wired = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => setState({ phase: "checking" }));
  autoUpdater.on("update-available", (info) => setState({ phase: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => setState({ phase: "not-available" }));
  autoUpdater.on("download-progress", (p) => setState({ phase: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => setState({ phase: "downloaded", version: info.version }));
  autoUpdater.on("error", (err) => {
    log.error("auto-update error:", String(err));
    setState({ phase: "error", message: err.message });
  });
}

/** Safe to call even when UPDATE_REPO is unset — becomes a no-op, since a
 *  build without a configured release feed has nothing to check against. */
export function initAutoUpdate(): void {
  if (!UPDATE_REPO) {
    log.info("UPDATE_REPO not configured — auto-update disabled for this build");
    return;
  }
  try {
    wireEvents();
    const [owner, repo] = UPDATE_REPO.split("/");
    autoUpdater.setFeedURL({ provider: "github", owner, repo });
    void checkForUpdates();
    // periodic re-check, since this agent has no menu-bar "Check for
    // updates now" the user would otherwise rely on — every 4 hours is
    // frequent enough to notice a release same-day without hammering
    // GitHub's API from every installed copy.
    setInterval(() => void checkForUpdates(), 4 * 60 * 60 * 1000);
  } catch (err) {
    log.error("failed to configure auto-updater:", String(err));
  }
}

export async function checkForUpdates(): Promise<void> {
  if (!UPDATE_REPO) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    log.warn("update check failed (offline? no releases yet?):", String(err));
    setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

export function installUpdateNow(): void {
  try {
    autoUpdater.quitAndInstall();
  } catch (err) {
    log.error("failed to install update:", String(err));
  }
}
