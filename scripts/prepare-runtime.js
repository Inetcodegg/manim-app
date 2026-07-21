/**
 * Build-time (developer-machine) runtime assembly — NOT something the end
 * user ever runs. This is what makes "the user only downloads one
 * installer and never waits on a setup step" true: it downloads Python,
 * installs Manim + numpy into it, downloads a portable LaTeX distribution
 * and provisions its packages, and downloads a static FFmpeg build, all
 * into resources/runtime/ — which package.json's `build.extraResources`
 * then bakes straight into the installer. Run this once per release
 * (`npm run prepare-runtime`) before `npm run dist:win` / `dist:mac` /
 * `dist:linux`; it's incremental (skips anything already present), so
 * re-runs after a small code change are fast.
 *
 * This script always builds for the OS it's currently running ON — there's
 * no cross-compilation. To ship all three platforms you run this (and the
 * matching `npm run dist:*`) once on a Windows machine, once on a Mac, and
 * once on Linux (or three separate CI runners).
 *
 * This script itself needs network access and can take significant time
 * (LaTeX package provisioning especially) — that cost is paid ONCE by
 * whoever builds the installer, never by an end user's machine.
 */
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { execFileSync } = require("node:child_process");

const RESOURCES_DIR = path.join(__dirname, "..", "resources");
const RUNTIME_DIR = path.join(RESOURCES_DIR, "runtime");
const DOWNLOAD_CACHE = path.join(__dirname, "..", ".build-cache");

const PLATFORM = process.platform; // "win32" | "darwin" | "linux"
const IS_WINDOWS = PLATFORM === "win32";
const IS_MAC = PLATFORM === "darwin";
const IS_LINUX = PLATFORM === "linux";

const PYTHON_VERSION = "3.12.7"; // pinned to match the cloud renderer's python:3.12-slim
const PYTHON_EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py";
// Mac/Linux have no "embeddable" distribution like Windows does, so we use
// astral-sh/python-build-standalone's "install_only" builds instead — a
// prebuilt, relocatable CPython tarball with pip already included. Resolved
// dynamically (like TinyTeX below) since release tags are date-stamped.
const PYTHON_STANDALONE_RELEASES_API = "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest";
// TinyTeX's Windows-only artifact is a self-extracting installer .exe now,
// not a plain archive, and every release's asset names are versioned (no
// stable "latest/download/<fixed-name>" alias) — so we resolve the actual
// asset URL from the GitHub API instead of hardcoding one.
const TINYTEX_RELEASES_API = "https://api.github.com/repos/rstudio/tinytex-releases/releases/latest";
const FFMPEG_WIN_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
// Static builds with no installer step, one file per OS/arch.
const FFMPEG_MAC_URL = "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip";
const FFMPEG_MAC_PROBE_URL = "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip";
const FFMPEG_LINUX_URL = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz";
// A plain UA — some of these hosts (johnvansickle.com, evermeet.cx) 403
// requests with no User-Agent header at all.
const BROWSER_UA = "Mozilla/5.0 (manim-studio-render-agent build script)";

const LATEX_PACKAGES = [
  // note: amssymb.sty ships inside the amsfonts package itself — there is
  // no separate "amssymb" tlmgr package, so it's intentionally not listed.
  // note: "ctex" (CJK/Chinese typesetting support) is intentionally
  // dropped — it alone pulls in ~1GB+ of CJK fonts and the uptex/ptex/
  // platex engine variants as dependencies (cbfonts, gnu-freefont,
  // wadalab, arphic, fandol, etc.), none of which are needed unless
  // scenes render Chinese/Japanese/Korean text.
  "amsmath", "amsfonts", "babel-english", "cm-super",
  "doublestroke", "dvisvgm", "everysel", "fontspec", "frcursive",
  "jknapltx", "latex-bin", "mathastext", "microtype",
  "multitoc", "physics", "prelim2e", "preview", "ragged2e", "relsize",
  "rsfs", "setspace", "standalone", "tipa", "wasy", "wasysym", "xcolor",
  "xetex", "xkeyval",
];

function log(msg) {
  console.log(`[prepare-runtime] ${msg}`);
}

function download(url, destFile) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    const get = (u, redirects) => {
      https.get(u, { headers: { "User-Agent": BROWSER_UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error("too many redirects"));
          get(new URL(res.headers.location, u).toString(), redirects - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`download failed (${res.statusCode}) for ${u}`));
        }
        const out = fs.createWriteStream(destFile);
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve()));
        out.on("error", reject);
      }).on("error", reject);
    };
    get(url, 5);
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    // GitHub's API 403s requests with no User-Agent.
    https.get(url, { headers: { "User-Agent": "manim-studio-render-agent-build" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GitHub API request failed (${res.statusCode}) for ${url}`));
      }
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    }).on("error", reject);
  });
}

async function ensureDownloaded(url, filename) {
  const dest = path.join(DOWNLOAD_CACHE, filename);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    log(`using cached download: ${filename}`);
    return dest;
  }
  log(`downloading ${filename}`);
  const tmp = dest + ".part";
  await download(url, tmp);
  fs.renameSync(tmp, dest);
  return dest;
}

function extractZip(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (IS_WINDOWS) {
    // PowerShell's Expand-Archive ships on every Windows dev machine — no
    // extra npm dependency needed for a build-only script.
    execFileSync("powershell", [
      "-NoProfile", "-Command",
      `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
    ], { stdio: "inherit" });
  } else {
    // macOS and Linux both ship `unzip` by default.
    execFileSync("unzip", ["-o", "-q", archivePath, "-d", destDir], { stdio: "inherit" });
  }
}

/** Handles .tar.gz / .tar.xz / .tar.zst uniformly — `tar` ships on both
 *  macOS and Linux and auto-detects the compression from the archive. */
function extractTar(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync("tar", ["-xf", archivePath, "-C", destDir], { stdio: "inherit" });
}

function findFileRecursive(root, filename) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase() === filename.toLowerCase()) return dir;
    }
  }
  return null;
}

async function preparePythonWindows(pythonDir, pythonExe) {
  if (fs.existsSync(pythonExe)) {
    log("python already prepared, checking manim…");
    return;
  }
  const zip = await ensureDownloaded(PYTHON_EMBED_URL, `python-${PYTHON_VERSION}-embed-amd64.zip`);
  extractZip(zip, pythonDir);

  // re-enable `import site` so pip / manim's own imports resolve —
  // the embeddable distribution ships with site disabled by default.
  const pthFiles = fs.readdirSync(pythonDir).filter((f) => f.endsWith("._pth"));
  for (const f of pthFiles) {
    const full = path.join(pythonDir, f);
    const content = fs.readFileSync(full, "utf8");
    fs.writeFileSync(full, content.replace(/^#\s*import site/m, "import site"));
  }

  const getPip = await ensureDownloaded(GET_PIP_URL, "get-pip.py");
  log("installing pip…");
  execFileSync(pythonExe, [getPip, "--no-warn-script-location"], { stdio: "inherit" });
}

async function preparePythonUnix(pythonDir, pythonExe) {
  if (fs.existsSync(pythonExe)) {
    log("python already prepared, checking manim…");
    return;
  }
  log("resolving latest python-build-standalone release…");
  const release = await fetchJson(PYTHON_STANDALONE_RELEASES_API);
  const archSuffix = IS_MAC
    ? (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin")
    : "x86_64-unknown-linux-gnu"; // Linux: x86_64 only, matches the cloud renderer's arch
  const namePattern = new RegExp(`^cpython-${PYTHON_VERSION.replace(/\./g, "\\.")}\\+\\d+-${archSuffix}-install_only\\.tar\\.gz$`);
  const asset = (release.assets || []).find((a) => namePattern.test(a.name));
  if (!asset) {
    throw new Error(
      `Could not find a python-build-standalone ${PYTHON_VERSION} install_only build for ${archSuffix} ` +
      `in release ${release.tag_name}. Available: ${(release.assets || []).map((a) => a.name).join(", ")}`
    );
  }
  const tarball = await ensureDownloaded(asset.browser_download_url, asset.name);
  const extractDir = path.join(RUNTIME_DIR, "_python-extract");
  extractTar(tarball, extractDir);
  // python-build-standalone's install_only archives contain a single
  // top-level "python/" dir with bin/, lib/, include/ etc. already laid
  // out relocatably — copy straight to runtime/python.
  const found = findFileRecursive(extractDir, "python3") || path.join(extractDir, "python", "bin");
  const distRoot = path.resolve(found, "..", "..");
  fs.rmSync(pythonDir, { recursive: true, force: true });
  fs.cpSync(distRoot, pythonDir, { recursive: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
  // the tarball's python3 binary may be a version-suffixed symlink
  // (python3.12) rather than existing at bin/python3 directly.
  if (!fs.existsSync(pythonExe)) {
    const binDir = path.dirname(pythonExe);
    const candidate = fs.readdirSync(binDir).find((f) => /^python3(\.\d+)?$/.test(f));
    if (candidate) fs.symlinkSync(candidate, pythonExe);
  }
  execFileSync("chmod", ["+x", pythonExe]);
}

async function preparePython() {
  const pythonDir = path.join(RUNTIME_DIR, "python");
  const pythonExe = IS_WINDOWS
    ? path.join(pythonDir, "python.exe")
    : path.join(pythonDir, "bin", "python3");

  if (IS_WINDOWS) {
    await preparePythonWindows(pythonDir, pythonExe);
  } else {
    await preparePythonUnix(pythonDir, pythonExe);
  }

  // the embeddable Windows distribution's pip has no setuptools/wheel —
  // several manim dependencies (e.g. srt) ship no wheel and build from
  // sdist, which needs setuptools.build_meta as its build backend.
  // python-build-standalone's Unix builds already include them, but this
  // is a cheap no-op if already installed, so it's safe to always run.
  log("ensuring setuptools + wheel…");
  execFileSync(pythonExe, ["-m", "pip", "install", "--no-warn-script-location", "setuptools", "wheel"], {
    stdio: "inherit",
  });

  let manimOk = false;
  try {
    const out = execFileSync(pythonExe, ["-c", "import manim, numpy; print('ok')"], { encoding: "utf8" });
    manimOk = out.includes("ok");
  } catch {
    manimOk = false;
  }
  if (!manimOk) {
    log("installing manim + numpy (this can take a few minutes)…");
    execFileSync(pythonExe, ["-m", "pip", "install", "--no-warn-script-location", "manim==0.19.*", "numpy"], {
      stdio: "inherit",
    });
  } else {
    log("manim already installed and working");
  }
}

// TinyTeX's own launcher scripts (tlmgr.bat on Windows, tlmgr's Unix
// counterpart) locate the rest of the distro by walking up from their OWN
// path, hard-coded to expect this exact platform-triplet subfolder name
// under bin/ — so we preserve TinyTeX's native layout as-is instead of
// flattening it. Must match paths.ts's latexBinSubdir().
const LATEX_BIN_SUBDIR = IS_WINDOWS ? "windows" : IS_MAC ? "universal-darwin" : "x86_64-linux";

async function prepareLatexWindows(latexDir) {
  log("resolving latest TinyTeX release…");
  const release = await fetchJson(TINYTEX_RELEASES_API);
  // the plain cross-platform zip (e.g. "TinyTeX-v2026.07.zip") bundles
  // bin/windows/ pre-built — unlike the "*-windows-*.exe" asset, which is a
  // self-extracting installer meant to be run interactively, not extracted.
  const asset = (release.assets || []).find((a) => /^TinyTeX-v[\d.]+\.zip$/.test(a.name));
  if (!asset) {
    throw new Error(
      `Could not find a plain TinyTeX zip asset in release ${release.tag_name}. ` +
      `Available assets: ${(release.assets || []).map((a) => a.name).join(", ")}`
    );
  }
  const zip = await ensureDownloaded(asset.browser_download_url, asset.name);
  const extractDir = path.join(RUNTIME_DIR, "_latex-extract");
  extractZip(zip, extractDir);
  const found = findFileRecursive(extractDir, "latex.exe");
  if (!found) throw new Error("Could not locate latex.exe inside the extracted TinyTeX archive.");
  return installLatexFromExtracted(found, extractDir, latexDir);
}

async function prepareLatexUnix(latexDir) {
  log("resolving latest TinyTeX release…");
  const release = await fetchJson(TINYTEX_RELEASES_API);
  const namePattern = IS_MAC
    ? /^TinyTeX-1-darwin-v[\d.]+\.tar\.xz$/
    : /^TinyTeX-1-linux-x86_64-v[\d.]+\.tar\.xz$/;
  const asset = (release.assets || []).find((a) => namePattern.test(a.name));
  if (!asset) {
    throw new Error(
      `Could not find a TinyTeX archive for this platform in release ${release.tag_name}. ` +
      `Available assets: ${(release.assets || []).map((a) => a.name).join(", ")}`
    );
  }
  const tarball = await ensureDownloaded(asset.browser_download_url, asset.name);
  const extractDir = path.join(RUNTIME_DIR, "_latex-extract");
  extractTar(tarball, extractDir);
  const found = findFileRecursive(extractDir, "latex");
  if (!found) throw new Error("Could not locate the `latex` binary inside the extracted TinyTeX archive.");
  return installLatexFromExtracted(found, extractDir, latexDir);
}

/** Copies the extracted TinyTeX distro straight to runtime/latex, keeping
 *  its native bin/<platform-triplet>/ layout intact (see LATEX_BIN_SUBDIR
 *  above for why), then provisions packages via tlmgr. */
function installLatexFromExtracted(found, extractDir, latexDir) {
  const distroRoot = path.resolve(found, "..", "..");
  fs.rmSync(latexDir, { recursive: true, force: true });
  fs.cpSync(distroRoot, latexDir, { recursive: true });
  fs.rmSync(extractDir, { recursive: true, force: true });

  const binDir = path.join(latexDir, "bin", LATEX_BIN_SUBDIR);
  if (!IS_WINDOWS) {
    // archives don't always preserve the executable bit through extraction.
    for (const f of fs.readdirSync(binDir)) {
      try {
        fs.chmodSync(path.join(binDir, f), 0o755);
      } catch { /* not a regular file (e.g. a broken symlink target) */ }
    }
  }

  const tlmgr = path.join(binDir, IS_WINDOWS ? "tlmgr.bat" : "tlmgr");
  if (fs.existsSync(tlmgr)) {
    // TinyTeX's bundled tlmgr is often older than the live CTAN mirror it
    // talks to, and tlmgr flatly refuses to install/update packages until
    // it has self-updated first ("tlmgr itself needs to be updated").
    log("self-updating tlmgr…");
    try {
      execFileSync(tlmgr, ["update", "--self"], { stdio: "inherit", shell: IS_WINDOWS });
    } catch (err) {
      log(`tlmgr self-update reported an error (continuing): ${err.message}`);
    }

    log("installing LaTeX packages via tlmgr…");
    try {
      // .bat files aren't real executables — Windows needs a shell (cmd.exe)
      // to interpret them; execFileSync throws EINVAL without shell:true here.
      execFileSync(tlmgr, ["install", ...LATEX_PACKAGES], { stdio: "inherit", shell: IS_WINDOWS });
    } catch (err) {
      log(`tlmgr reported an error (continuing — some packages may already be present): ${err.message}`);
    }
  }
}

async function prepareLatex() {
  const latexDir = path.join(RUNTIME_DIR, "latex");
  const latexBinName = IS_WINDOWS ? "latex.exe" : "latex";
  if (fs.existsSync(path.join(latexDir, "bin", LATEX_BIN_SUBDIR, latexBinName))) {
    log("latex already prepared");
    return;
  }
  if (IS_WINDOWS) {
    await prepareLatexWindows(latexDir);
  } else {
    await prepareLatexUnix(latexDir);
  }
}

async function prepareFfmpegWindows(ffmpegDir) {
  const zip = await ensureDownloaded(FFMPEG_WIN_URL, "ffmpeg-release-essentials.zip");
  const extractDir = path.join(RUNTIME_DIR, "_ffmpeg-extract");
  extractZip(zip, extractDir);
  const found = findFileRecursive(extractDir, "ffmpeg.exe");
  if (!found) throw new Error("Could not locate ffmpeg.exe inside the extracted archive.");
  fs.mkdirSync(ffmpegDir, { recursive: true });
  for (const name of ["ffmpeg.exe", "ffprobe.exe"]) {
    const src = path.join(found, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ffmpegDir, name));
  }
  fs.rmSync(extractDir, { recursive: true, force: true });
}

async function prepareFfmpegMac(ffmpegDir) {
  fs.mkdirSync(ffmpegDir, { recursive: true });
  for (const [url, filename, binName] of [
    [FFMPEG_MAC_URL, "ffmpeg-mac.zip", "ffmpeg"],
    [FFMPEG_MAC_PROBE_URL, "ffprobe-mac.zip", "ffprobe"],
  ]) {
    const zip = await ensureDownloaded(url, filename);
    const extractDir = path.join(RUNTIME_DIR, `_ffmpeg-extract-${binName}`);
    extractZip(zip, extractDir);
    const found = findFileRecursive(extractDir, binName);
    if (!found) throw new Error(`Could not locate ${binName} inside the extracted evermeet.cx archive.`);
    fs.copyFileSync(path.join(found, binName), path.join(ffmpegDir, binName));
    fs.chmodSync(path.join(ffmpegDir, binName), 0o755);
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

async function prepareFfmpegLinux(ffmpegDir) {
  const tarball = await ensureDownloaded(FFMPEG_LINUX_URL, "ffmpeg-release-amd64-static.tar.xz");
  const extractDir = path.join(RUNTIME_DIR, "_ffmpeg-extract");
  extractTar(tarball, extractDir);
  const found = findFileRecursive(extractDir, "ffmpeg");
  if (!found) throw new Error("Could not locate ffmpeg inside the extracted static build.");
  fs.mkdirSync(ffmpegDir, { recursive: true });
  for (const name of ["ffmpeg", "ffprobe"]) {
    const src = path.join(found, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(ffmpegDir, name));
      fs.chmodSync(path.join(ffmpegDir, name), 0o755);
    }
  }
  fs.rmSync(extractDir, { recursive: true, force: true });
}

async function prepareFfmpeg() {
  const ffmpegDir = path.join(RUNTIME_DIR, "ffmpeg");
  const ffmpegBinName = IS_WINDOWS ? "ffmpeg.exe" : "ffmpeg";
  if (fs.existsSync(path.join(ffmpegDir, ffmpegBinName))) {
    log("ffmpeg already prepared");
    return;
  }
  if (IS_WINDOWS) await prepareFfmpegWindows(ffmpegDir);
  else if (IS_MAC) await prepareFfmpegMac(ffmpegDir);
  else await prepareFfmpegLinux(ffmpegDir);
}

async function main() {
  log(`building runtime for platform: ${PLATFORM} (${process.arch})`);
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOAD_CACHE, { recursive: true });
  await preparePython();
  await prepareLatex();
  await prepareFfmpeg();
  log("done — resources/runtime is ready to bundle into the installer.");
}

main().catch((err) => {
  console.error("[prepare-runtime] FAILED:", err);
  process.exit(1);
});
