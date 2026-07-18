import fs from "node:fs";
import path from "node:path";
import { logFile } from "./paths";

/**
 * Minimal append-only file logger, mirrored to the console. This runs with
 * no visible terminal (packaged Electron app), so agent.log under userData
 * is the only place a user or support session can see what happened —
 * every subsystem (setup, WebSocket, render worker) routes through this
 * instead of bare console.log so nothing silently vanishes.
 */

let stream: fs.WriteStream | null = null;

function ensureStream(): fs.WriteStream {
  if (!stream) {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stream = fs.createWriteStream(file, { flags: "a" });
  }
  return stream;
}

function write(level: string, args: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")}`;
  try {
    ensureStream().write(line + "\n");
  } catch {
    /* logging must never crash the app it's trying to describe */
  }
  const consoleFn = level === "ERROR" ? console.error : console.log;
  consoleFn(line);
}

export const log = {
  info: (...args: unknown[]) => write("INFO", args),
  warn: (...args: unknown[]) => write("WARN", args),
  error: (...args: unknown[]) => write("ERROR", args),
};
