import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth, signInWithCustomToken, signOut as firebaseSignOut,
  onAuthStateChanged, browserLocalPersistence, setPersistence, type Auth, type User,
} from "firebase/auth";
import { FIREBASE_CONFIG, isFirebaseConfigured, SITE_API_BASE } from "../shared/firebaseConfig";

/**
 * Firebase Auth runs HERE, in the status window's renderer process — not
 * in Electron's main process. The Firebase JS SDK's persistence layer
 * genuinely needs a browser-shaped `window` with real `localStorage` /
 * `indexedDB`, which the main process (a plain Node context, even inside
 * Electron) does not provide; the renderer's BrowserWindow does, since
 * it's an actual Chromium page. Lets a user sign in with the SAME account
 * they use on manim-std.vercel.app (same Firebase project — see
 * shared/firebaseConfig.ts — and the site's login page already supports
 * email+password, so no OAuth-redirect/popup flow is needed here).
 *
 * contextIsolation is on for this window (see main/index.ts), so this
 * module only ever runs inside the isolated renderer bundle loaded by
 * status.html — it never touches Node/Electron APIs directly.
 */

let auth: Auth | null = null;
let ready: Promise<void> | null = null;

function ensureAuth(): Auth | null {
  if (!isFirebaseConfigured()) return null;
  if (auth) return auth;
  const app: FirebaseApp = getApps()[0] ?? initializeApp(FIREBASE_CONFIG);
  auth = getAuth(app);
  ready = setPersistence(auth, browserLocalPersistence).catch(() => {
    /* falls back to Firebase's in-memory default — sign-in still works,
       it just won't survive closing the status window */
  });
  return auth;
}

export function authConfigured(): boolean {
  return isFirebaseConfigured();
}

export function onAuthChange(fn: (user: User | null) => void): () => void {
  const a = ensureAuth();
  if (!a) {
    fn(null);
    return () => {};
  }
  return onAuthStateChanged(a, fn);
}

export interface SignInResult {
  ok: boolean;
  error?: string;
}

/**
 * Device-code sign-in: shows a short code (from the website's
 * /api/auth/device/start), polls /api/auth/device/poll until the user has
 * entered it on manim-std.vercel.app/device while signed in there, then
 * exchanges the resulting Firebase custom token for a real session here —
 * same mechanism as any other Firebase Auth sign-in method
 * (signInWithCustomToken), so onAuthStateChanged/getIdToken/persistence
 * all keep working exactly as before. No password is ever typed into this
 * app; the browser is the only place credentials are entered.
 */
export interface DeviceCodeSession {
  code: string;
  /** Cancels this session's polling — call when the status window closes
   *  or the user starts a new sign-in attempt before this one finished. */
  cancel: () => void;
  /** Resolves once claimed+signed-in, or on expiry/cancel/error. */
  done: Promise<SignInResult>;
}

export async function startDeviceCodeSignIn(): Promise<DeviceCodeSession | { error: string }> {
  const a = ensureAuth();
  if (!a) return { error: "This build isn't configured for sign-in." };

  let startRes: Response;
  try {
    startRes = await fetch(`${SITE_API_BASE}/api/auth/device/start`, { method: "POST" });
  } catch {
    return { error: "Couldn't reach the sign-in server — check your internet connection." };
  }
  const startData = await startRes.json().catch(() => null);
  if (!startRes.ok || !startData?.code || !startData?.deviceToken) {
    return { error: startData?.error ?? "Could not start sign-in — try again." };
  }
  const { code, deviceToken, expiresIn } = startData as { code: string; deviceToken: string; expiresIn: number };

  let cancelled = false;
  const cancel = () => { cancelled = true; };

  const done = (async (): Promise<SignInResult> => {
    if (ready) await ready;
    const deadline = Date.now() + expiresIn * 1000;
    while (!cancelled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (cancelled) break;
      let pollRes: Response;
      try {
        pollRes = await fetch(`${SITE_API_BASE}/api/auth/device/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, deviceToken }),
        });
      } catch {
        continue; // transient network hiccup — keep polling until the deadline
      }
      const pollData = await pollRes.json().catch(() => null);
      if (pollData?.status === "claimed" && pollData.customToken) {
        try {
          const cred = await signInWithCustomToken(a, pollData.customToken);
          await ensureProfile(cred.user);
          return { ok: true };
        } catch {
          return { ok: false, error: "Sign-in failed. Please try again." };
        }
      }
      if (pollData?.status === "expired" || pollData?.status === "not-found") {
        return { ok: false, error: "That code expired — click Sign in for a new one." };
      }
      // status "pending" — keep polling
    }
    return cancelled
      ? { ok: false }
      : { ok: false, error: "That code expired — click Sign in for a new one." };
  })();

  return { code, cancel, done };
}

export async function signOutUser(): Promise<void> {
  if (!auth) return;
  try {
    await firebaseSignOut(auth);
  } catch {
    /* nothing further to do if sign-out itself fails — the session token
       simply expires on Firebase's own schedule */
  }
}

/** Mirrors the exact call the website makes right after its own sign-in,
 *  so a first-time desktop sign-in provisions the same Firestore profile doc. */
async function ensureProfile(user: User): Promise<void> {
  try {
    const token = await user.getIdToken();
    await fetch(`${SITE_API_BASE}/api/auth/profile`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* non-fatal — a failed profile sync shouldn't block sign-in itself */
  }
}

export async function currentIdToken(): Promise<string | null> {
  const a = ensureAuth();
  const user = a?.currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken();
  } catch {
    return null;
  }
}

export function currentUserInfo(): { email: string | null; name: string | null } | null {
  const user = auth?.currentUser;
  if (!user) return null;
  return { email: user.email, name: user.displayName };
}
