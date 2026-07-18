/**
 * The wire protocol spoken over the local WebSocket between this desktop
 * agent and the browser tab running manim-std.vercel.app. Deliberately
 * shaped as a close analog of the site's existing HTTP render API
 * (POST /api/render, GET /api/render/[id], GET /api/render/[id]/video) —
 * see RenderJob in the website's src/lib/server/renderQueue.ts — so the
 * site's render dialog can drive either backend with the same mental model:
 * enqueue once, receive a stream of job-state snapshots, then fetch the
 * finished video over a plain HTTP URL this agent also serves locally.
 */

export type JobStatus = "queued" | "compiling" | "rendering" | "concatenating" | "done" | "error" | "cancelled";

export type OutputFormat = "mp4" | "gif" | "webm_alpha";

/**
 * One piece of the timeline to render, as compiled by the SITE's
 * segments.ts (compileProjectSegment) — the agent never compiles Project
 * JSON to Python itself, it only ever runs `manim render` on code it's
 * handed. `hash` is a content hash of `code` (computed by the site) that
 * this agent uses as the cache key: if a prior completed render already
 * produced a video for this exact hash, that cached clip is reused
 * unchanged instead of re-running Manim. See the desktop agent's
 * segmentCache.ts for the caching side of this contract.
 */
export interface RenderSegment {
  /** stable index within this render's segment list (0-based, in timeline order) */
  index: number;
  /** SHA-256 of `code`, hex — the cache key */
  hash: string;
  /** this segment's compiled Python (a complete, standalone Scene) */
  code: string;
  sceneName: string;
  /** [start, end) in the ORIGINAL (unshifted) project timeline, seconds —
   *  for display/debugging only, not used for correctness */
  start: number;
  end: number;
}

/** One render request. Always segment-based: a render with no cacheable
 *  history is simply one segment covering the whole timeline. */
export interface StartRenderMessage {
  type: "start";
  /** client-chosen id, echoed back on every job message so multiple tabs/
   *  renders can be told apart without the agent minting ids itself */
  requestId: string;
  /** stable per-PROJECT id (not per-render) — the cache key namespace, so
   *  segment hashes from project A never accidentally cache-hit for an
   *  unrelated project B that happens to compile to identical Python for
   *  one segment (e.g. two blank scenes) */
  projectId: string;
  projectName: string;
  segments: RenderSegment[];
  outputFormat: OutputFormat;
}

export interface CancelRenderMessage {
  type: "cancel";
  requestId: string;
}

/** Sent once right after the socket opens, before any render — lets the
 *  page show "connected, ready" vs. "still installing Python/Manim/LaTeX". */
export interface PingMessage {
  type: "ping";
}

/** List the local render library (previously completed renders still on
 *  disk) — powers the site's "Cloud renders" panel. Optionally scoped to
 *  one project; omit to list everything. */
export interface ListRendersMessage {
  type: "list-renders";
  projectId?: string;
}

export interface DeleteRenderMessage {
  type: "delete-render";
  renderId: string;
}

export interface RenameRenderMessage {
  type: "rename-render";
  renderId: string;
  name: string;
}

export type ClientMessage =
  | StartRenderMessage | CancelRenderMessage | PingMessage
  | ListRendersMessage | DeleteRenderMessage | RenameRenderMessage;

/** Mirrors the shape of the cloud RenderJob closely enough that the site's
 *  existing render-progress UI needs only a different transport, not a
 *  different data model. `videoUrl` is a plain https://127.0.0.1:<port>/...
 *  URL (Range-request capable) the browser can drop straight into <video>. */
export interface JobSnapshot {
  requestId: string;
  status: JobStatus;
  progress: number; // 0..1
  logs: string[];
  warnings: string[];
  error: string | null;
  videoUrl: string | null;
  outputExt: "mp4" | "gif" | "webm" | null;
  /** how many of this render's segments were reused from cache vs actually
   *  run through Manim — shown to the user as "3 of 4 segments cached". */
  segmentsTotal: number;
  segmentsCached: number;
}

export interface HelloMessage {
  type: "hello";
  agentVersion: string;
  /** true once Python/Manim/LaTeX/FFmpeg are all verified working */
  ready: boolean;
  /** human-readable setup stage when not ready yet, e.g. "Installing LaTeX…" */
  setupStage: string | null;
  setupProgress: number | null; // 0..1, null when not installing
  /** SHA-256 fingerprint of the agent's self-signed TLS certificate, shown
   *  to a technically-inclined user as a way to manually verify the
   *  connection instead of taking wss:// on faith the first time. */
  tlsFingerprint: string;
}

export interface JobMessage {
  type: "job";
  job: JobSnapshot;
}

/** One entry in the local render library — a previously completed render
 *  still on disk. `name` defaults to the project name + timestamp but is
 *  user-renamable (rename-render). */
export interface RenderLibraryEntry {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  createdAt: string; // ISO
  durationSeconds: number; // video length
  fileSizeBytes: number;
  outputExt: "mp4" | "gif" | "webm";
  videoUrl: string;
}

export interface RenderListMessage {
  type: "render-list";
  renders: RenderLibraryEntry[];
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export type ServerMessage = HelloMessage | JobMessage | RenderListMessage | ErrorMessage;

/** Default local port. Chosen to be unlikely to collide with dev servers
 *  (Next.js uses 3000, Vite 5173, etc.) — a fixed, documented, single port
 *  keeps the site's connection logic a one-liner: new WebSocket(`wss://127.0.0.1:${PORT}`). */
export const DEFAULT_PORT = 61247;
