import { onAuthChange, startDeviceCodeSignIn, signOutUser, currentIdToken, currentUserInfo, type DeviceCodeSession } from "./firebase";
import { fetchNotifications, unseenCount, markAllSeen, type NotificationItem } from "./notifications";

/**
 * The status window's browser-side entry point — bundled by
 * scripts/bundle-renderer.js (esbuild) into dist/renderer/app.js. Owns the
 * ENTIRE window now (runtime checks, account, notifications, stats, update
 * banner, and English/Uzbek language switching) — the old split with a
 * separate plain status.js was merged in so language switching can retitle
 * every piece of UI from one place.
 */

declare global {
  interface Window {
    agentStatus: {
      get: () => Promise<{ runtime: RuntimeStatus; port: number }>;
      tailLog: () => Promise<string>;
      config: () => Promise<{ firebaseConfigured: boolean; siteApiBase: string }>;
      stats: () => Promise<RenderStats>;
    };
    agentUpdate: {
      check: () => Promise<unknown>;
      getState: () => Promise<UpdateState>;
      install: () => Promise<void>;
      onStateChanged: (fn: (state: UpdateState) => void) => () => void;
    };
    agentAuth: { pushToken: (token: string | null) => Promise<void> };
    agentShell: {
      openLogsFolder: () => Promise<void>;
      openExternal: (url: string) => Promise<void>;
    };
  }
}

interface RuntimeStatus { python: boolean; latex: boolean; ffmpeg: boolean; ready: boolean; detail: string[]; }
interface RenderStats { totalRenders: number; totalSeconds: number; totalBytes: number; lastRenderAt: string | null; }

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
function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ============================================================ i18n

type Lang = "en" | "uz";
type Dict = Record<string, string>;

const STRINGS: Record<Lang, Dict> = {
  en: {
    subtitle: "Local render agent",
    checking: "Checking…",
    checking_short: "checking…",
    ready: "Ready",
    needs_attention: "Needs attention",
    working: "Working",
    not_working: "Not working",
    account: "Account",
    stats_title: "Your renders",
    stat_renders: "Renders",
    stat_duration: "Total length",
    stat_size: "On disk",
    runtime: "System status",
    comp_engine: "Animation engine",
    comp_math: "Math & formulas",
    comp_video: "Video export",
    connection: "Connection",
    about: "What this app does",
    about_1: "Detected automatically by the Manim Studio site when it's open",
    about_2: "Makes your animations right here on this computer",
    about_3: "Your videos never leave this machine — they go straight to your browser",
    activity: "Recent activity",
    loading: "Loading…",
    loading_first: "Getting things ready — this can take a moment the first time.",
    loading_almost: "Almost there…",
    footer: "Closing this window keeps the app running in the background.",
    sign_in_hint: "Sign in with your Manim Studio account to see notifications here.",
    sign_in: "Sign in",
    sign_out: "Sign out",
    signed_in: "Signed in",
    device_hint: "Open {url} and enter this code:",
    device_waiting: "Waiting for you to enter it…",
    cancel: "Cancel",
    not_configured: "This version isn't set up for sign-in.",
    no_activity: "Nothing here yet.",
    no_notifs: "No notifications yet.",
    update_found: "New version {v} found — downloading…",
    update_downloading: "Downloading update… {p}%",
    update_ready: "Version {v} is ready.",
    restart_update: "Restart & update",
    none_yet: "None yet",
    minutes: "min",
    seconds: "sec",
    all_ready: "Everything's ready",
    setting_up: "Setting up…",
  },
  uz: {
    subtitle: "Lokal render agenti",
    checking: "Tekshirilyapti…",
    checking_short: "tekshirilyapti…",
    ready: "Tayyor",
    needs_attention: "Muammo bor",
    working: "Ishlayapti",
    not_working: "Ishlamayapti",
    account: "Hisob",
    stats_title: "Sizning renderlaringiz",
    stat_renders: "Renderlar",
    stat_duration: "Umumiy uzunlik",
    stat_size: "Diskda",
    runtime: "Tizim holati",
    comp_engine: "Animatsiya mexanizmi",
    comp_math: "Matematika va formulalar",
    comp_video: "Video eksport",
    connection: "Ulanish",
    about: "Bu ilova nima qiladi",
    about_1: "Manim Studio sayti ochilganda avtomatik aniqlanadi",
    about_2: "Animatsiyalaringizni to'liq shu kompyuterda tayyorlaydi",
    about_3: "Videolaringiz qurilmadan chiqmaydi — to'g'ridan brauzeringizga boradi",
    activity: "So'nggi faoliyat",
    loading: "Yuklanyapti…",
    loading_first: "Tayyorlanyapti — birinchi marta biroz vaqt olishi mumkin.",
    loading_almost: "Deyarli tayyor…",
    footer: "Oynani yopsangiz ham ilova fonda ishlab turadi.",
    sign_in_hint: "Bildirishnomalarni ko'rish uchun Manim Studio hisobingiz bilan kiring.",
    sign_in: "Kirish",
    sign_out: "Chiqish",
    signed_in: "Kirdingiz",
    device_hint: "{url} manzilini oching va shu kodni kiriting:",
    device_waiting: "Kodni kiritishingizni kutyapmiz…",
    cancel: "Bekor qilish",
    not_configured: "Bu versiya kirish uchun sozlanmagan.",
    no_activity: "Hozircha hech narsa yo'q.",
    no_notifs: "Hozircha bildirishnoma yo'q.",
    update_found: "Yangi versiya {v} topildi — yuklanyapti…",
    update_downloading: "Yangilanish yuklanyapti… {p}%",
    update_ready: "{v} versiya tayyor.",
    restart_update: "Qayta ishga tushirish",
    none_yet: "Hali yo'q",
    minutes: "daq",
    seconds: "son",
    all_ready: "Hammasi tayyor",
    setting_up: "Sozlanyapti…",
  },
};

let lang: Lang = (localStorage.getItem("lang") as Lang) || "uz";

function t(key: string, vars?: Record<string, string | number>): string {
  let s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

/** Applies the current language to every element carrying data-i18n. */
function applyStaticI18n(): void {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (key) node.textContent = t(key);
  });
  const langBtn = el<HTMLButtonElement>("lang-btn");
  if (langBtn) langBtn.textContent = lang === "uz" ? "UZ" : "EN";
}

// ============================================================ runtime checks

function setCheck(name: string, ok: boolean): void {
  const icon = el(`icon-${name}`);
  const value = el(`value-${name}`);
  if (icon) { icon.className = `check-icon ${ok ? "ok" : "bad"}`; icon.textContent = ok ? "✓" : "✕"; }
  if (value) { value.textContent = ok ? t("working") : t("not_working"); value.className = `check-value ${ok ? "ok" : "bad"}`; }
}

function setPill(ready: boolean): void {
  const pill = el("pill");
  const text = el("pill-text");
  if (!pill || !text) return;
  pill.className = `pill ${ready ? "ok" : "bad"}`;
  text.textContent = ready ? t("ready") : t("needs_attention");
}

let lastRuntime: RuntimeStatus | null = null;
let firstCheckDone = false;

async function refreshStatus(): Promise<void> {
  try {
    const status = await window.agentStatus.get();
    lastRuntime = status.runtime;
    setCheck("python", status.runtime.python);
    setCheck("latex", status.runtime.latex);
    setCheck("ffmpeg", status.runtime.ffmpeg);
    setPill(status.runtime.ready);
    const hint = el("hint");
    if (hint) {
      if (!status.runtime.ready && status.runtime.detail?.length) {
        hint.style.display = "block";
        hint.textContent = status.runtime.detail.join("\n");
      } else {
        hint.style.display = "none";
      }
    }
    // the very first check that comes back READY dismisses the loading
    // overlay; if it comes back NOT ready we still dismiss (the status
    // cards themselves explain what's wrong) so the user is never stuck
    // staring at a spinner.
    if (!firstCheckDone) { firstCheckDone = true; hideLoading(); }
  } catch { /* leave last-known values, retry next tick */ }
}

// ============================================================ loading overlay

function hideLoading(): void {
  const overlay = el("loading");
  if (!overlay) return;
  overlay.classList.add("hide");
  // remove from the layout after the fade so it never traps focus/scroll
  setTimeout(() => { overlay.style.display = "none"; }, 550);
}

// while the first runtime check runs (a cold Python import can take ~30s on
// first launch), reassure the user with a rotating message instead of a
// silent spinner. Cleared as soon as the overlay is hidden.
function startLoadingMessages(): void {
  const sub = el("loading-sub");
  if (!sub) return;
  let step = 0;
  const timer = setInterval(() => {
    if (firstCheckDone) { clearInterval(timer); return; }
    step++;
    if (step === 1) sub.textContent = t("setting_up");
    else if (step >= 3) sub.textContent = t("loading_almost");
  }, 6000);
}

// ============================================================ stats

function fmtDuration(sec: number): { value: string; unit: string } {
  if (sec <= 0) return { value: "0", unit: t("seconds") };
  if (sec < 60) return { value: String(Math.round(sec)), unit: t("seconds") };
  return { value: (sec / 60).toFixed(1), unit: t("minutes") };
}
function fmtSize(bytes: number): { value: string; unit: string } {
  if (bytes <= 0) return { value: "0", unit: "MB" };
  const mb = bytes / (1024 * 1024);
  if (mb < 1000) return { value: mb.toFixed(mb < 10 ? 1 : 0), unit: "MB" };
  return { value: (mb / 1024).toFixed(1), unit: "GB" };
}

async function refreshStats(): Promise<void> {
  let stats: RenderStats;
  try { stats = await window.agentStatus.stats(); } catch { return; }
  const setStat = (id: string, value: string, unit?: string) => {
    const node = el(id);
    if (node) node.innerHTML = unit ? `${escapeHtml(value)}<span class="unit">${escapeHtml(unit)}</span>` : escapeHtml(value);
  };
  setStat("stat-count", String(stats.totalRenders));
  const d = fmtDuration(stats.totalSeconds);
  setStat("stat-duration", d.value, d.unit);
  const s = fmtSize(stats.totalBytes);
  setStat("stat-size", s.value, s.unit);
}

// ============================================================ account

let activeDeviceSession: DeviceCodeSession | null = null;
let siteApiBase = "";
let firebaseConfigured = false;

function renderAccountLoggedOut(errorMsg?: string): void {
  activeDeviceSession?.cancel();
  activeDeviceSession = null;
  const box = el("account-body");
  if (!box) return;
  if (!firebaseConfigured) {
    box.innerHTML = `<p class="account-hint">${escapeHtml(t("not_configured"))}</p>`;
    return;
  }
  box.innerHTML = `
    <p class="account-hint">${escapeHtml(t("sign_in_hint"))}</p>
    ${errorMsg ? `<p class="account-error">${escapeHtml(errorMsg)}</p>` : ""}
    <button id="acc-signin" class="account-btn">${escapeHtml(t("sign_in"))}</button>
  `;
  el<HTMLButtonElement>("acc-signin")?.addEventListener("click", () => void startSignIn());
}

function renderDeviceCode(code: string): void {
  const box = el("account-body");
  if (!box) return;
  const linkUrl = `${siteApiBase}/device`;
  const shortUrl = linkUrl.replace(/^https?:\/\//, "");
  box.innerHTML = `
    <p class="account-hint">${t("device_hint", { url: `<a href="#" id="acc-link">${escapeHtml(shortUrl)}</a>` })}</p>
    <div class="account-device-code">${escapeHtml(code)}</div>
    <p class="account-waiting"><span class="spinner"></span>${escapeHtml(t("device_waiting"))}</p>
    <button id="acc-cancel" class="account-btn-outline" style="width:100%;">${escapeHtml(t("cancel"))}</button>
  `;
  el("acc-link")?.addEventListener("click", (e) => { e.preventDefault(); void window.agentShell.openExternal(linkUrl); });
  el<HTMLButtonElement>("acc-cancel")?.addEventListener("click", () => renderAccountLoggedOut());
}

async function startSignIn(): Promise<void> {
  activeDeviceSession?.cancel();
  const session = await startDeviceCodeSignIn();
  if ("error" in session) { renderAccountLoggedOut(session.error); return; }
  activeDeviceSession = session;
  renderDeviceCode(session.code);
  const result = await session.done;
  if (activeDeviceSession !== session) return;
  activeDeviceSession = null;
  if (!result.ok && result.error) renderAccountLoggedOut(result.error);
}

function renderAccountLoggedIn(email: string | null): void {
  const box = el("account-body");
  if (!box) return;
  box.innerHTML = `
    <div class="account-row">
      <span class="account-avatar">${escapeHtml((email || "?").charAt(0).toUpperCase())}</span>
      <span class="account-email">${escapeHtml(email ?? t("signed_in"))}</span>
      <button id="acc-signout" class="account-btn-outline">${escapeHtml(t("sign_out"))}</button>
    </div>
  `;
  el<HTMLButtonElement>("acc-signout")?.addEventListener("click", () => void signOutUser());
}

// ============================================================ notifications

let notifItems: NotificationItem[] = [];

function renderNotifications(): void {
  const list = el("notif-list");
  const badge = el("notif-badge");
  if (!list) return;
  if (notifItems.length === 0) {
    list.innerHTML = `<p class="notif-empty">${escapeHtml(t("no_notifs"))}</p>`;
  } else {
    list.innerHTML = notifItems.map((n) => `
      <div class="notif-item notif-${escapeHtml(n.kind)}">
        <div class="notif-item-title">${escapeHtml(n.title)}</div>
        <div class="notif-item-body">${escapeHtml(n.body)}</div>
        ${n.url ? `<a class="notif-item-link" href="#" data-url="${escapeHtml(n.url)}">${lang === "uz" ? "Batafsil →" : "Learn more →"}</a>` : ""}
      </div>`).join("");
    list.querySelectorAll<HTMLAnchorElement>(".notif-item-link").forEach((a) => {
      a.addEventListener("click", (e) => { e.preventDefault(); const u = a.getAttribute("data-url"); if (u) void window.agentShell.openExternal(u); });
    });
  }
  const unseen = unseenCount(notifItems);
  if (badge) {
    if (unseen > 0) { badge.style.display = "inline-flex"; badge.textContent = String(unseen); }
    else badge.style.display = "none";
  }
}

async function refreshNotifications(): Promise<void> {
  notifItems = await fetchNotifications();
  renderNotifications();
}

// ============================================================ update banner

let lastUpdateState: UpdateState = { phase: "idle" };

function renderUpdateBanner(state: UpdateState): void {
  lastUpdateState = state;
  const banner = el("update-banner");
  if (!banner) return;
  if (state.phase === "available" || state.phase === "checking") {
    banner.style.display = "flex";
    banner.innerHTML = `<span>${escapeHtml(t("update_found", { v: "version" in state ? state.version : "" }))}</span>`;
  } else if (state.phase === "downloading") {
    banner.style.display = "flex";
    banner.innerHTML = `<span>${escapeHtml(t("update_downloading", { p: state.percent }))}</span>`;
  } else if (state.phase === "downloaded") {
    banner.style.display = "flex";
    banner.innerHTML = `<span>${escapeHtml(t("update_ready", { v: state.version }))}</span><button id="update-install" class="account-btn" style="width:auto;">${escapeHtml(t("restart_update"))}</button>`;
    el<HTMLButtonElement>("update-install")?.addEventListener("click", () => void window.agentUpdate.install());
  } else {
    banner.style.display = "none";
  }
}

// ============================================================ language switch

function switchLang(): void {
  lang = lang === "uz" ? "en" : "uz";
  localStorage.setItem("lang", lang);
  applyStaticI18n();
  // re-render every dynamic piece in the new language
  if (lastRuntime) {
    setCheck("python", lastRuntime.python);
    setCheck("latex", lastRuntime.latex);
    setCheck("ffmpeg", lastRuntime.ffmpeg);
    setPill(lastRuntime.ready);
  }
  void refreshStats();
  renderNotifications();
  renderUpdateBanner(lastUpdateState);
  // repaint the account view in the new language — but never disturb an
  // in-flight device-code session (that would drop the code off screen)
  if (!activeDeviceSession) {
    const user = currentUserInfo();
    if (user) renderAccountLoggedIn(user.email);
    else renderAccountLoggedOut();
  }
}

// ============================================================ init

async function init(): Promise<void> {
  applyStaticI18n();

  const config = await window.agentStatus.config().catch(() => ({ firebaseConfigured: false, siteApiBase: "" }));
  firebaseConfigured = config.firebaseConfigured;
  siteApiBase = config.siteApiBase;

  el<HTMLButtonElement>("lang-btn")?.addEventListener("click", switchLang);

  // show the loading overlay's reassuring messages until the first runtime
  // check comes back (a cold Python import is slow on first launch)
  startLoadingMessages();
  // safety net: never let the overlay trap the user forever, even if the
  // first check somehow never resolves
  setTimeout(() => { if (!firstCheckDone) { firstCheckDone = true; hideLoading(); } }, 90000);

  // runtime + stats, on a poll
  void refreshStatus();
  void refreshStats();
  setInterval(() => { void refreshStatus(); }, 4000);
  setInterval(() => { void refreshStats(); }, 15000);

  // account / auth
  if (firebaseConfigured) {
    onAuthChange((user) => {
      if (user) {
        renderAccountLoggedIn(user.email);
        void refreshNotifications();
        void currentIdToken().then((token) => window.agentAuth.pushToken(token));
      } else {
        renderAccountLoggedOut();
        notifItems = [];
        renderNotifications();
        void window.agentAuth.pushToken(null);
      }
    });
    setInterval(() => { void currentIdToken().then((token) => window.agentAuth.pushToken(token)); }, 20 * 60 * 1000);
  } else {
    renderAccountLoggedOut();
  }

  // update banner
  window.agentUpdate.onStateChanged(renderUpdateBanner);
  renderUpdateBanner(await window.agentUpdate.getState().catch(() => ({ phase: "idle" as const })));

  // notification bell
  const notifButton = el("notif-bell");
  const notifPanel = el("notif-panel");
  notifButton?.addEventListener("click", () => {
    if (!notifPanel) return;
    const opening = notifPanel.style.display !== "block";
    notifPanel.style.display = opening ? "block" : "none";
    if (opening) markAllSeen(notifItems);
    renderNotifications();
  });
  setInterval(() => void refreshNotifications(), 5 * 60 * 1000);
}

// app.js is loaded at the end of <body>, so the DOM is already parsed by
// the time this runs — but guard anyway in case that ever changes.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}
