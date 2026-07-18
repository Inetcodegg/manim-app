import path from "node:path";
import { app } from "electron";

/**
 * Where everything lives. The hard requirement driving this file: the user
 * only ever downloads ONE installer and runs it — no first-run download of
 * Python/Manim/LaTeX/FFmpeg, no background install step, no waiting. So all
 * three runtimes are bundled INSIDE the installer as `extraResources` (see
 * package.json's build.extraResources and scripts/prepare-runtime.js, which
 * assembles them at BUILD time, before packaging — never at the user's
 * machine). Electron exposes the installed app's read-only resources dir at
 * `process.resourcesPath`; in dev (unpackaged) that's this project's own
 * `resources/` folder, so `npm run dev` and the packaged app resolve runtime
 * binaries the same way.
 *
 * The only thing genuinely user-writable is where render jobs' working
 * files and logs go, since Program Files (where the installer typically
 * lands) is read-only without elevation — those go under Electron's
 * userData dir, same as any other Windows app's per-user data.
 */

function resourcesRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "resources");
}

const isWindows = process.platform === "win32";

/** Windows binaries carry a `.exe` suffix; Mac/Linux ones don't. Centralized
 *  here so call sites never hardcode the extension themselves. */
function exeName(base: string): string {
  return isWindows ? `${base}.exe` : base;
}

export function runtimeDir(): string {
  return path.join(resourcesRoot(), "runtime");
}

export function pythonDir(): string {
  return path.join(runtimeDir(), "python");
}

export function pythonExe(): string {
  // Windows: the embeddable distribution's python.exe sits at the runtime
  // root. Mac/Linux: prepare-runtime.js lays out a standalone build (from
  // python-build-standalone) with the usual bin/python3 layout.
  return isWindows ? path.join(pythonDir(), "python.exe") : path.join(pythonDir(), "bin", "python3");
}

export function latexBinDir(): string {
  return path.join(runtimeDir(), "latex", "bin");
}

export function latexExe(name: string): string {
  return path.join(latexBinDir(), exeName(name));
}

export function ffmpegDir(): string {
  return path.join(runtimeDir(), "ffmpeg");
}

export function ffmpegExe(): string {
  return path.join(ffmpegDir(), exeName("ffmpeg"));
}

export function ffprobeExe(): string {
  return path.join(ffmpegDir(), exeName("ffprobe"));
}

// ---------------------------------------------------------------- userData
// The only writable locations — per-user, never touches the install dir.

export function userDataDir(): string {
  return app.getPath("userData");
}

export function jobsDir(): string {
  return path.join(userDataDir(), "renders");
}

export function jobDir(jobId: string): string {
  return path.join(jobsDir(), jobId);
}

/** Cached per-segment clips, keyed by content hash — reused across
 *  renders (even across different projects, though collisions across
 *  projects are vanishingly unlikely since the hash is of full compiled
 *  Python). See segmentCache.ts. */
export function segmentCacheDir(): string {
  return path.join(userDataDir(), "segment-cache");
}

export function segmentCacheFile(hash: string, ext: string): string {
  return path.join(segmentCacheDir(), `${hash}.${ext}`);
}

/** The local render library — finished, named videos kept on this
 *  machine, listed in the site's "Cloud renders" panel. See renderLibrary.ts. */
export function libraryDir(): string {
  return path.join(userDataDir(), "library");
}

export function libraryFile(renderId: string, ext: string): string {
  return path.join(libraryDir(), `${renderId}.${ext}`);
}

export function libraryManifestFile(): string {
  return path.join(libraryDir(), "manifest.json");
}

export function logFile(): string {
  return path.join(userDataDir(), "agent.log");
}

export function settingsFile(): string {
  return path.join(userDataDir(), "settings.json");
}
