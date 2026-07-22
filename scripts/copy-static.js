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

// The tray icon lives in build/ (a buildResources dir NOT bundled into the
// installer — only dist/ is, per package.json's build.files). Copy it into
// dist/assets so the packaged app can actually find it at runtime; without
// this the tray shows a blank icon on installed builds.
const assetsDest = path.join(__dirname, "..", "dist", "assets");
fs.mkdirSync(assetsDest, { recursive: true });
const trayIconSrc = path.join(__dirname, "..", "build", "tray-icon.png");
if (fs.existsSync(trayIconSrc)) {
  fs.copyFileSync(trayIconSrc, path.join(assetsDest, "tray-icon.png"));
  console.log("Copied tray-icon.png to dist/assets");
}
