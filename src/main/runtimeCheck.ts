import fs from "node:fs";
import { pythonExe, ffmpegExe, latexExe } from "./paths";
import { runCapture } from "./proc";
import { log } from "./logger";

/**
 * Functional "does the bundled runtime actually work" check, run once at
 * startup (and exposed to the tray's "Verify install" action for support
 * purposes). Since every runtime ships pre-installed inside the app's own
 * resources — never downloaded or installed on the user's machine — this
 * is a smoke test, not a gate the user waits behind: it should always pass
 * on a correctly-built installer, and only exists to catch a corrupted
 * install (antivirus quarantine, incomplete copy, disk error) with a clear
 * error instead of a confusing render failure three steps later.
 */

export interface RuntimeStatus {
  python: boolean;
  latex: boolean;
  ffmpeg: boolean;
  ready: boolean;
  detail: string[];
}

async function manimWorks(): Promise<boolean> {
  if (!fs.existsSync(pythonExe())) return false;
  try {
    const result = await runCapture(pythonExe(), ["-c", "import manim, numpy; print('ok')"], { timeoutMs: 20_000 });
    return result.code === 0 && result.stdout.includes("ok");
  } catch (err) {
    log.warn("manimWorks check failed:", String(err));
    return false;
  }
}

async function latexWorks(): Promise<boolean> {
  const latexBin = latexExe("latex");
  if (!fs.existsSync(latexBin)) return false;
  try {
    const result = await runCapture(latexBin, ["--version"], { timeoutMs: 15_000 });
    return result.code === 0;
  } catch (err) {
    log.warn("latexWorks check failed:", String(err));
    return false;
  }
}

async function ffmpegWorks(): Promise<boolean> {
  if (!fs.existsSync(ffmpegExe())) return false;
  try {
    const result = await runCapture(ffmpegExe(), ["-version"], { timeoutMs: 15_000 });
    return result.code === 0;
  } catch (err) {
    log.warn("ffmpegWorks check failed:", String(err));
    return false;
  }
}

export async function checkRuntime(): Promise<RuntimeStatus> {
  const [python, latex, ffmpeg] = await Promise.all([manimWorks(), latexWorks(), ffmpegWorks()]);
  const detail: string[] = [];
  if (!python) detail.push("Python/Manim did not respond — the install may be corrupted. Try reinstalling the app.");
  if (!latex) detail.push("LaTeX did not respond — the install may be corrupted. Try reinstalling the app.");
  if (!ffmpeg) detail.push("FFmpeg did not respond — the install may be corrupted. Try reinstalling the app.");
  return { python, latex, ffmpeg, ready: python && latex && ffmpeg, detail };
}
