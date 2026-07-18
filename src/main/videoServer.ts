import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { log } from "./logger";
import type { TlsCert } from "./tls";

/**
 * Serves finished render output files to the site's <video>/<img> tags over
 * https://127.0.0.1:<port>/video/<requestId>, with HTTP Range support —
 * mirrors the cloud path's GET /api/render/[id]/video exactly (partial 206
 * responses for mp4/webm so the browser can seek, whole-file for gif) so
 * the site's existing player code needs no special-casing between the two
 * backends. HTTPS (not plain HTTP) is required here for the same reason the
 * WebSocket is wss:// — a page loaded over TLS refuses to load "insecure"
 * plain-http resources (mixed content), and the video would otherwise be
 * silently blocked by the browser regardless of anything else being right.
 */

const EXT_CONTENT_TYPE: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  gif: "image/gif",
};

export interface VideoRegistry {
  get(requestId: string): { filePath: string; ext: string } | undefined;
}

export function createVideoServer(registry: VideoRegistry, tls: TlsCert): https.Server {
  return https.createServer({ key: tls.keyPem, cert: tls.certPem }, (req, res) => {
    // CORS: the site runs on a completely different origin
    // (manim-std.vercel.app) than this localhost server, so every response
    // needs an explicit Access-Control-Allow-Origin or the browser simply
    // refuses to hand the video data to the <video> element's JS.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/video\/([\w-]+)$/);
    if (!match) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const entry = registry.get(match[1]);
    if (!entry || !fs.existsSync(entry.filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Render output not found");
      return;
    }

    const contentType = EXT_CONTENT_TYPE[entry.ext] ?? "application/octet-stream";
    const stat = fs.statSync(entry.filePath);
    const range = req.headers.range;

    if (range && entry.ext !== "gif") {
      const parsed = /bytes=(\d*)-(\d*)/.exec(range);
      const start = parsed?.[1] ? Number(parsed[1]) : 0;
      const end = parsed?.[2] ? Number(parsed[2]) : stat.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": contentType,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
      });
      fs.createReadStream(entry.filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
    });
    fs.createReadStream(entry.filePath).pipe(res);
  });
}

export function videoUrlFor(port: number, requestId: string): string {
  return `https://127.0.0.1:${port}/video/${requestId}`;
}

export function startVideoServer(registry: VideoRegistry, port: number, tls: TlsCert): Promise<https.Server> {
  return new Promise((resolve, reject) => {
    const server = createVideoServer(registry, tls);
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      log.info(`video server listening on https://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

export function outputBasename(requestId: string): string {
  return path.basename(requestId);
}
