import https from "node:https";
import { WebSocketServer, type WebSocket } from "ws";
import { startRenderJob, type RenderJobHandle } from "./renderWorker";
import { startVideoServer, videoUrlFor, type VideoRegistry } from "./videoServer";
import { checkRuntime, type RuntimeStatus } from "./runtimeCheck";
import { ensureTlsCert, type TlsCert } from "./tls";
import {
  listLibrary, findLibraryEntry, libraryFilePath, deleteLibraryEntry, renameLibraryEntry,
} from "./renderLibrary";
import { syncRenderDeletion } from "./librarySync";
import { log } from "./logger";
import { DEFAULT_PORT } from "../shared/protocol";
import type {
  ClientMessage, JobSnapshot, ServerMessage, StartRenderMessage,
  ListRendersMessage, DeleteRenderMessage, RenameRenderMessage, RenderLibraryEntry,
} from "../shared/protocol";

const AGENT_VERSION = "1.0.0";
const VIDEO_PORT = DEFAULT_PORT + 1;

/**
 * The local WebSocket server the site's browser tab connects to at
 * wss://127.0.0.1:61247 (TLS, not plain ws:// — see tls.ts for why loopback
 * still warrants encryption). One agent process serves every connected
 * tab/site instance; each render job is tracked by the `requestId` the
 * client picks (see shared/protocol.ts), so a page refresh or a second tab
 * starting a second render doesn't collide with an in-flight one. Video
 * bytes never flow over the WebSocket itself — finished renders are handed
 * to the browser as a plain https://127.0.0.1 URL (videoServer.ts), which
 * is both simpler and lets the browser's native <video> seeking/Range
 * support work exactly like it already does against the cloud path.
 *
 * Finished renders are also registered in the local render library (see
 * renderLibrary.ts) — a persisted, named archive of every video this agent
 * has produced, kept entirely on the user's own machine. This class routes
 * `list-renders`/`rename-render`/`delete-render` against that library, and
 * the video registry below serves BOTH in-flight job output (while it's
 * still under the job's own temp dir) and completed library entries
 * (their permanent home) through the same /video/<id> route.
 *
 * Every public method here is wrapped defensively: a malformed message, a
 * runtime check throwing, or a render worker crash must degrade to an
 * `error` message over the socket, never take down the whole agent process
 * (which would kill every OTHER in-flight render too).
 */

interface TrackedJob {
  handle: RenderJobHandle;
  lastSnapshot: JobSnapshot;
}

export class AgentServer {
  private httpsServer: https.Server | null = null;
  private wss: WebSocketServer | null = null;
  private jobs = new Map<string, TrackedJob>();
  private sockets = new Set<WebSocket>();
  private tls: TlsCert | null = null;
  // Cached runtime status. checkRuntime() can take 30–60s on a cold first
  // run (Python import), and sending `hello` MUST be instant — the site
  // drops the socket if it doesn't get a hello within a couple seconds. So
  // hello answers from this cache immediately, and the check runs in the
  // background, refreshing the cache and re-broadcasting hello when done.
  private cachedRuntime: RuntimeStatus | null = null;
  private runtimeCheckInFlight: Promise<RuntimeStatus> | null = null;
  private videoRegistry: VideoRegistry = {
    get: (id) => {
      // finished library entries take priority (the id format is distinct —
      // "render_..." vs. a client-chosen requestId — but a lookup-by-either
      // is simplest and never ambiguous in practice)
      const entry = findLibraryEntry(id);
      if (entry) return { filePath: libraryFilePath(entry), ext: entry.outputExt };
      return undefined;
    },
  };

  async start(port = DEFAULT_PORT): Promise<void> {
    this.tls = ensureTlsCert();

    await startVideoServer(this.videoRegistry, VIDEO_PORT, this.tls);

    this.httpsServer = https.createServer({ key: this.tls.keyPem, cert: this.tls.certPem });
    this.wss = new WebSocketServer({ server: this.httpsServer });

    await new Promise<void>((resolve, reject) => {
      this.httpsServer!.on("error", reject);
      this.httpsServer!.listen(port, "127.0.0.1", () => resolve());
    });
    log.info(`WebSocket agent listening on wss://127.0.0.1:${port}`);

    this.wss.on("connection", (socket) => {
      this.sockets.add(socket);
      log.info("browser tab connected");
      this.sendHello(socket);

      socket.on("message", (raw) => {
        this.handleMessage(socket, raw.toString()).catch((err) => {
          log.error("unhandled error processing message:", String(err));
          this.send(socket, { type: "error", message: "The agent hit an internal error handling that request." });
        });
      });
      socket.on("close", () => {
        this.sockets.delete(socket);
        log.info("browser tab disconnected");
      });
      socket.on("error", (err) => log.warn("socket error:", String(err)));
    });

    this.wss.on("error", (err) => log.error("WebSocketServer error:", String(err)));
  }

  async stop(): Promise<void> {
    for (const job of this.jobs.values()) {
      try {
        job.handle.cancel();
      } catch (err) {
        log.warn("error cancelling job during shutdown:", String(err));
      }
    }
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
    await new Promise<void>((resolve) => this.httpsServer?.close(() => resolve()));
  }

  /** Runs the (possibly slow) runtime check at most once at a time, caches
   *  the result, and re-broadcasts hello to every connected tab when it
   *  finishes — so a tab that got an optimistic early hello learns the real
   *  readiness a moment later without reconnecting. */
  private refreshRuntime(): Promise<RuntimeStatus> {
    if (this.runtimeCheckInFlight) return this.runtimeCheckInFlight;
    this.runtimeCheckInFlight = checkRuntime()
      .then((status) => {
        const changed = this.cachedRuntime?.ready !== status.ready;
        this.cachedRuntime = status;
        // if readiness flipped, tell everyone (the first hello may have been
        // an optimistic "assume ready" before the check completed)
        if (changed) for (const s of this.sockets) this.sendHello(s);
        return status;
      })
      .catch((err) => {
        log.error("runtime check failed:", String(err));
        return this.cachedRuntime ?? { python: false, latex: false, ffmpeg: false, ready: false, detail: [] };
      })
      .finally(() => { this.runtimeCheckInFlight = null; });
    return this.runtimeCheckInFlight;
  }

  /** Sends hello INSTANTLY from cache — the site drops the socket if hello
   *  is slow, and the first real check can take 30–60s. If we've never
   *  checked yet, we optimistically report ready:true and kick off the
   *  check; refreshRuntime() re-sends the corrected hello if it turns out
   *  not ready. Rendering itself still re-verifies before it runs, so an
   *  optimistic hello can never cause a broken render. */
  private sendHello(socket: WebSocket): void {
    const status = this.cachedRuntime;
    if (!status) {
      // never checked — answer optimistically NOW, verify in the background
      void this.refreshRuntime();
    }
    const hello: ServerMessage = {
      type: "hello",
      agentVersion: AGENT_VERSION,
      ready: status ? status.ready : true,
      setupStage: status && !status.ready ? status.detail.join(" ") : null,
      setupProgress: null,
      tlsFingerprint: this.tls?.fingerprint ?? "",
    };
    this.send(socket, hello);
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(socket, { type: "error", message: "Malformed message (not valid JSON)." });
      return;
    }

    switch (msg.type) {
      case "ping":
        // a ping is the site re-checking readiness — refresh in the
        // background so a not-ready→ready transition gets pushed out
        void this.refreshRuntime();
        this.sendHello(socket);
        return;
      case "start":
        await this.startJob(msg);
        return;
      case "cancel":
        try {
          this.jobs.get(msg.requestId)?.handle.cancel();
        } catch (err) {
          log.warn(`error cancelling job ${msg.requestId}:`, String(err));
        }
        return;
      case "list-renders":
        this.sendRenderList(socket, msg);
        return;
      case "delete-render":
        this.handleDeleteRender(socket, msg);
        return;
      case "rename-render":
        this.handleRenameRender(socket, msg);
        return;
      default:
        this.send(socket, { type: "error", message: `Unknown message type: ${(msg as { type?: string }).type}` });
    }
  }

  private withPublicUrl(entry: RenderLibraryEntry): RenderLibraryEntry {
    return { ...entry, videoUrl: videoUrlFor(VIDEO_PORT, entry.id) };
  }

  private sendRenderList(socket: WebSocket, msg: ListRendersMessage): void {
    try {
      const renders = listLibrary(msg.projectId).map((e) => this.withPublicUrl(e));
      this.send(socket, { type: "render-list", renders });
    } catch (err) {
      log.error("failed to list render library:", String(err));
      this.send(socket, { type: "error", message: "Could not read the local render library." });
    }
  }

  /** Broadcasts the full (unscoped) library to every connected tab — used
   *  whenever the library's contents change (delete/rename/a finished
   *  render), so an open "Cloud renders" panel updates without polling.
   *  A tab wanting a project-scoped view re-filters client-side; the list
   *  itself is small (a user's total render history), so sending the whole
   *  thing is simpler than tracking each socket's last requested scope. */
  private broadcastRenderList(): void {
    try {
      const renders = listLibrary().map((e) => this.withPublicUrl(e));
      const message: ServerMessage = { type: "render-list", renders };
      for (const socket of this.sockets) this.send(socket, message);
    } catch (err) {
      log.error("failed to broadcast render library:", String(err));
    }
  }

  private handleDeleteRender(socket: WebSocket, msg: DeleteRenderMessage): void {
    try {
      deleteLibraryEntry(msg.renderId);
      this.broadcastRenderList();
      void syncRenderDeletion(msg.renderId);
    } catch (err) {
      log.error(`failed to delete render ${msg.renderId}:`, String(err));
      this.send(socket, { type: "error", message: "Could not delete that render." });
    }
  }

  private handleRenameRender(socket: WebSocket, msg: RenameRenderMessage): void {
    try {
      renameLibraryEntry(msg.renderId, msg.name);
      this.broadcastRenderList();
    } catch (err) {
      log.error(`failed to rename render ${msg.renderId}:`, String(err));
      this.send(socket, { type: "error", message: "Could not rename that render." });
    }
  }

  private async startJob(msg: StartRenderMessage): Promise<void> {
    try {
      const status = await checkRuntime();
      if (!status.ready) {
        this.broadcastJob({
          requestId: msg.requestId,
          status: "error",
          progress: 0,
          logs: [],
          warnings: [],
          error: `The render runtime isn't ready. ${status.detail.join(" ")}`,
          videoUrl: null,
          outputExt: null,
          segmentsTotal: msg.segments.length,
          segmentsCached: 0,
        });
        return;
      }

      if (this.jobs.has(msg.requestId)) {
        this.jobs.get(msg.requestId)?.handle.cancel();
      }

      const handle = startRenderJob(msg, (snapshot) => {
        try {
          const tracked = this.jobs.get(msg.requestId);
          if (tracked) tracked.lastSnapshot = snapshot;
          const withPublicUrl: JobSnapshot = {
            ...snapshot,
            videoUrl: snapshot.status === "done" && snapshot.videoUrl
              ? videoUrlFor(VIDEO_PORT, libraryIdFromPath(snapshot.videoUrl))
              : null,
          };
          this.broadcastJob(withPublicUrl);
          if (snapshot.status === "done") this.broadcastRenderList();
        } catch (err) {
          log.error(`error broadcasting progress for ${msg.requestId}:`, String(err));
        }
      });

      this.jobs.set(msg.requestId, {
        handle,
        lastSnapshot: {
          requestId: msg.requestId, status: "queued", progress: 0,
          logs: [], warnings: [], error: null, videoUrl: null, outputExt: null,
          segmentsTotal: msg.segments.length, segmentsCached: 0,
        },
      });
    } catch (err) {
      log.error(`failed to start render job ${msg.requestId}:`, String(err));
      this.broadcastJob({
        requestId: msg.requestId,
        status: "error",
        progress: 0,
        logs: [],
        warnings: [],
        error: `Could not start the render: ${(err as Error).message ?? String(err)}`,
        videoUrl: null,
        outputExt: null,
        segmentsTotal: msg.segments.length,
        segmentsCached: 0,
      });
    }
  }

  private broadcastJob(job: JobSnapshot): void {
    const message: ServerMessage = { type: "job", job };
    for (const socket of this.sockets) this.send(socket, message);
  }

  private send(socket: WebSocket | undefined, message: ServerMessage): void {
    if (!socket || socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (err) {
      log.warn("failed to send WS message:", String(err));
    }
  }
}

/** videoUrl during an in-flight job is the raw on-disk finalPath (see
 *  renderWorker.ts's `emit(snapshot(1, finalPath))`) — this agent's own
 *  library id is that file's basename without extension, matching
 *  nextLibraryPath()'s naming (`<id>.<ext>`). */
function libraryIdFromPath(finalPath: string): string {
  const base = finalPath.split(/[\\/]/).pop() ?? finalPath;
  return base.replace(/\.[^.]+$/, "");
}
