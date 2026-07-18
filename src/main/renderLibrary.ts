import fs from "node:fs";
import path from "node:path";
import { libraryDir, libraryFile, libraryManifestFile } from "./paths";
import { log } from "./logger";
import type { RenderLibraryEntry } from "../shared/protocol";

/**
 * The local render library: every completed render this agent has ever
 * produced, kept on the user's own machine (per the explicit requirement
 * that videos live in the app the user installed, on their own laptop —
 * not uploaded anywhere). This is what the site's "Cloud renders" panel in
 * the editor lists — "cloud" here means "the always-on background agent,"
 * not a remote server; the name is what the user asked this feature be
 * called, so the site-side UI uses it, but the actual bytes never leave
 * this computer.
 *
 * Only entry METADATA (name, date, duration, size, project name/id) is
 * ever sent anywhere else — the site's admin dashboard shows that list
 * so Manim Studio staff have visibility into render activity, but the
 * video file itself is only ever served back to a browser tab on THIS
 * machine, over the local wss:// connection.
 */

interface Manifest {
  entries: RenderLibraryEntry[];
}

function readManifest(): Manifest {
  try {
    const raw = fs.readFileSync(libraryManifestFile(), "utf8");
    const parsed = JSON.parse(raw) as Manifest;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function writeManifest(manifest: Manifest): void {
  fs.mkdirSync(libraryDir(), { recursive: true });
  fs.writeFileSync(libraryManifestFile(), JSON.stringify(manifest, null, 2), "utf8");
}

export interface AddToLibraryInput {
  id: string;
  projectId: string;
  projectName: string;
  outputExt: "mp4" | "gif" | "webm";
  /** the finished video file, already at its final on-disk location under libraryDir() */
  filePath: string;
  durationSeconds: number;
}

/** Registers a just-finished render in the library manifest. The video
 *  file must already have been moved/copied to `filePath` by the caller
 *  (renderWorker.ts) before this runs — this only ever writes metadata. */
export function addToLibrary(input: AddToLibraryInput): RenderLibraryEntry {
  const manifest = readManifest();
  let fileSizeBytes = 0;
  try {
    fileSizeBytes = fs.statSync(input.filePath).size;
  } catch (err) {
    log.warn(`could not stat library file ${input.filePath}:`, String(err));
  }
  const entry: RenderLibraryEntry = {
    id: input.id,
    projectId: input.projectId,
    projectName: input.projectName,
    name: `${input.projectName} — ${new Date().toLocaleString()}`,
    createdAt: new Date().toISOString(),
    durationSeconds: input.durationSeconds,
    fileSizeBytes,
    outputExt: input.outputExt,
    videoUrl: "", // filled in by the caller once the video-server port is known
  };
  manifest.entries.unshift(entry);
  writeManifest(manifest);
  return entry;
}

export function listLibrary(projectId?: string): RenderLibraryEntry[] {
  const manifest = readManifest();
  return projectId ? manifest.entries.filter((e) => e.projectId === projectId) : manifest.entries;
}

export function findLibraryEntry(renderId: string): RenderLibraryEntry | undefined {
  return readManifest().entries.find((e) => e.id === renderId);
}

export function libraryFilePath(entry: RenderLibraryEntry): string {
  return libraryFile(entry.id, entry.outputExt);
}

export function renameLibraryEntry(renderId: string, name: string): boolean {
  const manifest = readManifest();
  const entry = manifest.entries.find((e) => e.id === renderId);
  if (!entry) return false;
  entry.name = name.slice(0, 200);
  writeManifest(manifest);
  return true;
}

export function deleteLibraryEntry(renderId: string): boolean {
  const manifest = readManifest();
  const idx = manifest.entries.findIndex((e) => e.id === renderId);
  if (idx === -1) return false;
  const [entry] = manifest.entries.splice(idx, 1);
  writeManifest(manifest);
  try {
    const file = libraryFile(entry.id, entry.outputExt);
    if (fs.existsSync(file)) fs.rmSync(file);
  } catch (err) {
    log.warn(`failed to delete library file for ${renderId}:`, String(err));
  }
  return true;
}

export function ensureLibraryDir(): void {
  fs.mkdirSync(libraryDir(), { recursive: true });
}

export function nextLibraryPath(id: string, ext: string): string {
  return path.join(libraryDir(), `${id}.${ext}`);
}
