import { currentIdToken } from "./firebase";
import { SITE_API_BASE } from "../shared/firebaseConfig";

export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  kind: "info" | "update" | "warning";
  url: string | null;
  createdAt: string;
}

/**
 * Pulls platform notifications the admin published from the website's
 * `/api/notifications` (see manim edit's src/app/api/notifications/route.ts)
 * — requires being signed in (see firebase.ts), since the endpoint is
 * Bearer-authenticated like every other site API. Read-only: authoring
 * happens on the website's /admin dashboard, never from this app.
 */
export async function fetchNotifications(): Promise<NotificationItem[]> {
  const token = await currentIdToken();
  if (!token) return [];
  try {
    const res = await fetch(`${SITE_API_BASE}/api/notifications`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { notifications?: NotificationItem[] };
    return data.notifications ?? [];
  } catch {
    // offline or the site is unreachable — the notification center just
    // shows nothing new rather than erroring the whole status window
    return [];
  }
}

const SEEN_KEY = "ms-agent-seen-notifications";

export function unseenCount(items: NotificationItem[]): number {
  const seen = loadSeenIds();
  return items.filter((n) => !seen.has(n.id)).length;
}

export function markAllSeen(items: NotificationItem[]): void {
  const seen = loadSeenIds();
  for (const n of items) seen.add(n.id);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-500)));
  } catch {
    /* localStorage being unavailable/full just means "seen" state resets — cosmetic only */
  }
}

function loadSeenIds(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
