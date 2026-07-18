/**
 * The SAME Firebase web-app config the website embeds client-side (see
 * manim edit's src/lib/firebase/client.ts) — these are public web credentials
 * (safe to ship inside this app, exactly as the site ships them to every
 * browser), NOT service-account secrets. Filling these in points this
 * desktop agent at the identical Firebase project as manim-std.vercel.app,
 * so "log in with your Manim Studio account" logs into the same account.
 *
 * Populate via a `.env` file at the project root (see .env.example) — read
 * at build time by scripts/generate-firebase-config.js into
 * src/shared/firebaseConfig.generated.ts, which this file re-exports. This
 * indirection exists so the real values never need to be hand-typed into
 * source control-tracked code; only the generated file (gitignored) holds
 * them, mirroring how the website itself keeps these out of committed code.
 */
export { FIREBASE_CONFIG, SITE_API_BASE, UPDATE_REPO, isFirebaseConfigured } from "./firebaseConfig.generated";
