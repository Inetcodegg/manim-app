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
    // a cold import of manim (which pulls in numpy, scipy, PIL, moderngl,
    // etc.) can legitimately take longer than a few seconds on first run —
    // disk cache is cold and antivirus real-time scanning inspects every
    // newly-touched DLL/pyd the first time. 60s gives real slow-first-run
    // machines room without masking an actually broken install.
    const result = await runCapture(pythonExe(), ["-c", "import manim, numpy; print('ok')"], { timeoutMs: 60_000 });
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
  const failed = [
    !python && "Python/Manim",
    !latex && "LaTeX",
    !ffmpeg && "FFmpeg",
  ].filter((x): x is string => Boolean(x));
  const detail = failed.length
    ? [`${failed.join(", ")} did not respond. The install may be corrupted — try reinstalling the app.`]
    : [];
  return { python, latex, ffmpeg, ready: python && latex && ffmpeg, detail };
}
