import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth, signInWithEmailAndPassword, signOut as firebaseSignOut,
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

function friendlyAuthError(code: string): string {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "That email and password don't match an account.";
    case "auth/too-many-requests":
      return "Too many attempts — wait a bit and try again.";
    case "auth/invalid-email":
      return "That doesn't look like a valid email address.";
    case "auth/network-request-failed":
      return "Couldn't reach the sign-in server — check your internet connection.";
    default:
      return "Sign-in failed. Please try again.";
  }
}

export interface SignInResult {
  ok: boolean;
  error?: string;
}

export async function signIn(email: string, password: string): Promise<SignInResult> {
  const a = ensureAuth();
  if (!a) return { ok: false, error: "This build isn't configured for sign-in." };
  if (ready) await ready;
  try {
    const cred = await signInWithEmailAndPassword(a, email.trim(), password);
    await ensureProfile(cred.user);
    return { ok: true };
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    return { ok: false, error: friendlyAuthError(code) };
  }
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
