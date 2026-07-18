/**
 * Rasterizes the Manim Studio brand mark (build/assets/logo.svg — the same
 * gradient "M" mark used on the website, src/app/icon.svg there) into every
 * icon file this app needs: build/icon.ico (Windows installer + app icon),
 * build/icon.png (Linux AppImage icon), build/icon.icns (macOS app icon,
 * mac-only — see below), and build/tray-icon.png (system tray, small so it
 * reads crisply at 16-32px). Build-time only, like prepare-runtime.js —
 * never runs on a user's machine.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");
const pngToIco = require("png-to-ico").default;

const SVG_PATH = path.join(__dirname, "..", "build", "assets", "logo.svg");
const ICO_PATH = path.join(__dirname, "..", "build", "icon.ico");
const LINUX_PNG_PATH = path.join(__dirname, "..", "build", "icon.png");
const ICNS_PATH = path.join(__dirname, "..", "build", "icon.icns");
const TRAY_PATH = path.join(__dirname, "..", "build", "tray-icon.png");

async function generateWindowsIco(svg) {
  // .ico needs several embedded sizes so Windows picks a crisp one for
  // taskbar/desktop/installer contexts — 16 up through 256.
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = await Promise.all(
    icoSizes.map((size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer()),
  );
  const ico = await pngToIco(pngBuffers);
  fs.writeFileSync(ICO_PATH, ico);
  console.log(`Wrote ${ICO_PATH}`);
}

async function generateLinuxPng(svg) {
  // electron-builder's AppImage target accepts one large PNG directly —
  // no iconset/multi-size packaging needed like .ico or .icns.
  await sharp(svg, { density: 384 }).resize(512, 512).png().toFile(LINUX_PNG_PATH);
  console.log(`Wrote ${LINUX_PNG_PATH}`);
}

/** macOS .icns needs `iconutil`, which only exists on macOS itself — so
 *  this step is skipped (with a clear message) everywhere else. Building
 *  the mac target therefore needs to happen from an actual Mac at least
 *  once to produce build/icon.icns, same as any other platform-specific
 *  build asset; commit the result afterwards like the other build/ files. */
async function generateMacIcns(svg) {
  if (os.platform() !== "darwin") {
    console.log(
      "[generate-icons] Skipping build/icon.icns — `iconutil` is macOS-only. " +
      "Run this script on a Mac to produce it (needed before `npm run dist:mac`).",
    );
    return;
  }
  const iconsetDir = path.join(__dirname, "..", "build", "icon.iconset");
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir, { recursive: true });

  // Apple's iconset naming convention: base size plus an explicit @2x
  // (double-resolution) variant for each of the required sizes.
  const sizes = [16, 32, 128, 256, 512];
  await Promise.all(sizes.flatMap((size) => [
    sharp(svg, { density: 384 }).resize(size, size).png()
      .toFile(path.join(iconsetDir, `icon_${size}x${size}.png`)),
    sharp(svg, { density: 384 }).resize(size * 2, size * 2).png()
      .toFile(path.join(iconsetDir, `icon_${size}x${size}@2x.png`)),
  ]));

  execFileSync("iconutil", ["--convert", "icns", "--output", ICNS_PATH, iconsetDir], { stdio: "inherit" });
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  console.log(`Wrote ${ICNS_PATH}`);
}

async function main() {
  const svg = fs.readFileSync(SVG_PATH);

  await generateWindowsIco(svg);
  await generateLinuxPng(svg);
  await generateMacIcns(svg);

  // Tray icons render best small and un-scaled — 32px, Electron picks the
  // right DPI variant itself on Windows from a single PNG.
  await sharp(svg, { density: 384 }).resize(32, 32).png().toFile(TRAY_PATH);
  console.log(`Wrote ${TRAY_PATH}`);
}

main().catch((err) => {
  console.error("[generate-icons] FAILED:", err);
  process.exit(1);
});
