import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { jobDir, pythonExe, ffmpegDir, ffmpegExe, ffprobeExe, latexBinDir } from "./paths";
import { spawnStreaming, runCapture } from "./proc";
import { log } from "./logger";
import { cachedSegmentPath, saveSegmentToCache } from "./segmentCache";
import { ensureLibraryDir, nextLibraryPath, addToLibrary } from "./renderLibrary";
import { syncRenderMetadata } from "./librarySync";
import {
  countTotalAnimations, freshProgressState, progressFromChunk, extractLogLines, diagnose,
} from "./progressParse";
import type {
  JobSnapshot, JobStatus, OutputFormat, RenderSegment, StartRenderMessage,
} from "../shared/protocol";

/**
 * Runs one render request end to end: for each segment, reuse a cached
 * clip if its content hash was rendered before, otherwise run `manim` on
 * it; then concatenate every segment's clip (cached + freshly rendered,
 * in order) into the final output with FFmpeg, and register the result in
 * the local render library. Entirely against the runtimes bundled inside
 * this app's own resources (see paths.ts) — no download, no install step.
 *
 * A request with only one segment (the common case for a short scene, or
 * any render where nothing was cacheable) degrades to exactly the old
 * single-shot behavior: render it, skip the concat step, done.
 */

export interface RenderJobHandle {
  requestId: string;
  cancel: () => void;
}

type EmitFn = (snapshot: JobSnapshot) => void;

function outputExtFor(format: OutputFormat): "mp4" | "gif" | "webm" {
  if (format === "gif") return "gif";
  if (format === "webm_alpha") return "webm";
  return "mp4";
}

function findSceneClassName(code: string, fallback: string): string | null {
  const match = code.match(/class\s+(\w+)\s*\(\s*(?:ThreeDScene|MovingCameraScene|Scene)\s*\)/);
  return match ? match[1] : fallback || null;
}

function walkFor(root: string, filename: string): string | null {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === filename) return full;
    }
  }
  return null;
}

function findOutput(mediaDir: string, ext: string): string | null {
  for (const kind of ["videos", "images"]) {
    const base = path.join(mediaDir, kind);
    if (!fs.existsSync(base)) continue;
    const found = walkFor(base, `output.${ext}`);
    if (found) return found;
  }
  return null;
}

/** PATH additions so the spawned python process can find ffmpeg/latex —
 *  manim shells out to both internally (ffmpeg for muxing, latex for
 *  MathTex), so they must resolve on PATH inside the child's own
 *  environment, even though this agent invokes python.exe directly rather
 *  than through a shell. */
function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [ffmpegDir(), latexBinDir(), process.env.PATH ?? ""].join(path.delimiter),
  };
}

interface SegmentRunResult {
  filePath: string;
  fromCache: boolean;
}

/** Renders (or reuses a cached clip for) ONE segment. Returns its output
 *  file path. Progress/log callbacks are per-segment; the orchestrator
 *  below combines them into one overall job progress. */
async function runSegment(
  seg: RenderSegment,
  ext: string,
  workDir: string,
  onData: (text: string) => void,
  isCancelled: () => boolean,
  registerChild: (c: ChildProcessWithoutNullStreams | null) => void,
): Promise<SegmentRunResult> {
  const cached = cachedSegmentPath(seg.hash, ext);
  if (cached) {
    return { filePath: cached, fromCache: true };
  }

  const dir = path.join(workDir, `seg_${seg.index}`);
  fs.mkdirSync(dir, { recursive: true });
  const scenePath = path.join(dir, "scene.py");
  const mediaDir = path.join(dir, "media");
  fs.writeFileSync(scenePath, seg.code, "utf8");

  const sceneName = findSceneClassName(seg.code, seg.sceneName);
  if (!sceneName) {
    throw new Error(`Segment ${seg.index}: could not determine the scene's class name.`);
  }

  const args = [
    "-m", "manim", "render",
    "--media_dir", mediaDir,
    "-o", "output",
    ...(ext === "gif" ? ["--format", "gif"] : []),
    ...(ext === "webm" ? ["--transparent", "--format", "webm"] : []),
    "scene.py", sceneName,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawnStreaming(pythonExe(), args, { cwd: dir, env: childEnv() });
    registerChild(child);
    const onOut = (data: Buffer) => onData(data.toString("utf8"));
    child.stdout.on("data", onOut);
    child.stderr.on("data", onOut);
    child.on("error", reject);
    child.on("close", (code) => {
      registerChild(null);
      if (isCancelled()) {
        resolve();
        return;
      }
      if (code !== 0) {
        reject(new Error(`manim exited with code ${code} on segment ${seg.index}`));
        return;
      }
      resolve();
    });
  });

  if (isCancelled()) throw new CancelledError();

  const outputPath = findOutput(mediaDir, ext);
  if (!outputPath) throw new Error(`Segment ${seg.index}: manim finished but no output file was found.`);

  const cachedPath = saveSegmentToCache(seg.hash, ext, outputPath);
  return { filePath: cachedPath, fromCache: false };
}

class CancelledError extends Error {}

/** Concatenates segment clips in order via FFmpeg's concat demuxer (stream
 *  copy, no re-encode — every segment already shares the same codec/
 *  resolution/fps since they all came from the same compileProject config
 *  block, so a lossless concat is safe and fast). Single-segment renders
 *  skip this entirely (see the caller). */
async function concatSegments(clipPaths: string[], destPath: string, workDir: string): Promise<void> {
  const listFile = path.join(workDir, "concat_list.txt");
  // ffmpeg's concat demuxer treats backslashes inside `file '...'` as escape
  // sequences, so absolute Windows paths (C:\Users\…) get mangled and every
  // multi-segment render fails at the concat step. Forward slashes work on
  // Windows too, so normalize them before writing the list file.
  const listContent = clipPaths
    .map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(listFile, listContent, "utf8");

  const result = await runCapture(
    ffmpegExe(),
    ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", destPath],
    { timeoutMs: 5 * 60_000 },
  );
  if (result.code !== 0) {
    throw new Error(`FFmpeg concat failed:\n${result.stderr.slice(-2000)}`);
  }
}

function videoDurationFromFfprobe(filePath: string): Promise<number> {
  return runCapture(ffprobeExe(), [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", filePath,
  ], { timeoutMs: 15_000 })
    .then((r) => Number.parseFloat(r.stdout.trim()) || 0)
    .catch(() => 0);
}

export function startRenderJob(msg: StartRenderMessage, emit: EmitFn): RenderJobHandle {
  const dir = jobDir(msg.requestId);
  fs.mkdirSync(dir, { recursive: true });
  const ext = outputExtFor(msg.outputFormat);
  const segments = [...msg.segments].sort((a, b) => a.index - b.index);

  let status: JobStatus = "compiling";
  let logs: string[] = [];
  const warnings: string[] = [];
  let error: string | null = null;
  let activeChild: ChildProcessWithoutNullStreams | null = null;
  let cancelled = false;
  let segmentsCached = 0;

  const snapshot = (progress: number, videoPath: string | null = null): JobSnapshot => ({
    requestId: msg.requestId,
    status,
    progress,
    logs,
    warnings,
    error,
    // the actual localhost URL is filled in by the WS server (which owns
    // the HTTP video route and knows its own port); this worker only ever
    // knows the on-disk path, kept out of the wire protocol on purpose.
    videoUrl: videoPath,
    outputExt: status === "done" ? ext : null,
    segmentsTotal: segments.length,
    segmentsCached,
  });

  const run = async () => {
    try {
      if (segments.length === 0) {
        status = "error";
        error = "No segments to render.";
        emit(snapshot(0));
        return;
      }

      status = "rendering";
      emit(snapshot(0));

      const totalAnimsPerSegment = segments.map((s) => countTotalAnimations(s.code));
      const clipPaths: string[] = [];

      for (let i = 0; i < segments.length; i++) {
        if (cancelled) throw new CancelledError();
        const seg = segments[i];
        const segShare = 1 / segments.length;
        const segBase = i * segShare;
        const progressState = freshProgressState();

        const result = await runSegment(
          seg, ext, dir,
          (text) => {
            logs = extractLogLines(logs, text);
            const inner = progressFromChunk(progressState, text, totalAnimsPerSegment[i]);
            emit(snapshot(segBase + inner * segShare));
          },
          () => cancelled,
          (c) => { activeChild = c; },
        );
        if (result.fromCache) {
          segmentsCached++;
          logs = extractLogLines(logs, `[segment ${seg.index}] reused cached render (unchanged)`);
        }
        clipPaths.push(result.filePath);
        emit(snapshot(segBase + segShare));
      }

      if (cancelled) throw new CancelledError();

      ensureLibraryDir();
      const libraryId = `render_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
      const finalPath = nextLibraryPath(libraryId, ext);

      if (clipPaths.length === 1) {
        fs.copyFileSync(clipPaths[0], finalPath);
      } else {
        status = "concatenating";
        emit(snapshot(0.97));
        await concatSegments(clipPaths, finalPath, dir);
      }

      const durationSeconds = await videoDurationFromFfprobe(finalPath);
      const libraryEntry = addToLibrary({
        id: libraryId,
        projectId: msg.projectId,
        projectName: msg.projectName,
        outputExt: ext,
        filePath: finalPath,
        durationSeconds,
      });
      void syncRenderMetadata(libraryEntry);

      status = "done";
      emit(snapshot(1, finalPath));
    } catch (err) {
      if (err instanceof CancelledError || cancelled) {
        status = "cancelled";
        emit(snapshot(0.98));
        return;
      }
      status = "error";
      const hint = diagnose(logs);
      error = `${(err as Error).message}${hint ? `\n\n${hint}` : ""}`;
      log.error(`render ${msg.requestId} failed:`, error);
      emit(snapshot(0.98));
    }
  };

  void run();

  return {
    requestId: msg.requestId,
    cancel: () => {
      cancelled = true;
      status = "cancelled";
      activeChild?.kill();
    },
  };
}
