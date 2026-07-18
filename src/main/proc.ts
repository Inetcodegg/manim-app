import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { log } from "./logger";

/**
 * Every process this agent launches goes through here, and every launch is
 * `shell: false` — deliberately, not an oversight. On Windows, `shell: true`
 * re-tokenizes the command line through cmd.exe, which mangles any argument
 * containing a space (drive letters aside, almost every real install path
 * on this machine has one — "Program Files", a user's own "Desktop
 * application" folder, etc.). Passing argv as an array with no shell is the
 * only invocation form that survives spaces/quotes correctly, matching the
 * same lesson already learned server-side in the website's own render
 * queue (see its renderQueue.ts comments about the repo living in a path
 * with a space in it).
 */

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd, shell: false, windowsHide: true, env: opts.env ?? process.env,
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeoutMs)
      : null;
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/** Probe whether a binary runs at all (used to verify each embedded
 *  runtime after install, and to sanity-check before every render). */
export async function probe(cmd: string, args: string[] = ["--version"]): Promise<boolean> {
  try {
    const result = await runCapture(cmd, args, { timeoutMs: 15_000 });
    return result.code === 0;
  } catch (err) {
    log.warn(`probe failed for ${cmd}:`, String(err));
    return false;
  }
}

export function spawnStreaming(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  return spawn(cmd, args, {
    cwd: opts.cwd, shell: false, windowsHide: true, env: opts.env ?? process.env,
  }) as ChildProcessWithoutNullStreams;
}
