import { getAuthToken } from "./authToken";
import { SITE_API_BASE } from "../shared/firebaseConfig";
import { log } from "./logger";
import type { RenderLibraryEntry } from "../shared/protocol";

/**
 * Pushes METADATA ONLY for a completed render to the website's
 * /api/render-library — never the video file itself, which stays on this
 * machine per the whole point of this feature (see renderLibrary.ts's file
 * doc). This is what lets Manim Studio's admin dashboard show render
 * activity across all users without a single byte of video ever leaving
 * anyone's computer. Entirely best-effort: if the user isn't signed in
 * (no token pushed from the renderer yet) or the site is unreachable, this
 * silently no-ops — sync is a bonus, never a rendering dependency.
 */
export async function syncRenderMetadata(entry: RenderLibraryEntry): Promise<void> {
  const token = getAuthToken();
  if (!token) return; // not signed in — nothing to attribute this render to
  try {
    const res = await fetch(`${SITE_API_BASE}/api/render-library`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: entry.id,
        projectId: entry.projectId,
        projectName: entry.projectName,
        name: entry.name,
        createdAt: entry.createdAt,
        durationSeconds: entry.durationSeconds,
        fileSizeBytes: entry.fileSizeBytes,
        outputExt: entry.outputExt,
      }),
    });
    if (!res.ok) log.warn(`render metadata sync returned ${res.status}`);
  } catch (err) {
    log.warn("render metadata sync failed (offline?):", String(err));
  }
}

export async function syncRenderDeletion(renderId: string): Promise<void> {
  const token = getAuthToken();
  if (!token) return;
  try {
    await fetch(`${SITE_API_BASE}/api/render-library`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: renderId }),
    });
  } catch (err) {
    log.warn("render deletion sync failed (offline?):", String(err));
  }
}
