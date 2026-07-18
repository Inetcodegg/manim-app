import { onAuthChange, signIn, signOutUser, currentIdToken } from "./firebase";
import { fetchNotifications, unseenCount, markAllSeen, type NotificationItem } from "./notifications";

/**
 * The status window's browser-side entry point — bundled by
 * scripts/bundle-renderer.js (esbuild) into dist/renderer/app.js, since it
 * imports the Firebase SDK and needs real module resolution/bundling, not
 * just a tsc pass. Everything the plain (unbundled) status.js used to do
 * for runtime checks stays in status.js; this file owns the account +
 * notification-center + update-banner UI, all of it additive to the
 * original diagnostic view.
 */

declare global {
  interface Window {
    agentStatus: {
      get: () => Promise<{ runtime: { python: boolean; latex: boolean; ffmpeg: boolean; ready: boolean; detail: string[] }; port: number }>;
      tailLog: () => Promise<string>;
      config: () => Promise<{ firebaseConfigured: boolean; siteApiBase: string }>;
    };
    agentUpdate: {
      check: () => Promise<unknown>;
      getState: () => Promise<UpdateState>;
      install: () => Promise<void>;
      onStateChanged: (fn: (state: UpdateState) => void) => () => void;
    };
    agentAuth: {
      pushToken: (token: string | null) => Promise<void>;
    };
  }
}

type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "available"; version: string }
  | { phase: "not-available" }
  | { phase: "downloading"; percent: number }
  | { phase: "downloaded"; version: string }
  | { phase: "error"; message: string };

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ---------------------------------------------------------------- account

function renderAccountLoggedOut(errorMsg?: string): void {
  const box = el<HTMLDivElement>("account-body");
  if (!box) return;
  box.innerHTML = `
    <p class="account-hint">Sign in with your Manim Studio account to see platform notifications here.</p>
    <input id="acc-email" class="account-input" type="email" placeholder="Email" autocomplete="username" />
    <input id="acc-password" class="account-input" type="password" placeholder="Password" autocomplete="current-password" />
    ${errorMsg ? `<p class="account-error">${escapeHtml(errorMsg)}</p>` : ""}
    <button id="acc-signin" class="account-btn">Sign in</button>
  `;
  el<HTMLButtonElement>("acc-signin")?.addEventListener("click", () => void doSignIn());
  el<HTMLInputElement>("acc-password")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void doSignIn();
  });
}

async function doSignIn(): Promise<void> {
  const email = el<HTMLInputElement>("acc-email")?.value ?? "";
  const password = el<HTMLInputElement>("acc-password")?.value ?? "";
  const btn = el<HTMLButtonElement>("acc-signin");
  if (btn) {
    btn.textContent = "Signing in…";
    btn.setAttribute("disabled", "true");
  }
  const result = await signIn(email, password);
  if (!result.ok) renderAccountLoggedOut(result.error);
}

function renderAccountLoggedIn(email: string | null): void {
  const box = el<HTMLDivElement>("account-body");
  if (!box) return;
  box.innerHTML = `
    <div class="account-row">
      <span class="account-avatar">${escapeHtml((email || "?").charAt(0).toUpperCase())}</span>
      <span class="account-email">${escapeHtml(email ?? "Signed in")}</span>
      <button id="acc-signout" class="account-btn-outline">Sign out</button>
    </div>
  `;
  el<HTMLButtonElement>("acc-signout")?.addEventListener("click", () => void signOutUser());
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ----------------------------------------------------------- notifications

let notifItems: NotificationItem[] = [];

function renderNotifications(): void {
  const list = el<HTMLDivElement>("notif-list");
  const badge = el<HTMLSpanElement>("notif-badge");
  if (!list) return;
  if (notifItems.length === 0) {
    list.innerHTML = `<p class="notif-empty">No notifications yet.</p>`;
  } else {
    list.innerHTML = notifItems
      .map((n) => `
        <div class="notif-item notif-${n.kind}">
          <div class="notif-item-title">${escapeHtml(n.title)}</div>
          <div class="notif-item-body">${escapeHtml(n.body)}</div>
          ${n.url ? `<a class="notif-item-link" href="${escapeHtml(n.url)}" target="_blank" rel="noopener">Learn more →</a>` : ""}
        </div>
      `)
      .join("");
  }
  const unseen = unseenCount(notifItems);
  if (badge) {
    if (unseen > 0) {
      badge.style.display = "inline-flex";
      badge.textContent = String(unseen);
    } else {
      badge.style.display = "none";
    }
  }
}

async function refreshNotifications(): Promise<void> {
  notifItems = await fetchNotifications();
  renderNotifications();
}

// ----------------------------------------------------------------- update

function renderUpdateBanner(state: UpdateState): void {
  const banner = el<HTMLDivElement>("update-banner");
  if (!banner) return;
  if (state.phase === "available" || state.phase === "checking") {
    banner.style.display = "flex";
    banner.innerHTML = `<span>New version ${"version" in state ? state.version : ""} found — downloading…</span>`;
  } else if (state.phase === "downloading") {
    banner.style.display = "flex";
    banner.innerHTML = `<span>Downloading update… ${state.percent}%</span>`;
  } else if (state.phase === "downloaded") {
    banner.style.display = "flex";
    banner.innerHTML = `<span>Version ${state.version} is ready.</span><button id="update-install" class="account-btn">Restart &amp; update</button>`;
    el<HTMLButtonElement>("update-install")?.addEventListener("click", () => void window.agentUpdate.install());
  } else {
    banner.style.display = "none";
  }
}

// -------------------------------------------------------------------- init

async function init(): Promise<void> {
  const config = await window.agentStatus.config().catch(() => ({ firebaseConfigured: false, siteApiBase: "" }));

  if (config.firebaseConfigured) {
    onAuthChange((user) => {
      if (user) {
        renderAccountLoggedIn(user.email);
        void refreshNotifications();
        // push a fresh ID token to the main process now, and again on
        // Firebase's own ~hourly refresh schedule — the main process needs
        // this to sync completed-render metadata (see renderWorker.ts),
        // but never runs the Auth SDK itself (no browser `window` there)
        void currentIdToken().then((token) => window.agentAuth.pushToken(token));
      } else {
        renderAccountLoggedOut();
        notifItems = [];
        renderNotifications();
        void window.agentAuth.pushToken(null);
      }
    });
    // Firebase ID tokens expire hourly; re-push periodically so a long-
    // running status window (and thus a long-idle main process) doesn't
    // end up syncing metadata with a stale/expired token
    setInterval(() => {
      void currentIdToken().then((token) => window.agentAuth.pushToken(token));
    }, 20 * 60 * 1000);
  } else {
    const box = el<HTMLDivElement>("account-body");
    if (box) box.innerHTML = `<p class="account-hint">This build isn't configured for account sign-in.</p>`;
  }

  window.agentUpdate.onStateChanged(renderUpdateBanner);
  const initialUpdateState = await window.agentUpdate.getState().catch(() => ({ phase: "idle" as const }));
  renderUpdateBanner(initialUpdateState);

  const notifButton = el<HTMLButtonElement>("notif-bell");
  const notifPanel = el<HTMLDivElement>("notif-panel");
  notifButton?.addEventListener("click", () => {
    if (!notifPanel) return;
    const opening = notifPanel.style.display !== "block";
    notifPanel.style.display = opening ? "block" : "none";
    if (opening) markAllSeen(notifItems);
    renderNotifications();
  });

  setInterval(() => void refreshNotifications(), 5 * 60 * 1000);
}

void init();
