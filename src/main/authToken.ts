/**
 * Holds the current signed-in user's Firebase ID token, as pushed from the
 * status window's renderer process (see renderer/app.ts's onAuthChange
 * handler + preload's `agentAuth.pushToken`). The main process never runs
 * the Firebase Auth SDK itself (it needs a real browser `window`, which
 * only the renderer has — see renderer/firebase.ts) but DOES need a
 * Bearer token to sync completed-render metadata to the site's
 * /api/render-library endpoint (renderWorker.ts) — this small in-memory
 * holder is the bridge between the two.
 *
 * Deliberately NOT persisted to disk: it's a live, frequently-refreshed
 * token (Firebase ID tokens expire hourly), re-pushed by the renderer
 * every time onAuthChange fires or the window reopens. If no token has
 * ever been pushed (user isn't signed in, or signed out), metadata sync
 * is simply skipped — rendering itself never depends on this.
 */

let currentToken: string | null = null;

export function setAuthToken(token: string | null): void {
  currentToken = token;
}

export function getAuthToken(): string | null {
  return currentToken;
}
