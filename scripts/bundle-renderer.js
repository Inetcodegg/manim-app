/**
 * Bundles the renderer's browser-side TypeScript (app.ts, which pulls in
 * the Firebase SDK + firebase.ts + notifications.ts) into a single
 * dist/renderer/app.js a plain <script> tag can load — tsc alone emits
 * CommonJS `require()` calls that don't resolve in a browser context, so
 * this needs real bundling. preload.ts is NOT bundled here — it runs in
 * Electron's preload context (has `require`), so tsc's normal CommonJS
 * output already works for it; only see copy-static.js/tsconfig for that.
 */
const esbuild = require("esbuild");
const path = require("node:path");

async function main() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", "renderer", "app.ts")],
    outfile: path.join(__dirname, "..", "dist", "renderer", "app.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120", // matches the Electron/Chromium version this app ships
    minify: false,
    sourcemap: true,
  });
  console.log("[bundle-renderer] wrote dist/renderer/app.js");
}

main().catch((err) => {
  console.error("[bundle-renderer] FAILED:", err);
  process.exit(1);
});
