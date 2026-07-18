import fs from "node:fs";
import path from "node:path";
import { segmentCacheDir, segmentCacheFile } from "./paths";
import { log } from "./logger";

/**
 * Cache of rendered video clips, keyed by the content hash of the segment's
 * compiled Python (see shared/protocol.ts's RenderSegment). The site
 * computes segment boundaries and hashes (src/lib/compiler/segments.ts);
 * this agent's only job is: given a hash, do we already have a rendered
 * clip for it? If yes, reuse it untouched. If no, render it and cache the
 * result. This is what makes "re-render after only editing the last few
 * seconds" fast — the unchanged earlier segments hash identically to their
 * previous render and are never re-run through Manim.
 *
 * Deliberately a flat content-addressed store, not a per-project cache:
 * two different projects that happen to compile an identical segment
 * (e.g. both start with the same blank 2-second intro) share the cache
 * entry for free, and nothing needs explicit invalidation — a changed
 * segment simply hashes to a different, previously-unseen key.
 */

const MAX_CACHE_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB — generous, bounded so this never fills a user's disk unsupervised

export function cachedSegmentPath(hash: string, ext: string): string | null {
  const file = segmentCacheFile(hash, ext);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    // touch mtime on hit so eviction below is a genuine LRU, not just
    // insertion-order — a segment that keeps getting reused (a stable
    // intro across many edits) should be the LAST thing evicted
    try {
      const now = new Date();
      fs.utimesSync(file, now, now);
    } catch {
      /* touching mtime is an optimization, not a correctness requirement */
    }
    return file;
  }
  return null;
}

export function saveSegmentToCache(hash: string, ext: string, sourceFile: string): string {
  fs.mkdirSync(segmentCacheDir(), { recursive: true });
  const dest = segmentCacheFile(hash, ext);
  fs.copyFileSync(sourceFile, dest);
  evictIfOverBudget();
  return dest;
}

/** Simple LRU-by-mtime eviction: once the cache exceeds MAX_CACHE_BYTES,
 *  delete the least-recently-touched clips until back under budget. Runs
 *  after every cache write rather than on a timer — cheap enough (a
 *  directory listing + stat per file) that a background timer would add
 *  complexity without a real benefit. */
function evictIfOverBudget(): void {
  let entries: { file: string; size: number; mtime: number }[];
  try {
    const dir = segmentCacheDir();
    entries = fs.readdirSync(dir).map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { file: full, size: stat.size, mtime: stat.mtimeMs };
    });
  } catch (err) {
    log.warn("segment cache eviction scan failed:", String(err));
    return;
  }
  let total = entries.reduce((n, e) => n + e.size, 0);
  if (total <= MAX_CACHE_BYTES) return;
  entries.sort((a, b) => a.mtime - b.mtime); // oldest first
  for (const e of entries) {
    if (total <= MAX_CACHE_BYTES) break;
    try {
      fs.rmSync(e.file);
      total -= e.size;
    } catch (err) {
      log.warn(`failed to evict cached segment ${e.file}:`, String(err));
    }
  }
}
