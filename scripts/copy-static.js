// Copies non-bundled renderer assets (HTML/CSS/plain JS) into dist/renderer
// alongside the compiled preload.js and the esbuild-bundled app.js — tsc
// only emits .ts files and app.ts needs real bundling (see
// bundle-renderer.js), so anything else plain gets copied here as a
// post-build step (see package.json's build script).
const fs = require("node:fs");
const path = require("node:path");

const srcDir = path.join(__dirname, "..", "src", "renderer");
const destDir = path.join(__dirname, "..", "dist", "renderer");
const SKIP = new Set(["app.ts", "preload.ts", "firebase.ts", "notifications.ts"]);

fs.mkdirSync(destDir, { recursive: true });
for (const file of fs.readdirSync(srcDir)) {
  if (SKIP.has(file)) continue;
  if (file.endsWith(".ts")) continue;
  fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
}
console.log("Copied static renderer assets to dist/renderer");
